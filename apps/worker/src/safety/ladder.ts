/**
 * Check-ins' ladder (round six, step 11; core, Real Estate first): what happens when a person checked in somewhere
 * alone doesn't check out. Chris decided it (2026-10-03): ask the person first, then tell their contacts, a teammate
 * in the app and someone outside by text and email, from the business's number and never through the Inbox.
 *
 * - **One job per check-in** (`safety.ladder`), queued at the planned end and run again at each step. It reads the
 *   check-in each time and does what its state says, so an extension, a check-out or a Help simply changes what it
 *   finds: nothing here trusts a time it was given.
 * - **The steps**: at the planned end (plus the business's "ask after"), a push to the person, "Still at 12 Oak
 *   St?", with I’m OK and +15 min; no answer in the business's "tell after" minutes, each contact is told; then
 *   again every ten minutes, a teammate by push each time, someone outside by text and email twice at most, until
 *   someone says the person is OK or an hour has passed. Help skips straight to telling.
 * - **Nobody to tell** (no contacts, or none who agreed): the business's safety person, else its owners and admins.
 * - **What's said** is the place, the planned end and how to reach the person, never more. Events and audit lines
 *   carry ids only (`safety.escalate`); the words are core's (`@hfos/core` safety.ts), the same the phone shows.
 * - **An outside contact** gets nothing until they've agreed by text (Reply OK, never YES: that's a carrier
 *   keyword; `safety_contact.record`), and
 *   nothing ever after STOP. Each text and email carries its own link to a page showing just this check-in
 *   (`/s/<token>`, http/safety.ts); only the token's hash is kept.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  defaultNumber,
  executeCommandIn,
  formatPhone,
  fmtTime,
  plainSmsText,
  safetyAlertPushWords,
  safetyAlertText,
  safetyAgreedText,
  safetyAskWords,
  safetyConsentText,
  SAFETY_AGREE_WORDS,
  safetyEscalate,
  safetyContactRecord,
  safetyOkText,
  SAFETY_DEFAULTS,
  scheduleJob,
  walletRoom,
  type SafetyTimes,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { safetyAlertEmail, safetyOkEmail } from '../emails/templates';
import type { EventHandler, HandlerContext } from '../handlers/types';
import type { JobHandler, JobResult } from '../jobs';
import { queuePush } from '../push/queue';
import { loadAccount, webhookUrls } from '../telephony/accounts';
import { isPermanentProviderError } from '../telephony/provider';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';

export const SAFETY_JOBS = {
  /** One per check-in: the next step of its ladder. */
  ladder: 'safety.ladder',
  /** One text or email to someone outside: made, its link recorded, then sent. */
  tell: 'safety.tell',
} as const;

const MINUTE = 60_000;
/** Teammates are pushed this many times at most (an hour, at ten minutes apart). */
const PUSH_ROUNDS = 6;
/** Someone outside gets a text and an email on these rounds only: twice, twenty minutes apart. */
const OUTSIDE_ROUNDS = new Set([1, 3]);

const ladderKey = (checkInId: string) => `safety:${checkInId}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type CheckIn = {
  id: string;
  user_id: string;
  place: string;
  latitude: string | null;
  longitude: string | null;
  planned_end_at: Date | string;
  state: 'in' | 'asked' | 'alerted' | 'ok' | 'out' | 'help';
  asked_at: Date | string | null;
  alerted_at: Date | string | null;
  /** How many times the contacts have been told, and when last. */
  alert_round: number;
  last_alerted_at: Date | string | null;
};

type Contact = {
  id: string;
  contact_user_id: string | null;
  name: string;
  phone_e164: string | null;
  email: string | null;
  agreed_at: Date | string | null;
  stopped_at: Date | string | null;
  works: boolean;
};

type Person = { name: string; first: string; phone: string | null; timeZone: string };

const ms = (v: Date | string | null) => (v ? new Date(v).getTime() : null);

async function loadCheckIn(tx: Tx, scope: TenantScope, id: string): Promise<CheckIn | null> {
  const [c] = await rows<CheckIn>(
    tx,
    sql`select id, user_id, place, latitude::text, longitude::text, planned_end_at, state, asked_at, alerted_at,
          alert_round, last_alerted_at
        from app.safety_checkins where id = ${id}::uuid and workspace_id = ${scope.workspaceId}::uuid`,
  );
  return c ?? null;
}

/** The business's times (Settings → Safety), else core's defaults; and its safety person, when it named one. */
async function timesOf(
  tx: Tx,
  scope: TenantScope,
): Promise<SafetyTimes & { safetyUserId: string | null }> {
  const [w] = await rows<{ safety: Record<string, unknown> | null }>(
    tx,
    sql`select settings -> 'safety' as safety from app.workspaces where id = ${scope.workspaceId}::uuid`,
  );
  const s = w?.safety ?? {};
  const minutes = (k: keyof SafetyTimes, max: number) => {
    const n = Number(s[k]);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : SAFETY_DEFAULTS[k];
  };
  return {
    askAfterMinutes: minutes('askAfterMinutes', 60),
    alertAfterMinutes: Math.max(1, minutes('alertAfterMinutes', 60)),
    repeatMinutes: Math.max(5, minutes('repeatMinutes', 60)),
    safetyUserId: typeof s['safetyUserId'] === 'string' ? s['safetyUserId'] : null,
  };
}

async function personOf(tx: Tx, scope: TenantScope, userId: string): Promise<Person> {
  const [p] = await rows<{ name: string; phone: string | null; time_zone: string }>(
    tx,
    sql`select coalesce(nullif(trim(u.full_name), ''), u.email::text) as name,
          (select ph.e164 from app.user_phones ph where ph.user_id = u.id and ph.verified_at is not null
           order by ph.created_at limit 1) as phone,
          (select w.timezone from app.workspaces w where w.id = ${scope.workspaceId}::uuid) as time_zone
        from app.users u where u.id = ${userId}::uuid`,
  );
  const name = p?.name ?? 'Your teammate';
  return {
    name,
    first: name.split(/\s+/)[0] ?? name,
    phone: p?.phone ?? null,
    timeZone: p?.time_zone ?? 'UTC',
  };
}

async function contactsOf(tx: Tx, scope: TenantScope, userId: string): Promise<Contact[]> {
  return rows<Contact>(
    tx,
    sql`select k.id, k.contact_user_id, k.name, k.phone_e164, k.email, k.agreed_at, k.stopped_at,
          (k.contact_user_id is null or private.works_in(k.contact_user_id, k.workspace_id)) as works
        from app.safety_contacts k
        where k.workspace_id = ${scope.workspaceId}::uuid and k.user_id = ${userId}::uuid
        order by k.position, k.created_at`,
  );
}

/** Who's told in the app: the person's teammate contacts; with nobody reachable at all, the safety person or managers. */
async function teammatesToTell(
  tx: Tx,
  scope: TenantScope,
  c: CheckIn,
  contacts: readonly Contact[],
  safetyUserId: string | null,
): Promise<{ userId: string; contactId: string | null }[]> {
  const mates = contacts
    .filter((k) => k.contact_user_id && k.works)
    .map((k) => ({ userId: k.contact_user_id!, contactId: k.id }));
  const outside = contacts.some((k) => !k.contact_user_id && k.agreed_at && !k.stopped_at);
  if (mates.length || outside) return mates;
  if (safetyUserId && safetyUserId !== c.user_id) {
    const [w] = await rows<{ works: boolean }>(
      tx,
      sql`select private.works_in(${safetyUserId}::uuid, ${scope.workspaceId}::uuid) as works`,
    );
    if (w?.works) return [{ userId: safetyUserId, contactId: null }];
  }
  const managers = await rows<{ user_id: string }>(
    tx,
    sql`select wm.user_id from app.workspace_memberships wm
        where wm.workspace_id = ${scope.workspaceId}::uuid and wm.role in ('owner', 'admin')
          and wm.user_id <> ${c.user_id}::uuid
        order by wm.created_at`,
  );
  return managers.map((m) => ({ userId: m.user_id, contactId: null }));
}

const placeLink = (c: CheckIn) =>
  c.latitude && c.longitude
    ? `https://maps.google.com/?q=${encodeURIComponent(`${c.latitude},${c.longitude}`)}`
    : null;

/** Queues the ladder's next run (an earlier one already queued stays: the job reads the check-in when it runs). */
export async function armLadder(tx: Tx, scope: TenantScope, checkInId: string, at: Date) {
  await scheduleJob(
    tx,
    {
      kind: SAFETY_JOBS.ladder,
      dedupeKey: ladderKey(checkInId),
      runAt: at,
      payload: { checkInId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

const checkInIdOf = (ctx: HandlerContext): string | null => {
  const id = (ctx.event.payload as { checkInId?: unknown }).checkInId;
  return typeof id === 'string' ? id : null;
};

/** Checked in, or more time: the ladder waits for the planned end (plus the business's "ask after"). */
export const onCheckedIn: EventHandler = async (ctx) => {
  const id = checkInIdOf(ctx);
  if (!id) return;
  const scope = tenantOf(ctx.scope);
  const c = await loadCheckIn(ctx.tx, scope, id);
  if (!c || !['in', 'asked'].includes(c.state)) return;
  const t = await timesOf(ctx.tx, scope);
  await armLadder(
    ctx.tx,
    scope,
    id,
    new Date(new Date(c.planned_end_at).getTime() + t.askAfterMinutes * MINUTE),
  );
};

/** Help: the contacts are told now. */
export const onHelp: EventHandler = async (ctx) => {
  const id = checkInIdOf(ctx);
  if (!id) return;
  await armLadder(ctx.tx, tenantOf(ctx.scope), id, new Date());
};

/**
 * The person checked out or added time after their contacts were told, or a teammate said they reached them:
 * everyone who was told hears they're OK, in the way they were told.
 */
export const onAllClear: EventHandler = async (ctx) => {
  const p = ctx.event.payload as { checkInId?: unknown; wasAlerted?: unknown; via?: unknown };
  const id = typeof p.checkInId === 'string' ? p.checkInId : null;
  if (!id) return;
  if (ctx.event.eventType !== 'safety.resolved' && p.wasAlerted !== true) {
    // Only more time: the ladder moves with the new end.
    if (ctx.event.eventType === 'safety.extended') await onCheckedIn(ctx);
    return;
  }
  const scope = tenantOf(ctx.scope);
  const c = await loadCheckIn(ctx.tx, scope, id);
  if (!c) return;
  const person = await personOf(ctx.tx, scope, c.user_id);
  const told = await rows<{ user_id: string | null; contact_id: string | null; channel: string }>(
    ctx.tx,
    sql`select distinct e.told_user_id as user_id, e.contact_id, e.channel
        from app.safety_escalations e where e.checkin_id = ${id}::uuid`,
  );
  const words = safetyOkText({ person: person.name });
  const userIds = told.filter((t) => t.channel === 'app' && t.user_id).map((t) => t.user_id!);
  if (userIds.length)
    await queuePush(ctx.tx, scope, {
      key: `safety:${id}:ok`,
      category: 'safety_alert',
      userIds,
      exceptUserId: (ctx.event.payload as { resolvedBy?: string }).resolvedBy ?? null,
      title: `${person.first} is OK`,
      about: 'Safety',
      body: words,
      path: `/app/w/${scope.workspaceId}/safety/${id}`,
      refs: { checkInId: id },
      collapseId: `safety-${id}`,
    });
  for (const t of told.filter((x) => x.channel !== 'app' && x.contact_id))
    await scheduleJob(ctx.tx, {
      kind: SAFETY_JOBS.tell,
      dedupeKey: `safety-ok:${id}:${t.contact_id}:${t.channel}`,
      runAt: new Date(),
      payload: { checkInId: id, contactId: t.contact_id, channel: t.channel, what: 'ok' },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    });
  // If the ladder had more to do, there's nothing left for it.
  await armLadder(ctx.tx, scope, id, new Date());
};

/** Someone outside was added: they're asked by text to agree, once, before anything else is sent them. */
export const onContactSaved: EventHandler = async (ctx) => {
  const p = ctx.event.payload as { contactId?: unknown; needsAsking?: unknown };
  if (typeof p.contactId !== 'string' || p.needsAsking !== true) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(ctx.tx, {
    kind: SAFETY_JOBS.tell,
    dedupeKey: `safety-ask:${p.contactId}`,
    runAt: new Date(),
    payload: { contactId: p.contactId, channel: 'text', what: 'consent' },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

/** `safety.ladder`: the check-in's next step, from where it stands now. */
export const ladderJob: JobHandler = async (ctx): Promise<JobResult> => {
  const scope = tenantOf(ctx.scope);
  const id = (ctx.job.payload as { checkInId?: unknown }).checkInId;
  if (typeof id !== 'string') return;
  const emails: Mail[] = [];
  const result = await asWorker(ctx.db, scope, async (tx): Promise<JobResult> => {
    const c = await loadCheckIn(tx, scope, id);
    if (!c || c.state === 'ok' || c.state === 'out') return;
    const t = await timesOf(tx, scope);
    const now = ctx.now;
    const run = (step: 'ask' | 'alert' | 'repeat', told: Told[] = []) =>
      executeCommandIn(
        tx,
        safetyEscalate,
        { workspaceId: scope.workspaceId, checkInId: id, step, told },
        systemActor(scope),
        workerMeta(),
      );
    if (c.state === 'in') {
      const askAt = new Date(c.planned_end_at).getTime() + t.askAfterMinutes * MINUTE;
      if (now < askAt) return { rescheduleAt: new Date(askAt) };
      await run('ask');
      await askPerson(tx, scope, c, t);
      return { rescheduleAt: new Date(now + t.alertAfterMinutes * MINUTE) };
    }
    if (c.state === 'asked') {
      const alertAt = (ms(c.asked_at) ?? now) + t.alertAfterMinutes * MINUTE;
      if (now < alertAt) return { rescheduleAt: new Date(alertAt) };
    }
    // Told already: again every few minutes, for an hour, while nobody has said they're OK.
    const round = c.alert_round + 1;
    if (c.alert_round > 0) {
      const next = (ms(c.last_alerted_at) ?? now) + t.repeatMinutes * MINUTE;
      if (now < next) return { rescheduleAt: new Date(next) };
      if (round > PUSH_ROUNDS) return;
    }
    emails.push(...(await tellContacts(tx, scope, c, t, round, run, ctx.webUrl)));
    return round < PUSH_ROUNDS
      ? { rescheduleAt: new Date(now + t.repeatMinutes * MINUTE) }
      : undefined;
  });
  // Teammates told the first time hear by email too, once what was told is kept.
  for (const m of emails) await ctx.mailer.send(m);
  return result;
};

type Mail = { to: string; subject: string; text: string; html: string };

type Told = { contactId: string | null; userId: string | null; channel: 'app' };

/** "Still at 12 Oak St?", with I’m OK and +15 min. */
async function askPerson(
  tx: Tx,
  scope: TenantScope,
  c: CheckIn,
  t: SafetyTimes & { safetyUserId: string | null },
) {
  const person = await personOf(tx, scope, c.user_id);
  const contacts = await contactsOf(tx, scope, c.user_id);
  const told = contacts
    .filter((k) => (k.contact_user_id ? k.works : k.agreed_at && !k.stopped_at))
    .map((k) => k.name.split(/\s+/)[0] ?? k.name);
  const words = safetyAskWords({
    place: c.place,
    plannedEnd: fmtTime(new Date(c.planned_end_at).getTime(), person.timeZone),
    alertAfterMinutes: t.alertAfterMinutes,
    contacts: told,
  });
  await queuePush(tx, scope, {
    key: `safety:${c.id}:ask:${new Date(c.planned_end_at).getTime()}`,
    category: 'safety_check',
    userIds: [c.user_id],
    title: words.title,
    about: 'Safety',
    body: words.body,
    path: `/app/w/${scope.workspaceId}/safety`,
    refs: { checkInId: c.id },
    collapseId: `safety-${c.id}`,
  });
}

/** One round of telling: teammates in the app (recorded here), people outside by text and email (their own jobs). */
async function tellContacts(
  tx: Tx,
  scope: TenantScope,
  c: CheckIn,
  t: SafetyTimes & { safetyUserId: string | null },
  round: number,
  run: (step: 'alert' | 'repeat', told: Told[]) => Promise<unknown>,
  webUrl: string,
): Promise<Mail[]> {
  const person = await personOf(tx, scope, c.user_id);
  const contacts = await contactsOf(tx, scope, c.user_id);
  const mates = await teammatesToTell(tx, scope, c, contacts, t.safetyUserId);
  await run(
    round === 1 ? 'alert' : 'repeat',
    mates.map((m) => ({ contactId: m.contactId, userId: m.userId, channel: 'app' as const })),
  );
  const words = safetyAlertPushWords({
    person: person.name,
    place: c.place,
    plannedEnd: fmtTime(new Date(c.planned_end_at).getTime(), person.timeZone),
    phone: person.phone ? formatPhone(person.phone) : null,
    help: c.state === 'help',
  });
  if (mates.length)
    await queuePush(tx, scope, {
      key: `safety:${c.id}:alert:${round}`,
      category: 'safety_alert',
      userIds: mates.map((m) => m.userId),
      title: words.title,
      about: 'Safety',
      body: words.body,
      path: `/app/w/${scope.workspaceId}/safety/${c.id}`,
      refs: { checkInId: c.id },
      collapseId: `safety-${c.id}`,
    });
  const mails: Mail[] = [];
  if (round === 1 && mates.length) {
    const [biz] = await rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${scope.workspaceId}::uuid`,
    );
    const to = await rows<{ email: string }>(
      tx,
      sql`select email::text as email from app.users
          where id in (${sql.join(
            mates.map((m) => sql`${m.userId}::uuid`),
            sql`, `,
          )}) and deleted_at is null`,
    );
    const mail = safetyAlertEmail({
      person: person.name,
      business: biz?.name ?? '',
      place: c.place,
      plannedEnd: fmtTime(new Date(c.planned_end_at).getTime(), person.timeZone),
      phone: person.phone ? formatPhone(person.phone) : null,
      help: c.state === 'help',
      link: `${webUrl}/app/w/${scope.workspaceId}/safety/${c.id}`,
      map: placeLink(c),
      teammate: true,
    });
    for (const u of to) mails.push({ to: u.email, ...mail });
  }
  if (!OUTSIDE_ROUNDS.has(round)) return mails;
  for (const k of contacts) {
    if (k.contact_user_id || !k.agreed_at || k.stopped_at) continue;
    for (const channel of ['text', 'email'] as const) {
      if (channel === 'text' ? !k.phone_e164 : !k.email) continue;
      await scheduleJob(tx, {
        kind: SAFETY_JOBS.tell,
        dedupeKey: `safety-tell:${c.id}:${k.id}:${channel}:${round}`,
        runAt: new Date(),
        payload: { checkInId: c.id, contactId: k.id, channel, what: 'alert', round },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      });
    }
  }
  return mails;
}

/**
 * `safety.tell`: one text or email to someone outside. An alert gets its own link, whose hash is recorded before it
 * goes, so the link works the moment it arrives; a consent text records that they were asked.
 */
export const tellJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload as {
    checkInId?: string;
    contactId?: string;
    channel?: 'text' | 'email';
    what?: 'consent' | 'alert' | 'ok';
    round?: number;
  };
  if (!p.contactId || !p.channel || !p.what) return;
  const prepared = await asWorker(ctx.db, scope, async (tx) => {
    const [k] = await rows<Contact & { user_id: string }>(
      tx,
      sql`select id, user_id, contact_user_id, name, phone_e164, email, agreed_at, stopped_at, true as works
          from app.safety_contacts where id = ${p.contactId}::uuid and workspace_id = ${scope.workspaceId}::uuid`,
    );
    // Removed, a teammate, or said STOP: nothing.
    if (!k || k.contact_user_id || k.stopped_at) return null;
    if (p.what !== 'consent' && !k.agreed_at) return null;
    const person = await personOf(tx, scope, k.user_id);
    const [biz] = await rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${scope.workspaceId}::uuid`,
    );
    const business = biz?.name ?? 'the business';
    if (p.what === 'consent') {
      await executeCommandIn(
        tx,
        safetyContactRecord,
        { workspaceId: scope.workspaceId, contactId: k.id, what: 'asked' },
        systemActor(scope),
        workerMeta(),
      );
      return {
        k,
        text: safetyConsentText({ person: person.name, business }),
        email: null,
      };
    }
    const c = p.checkInId ? await loadCheckIn(tx, scope, p.checkInId) : null;
    if (!c) return null;
    if (p.what === 'ok')
      return {
        k,
        text: safetyOkText({ person: person.name }),
        email: safetyOkEmail({ person: person.name, business }),
      };
    // The alert stopped mattering since it was queued.
    if (!['alerted', 'help'].includes(c.state)) return null;
    const token = randomBytes(18).toString('base64url');
    await executeCommandIn(
      tx,
      safetyEscalate,
      {
        workspaceId: scope.workspaceId,
        checkInId: c.id,
        step: 'link',
        told: [],
        link: {
          contactId: k.id,
          channel: p.channel,
          tokenHash: sha256(token),
          round: p.round ?? 1,
        },
      },
      systemActor(scope),
      workerMeta(),
    );
    const link = `${ctx.webUrl}/s/${token}`;
    const facts = {
      person: person.name,
      place: c.place,
      plannedEnd: fmtTime(new Date(c.planned_end_at).getTime(), person.timeZone),
      phone: person.phone ? formatPhone(person.phone) : null,
      help: c.state === 'help',
      link,
      map: placeLink(c),
    };
    return {
      k,
      text: safetyAlertText(facts),
      email: safetyAlertEmail({ ...facts, business }),
    };
  });
  if (!prepared) return;
  if (p.channel === 'email') {
    if (prepared.k.email && prepared.email)
      await ctx.mailer.send({ to: prepared.k.email, ...prepared.email });
    return;
  }
  if (!prepared.k.phone_e164) return;
  await sendSafetyText(ctx, scope, prepared.k.phone_e164, prepared.text);
};

/**
 * A safety text from the business's number, outside the Inbox: no conversation, no customer, nothing an owner
 * reads. It goes only when the business has a working number and money for texts; the email still goes when not.
 */
export async function sendSafetyText(
  ctx: Pick<WorkerServices, 'db' | 'sealer' | 'log' | 'telephony' | 'publicUrl'>,
  scope: TenantScope,
  to: string,
  words: string,
): Promise<boolean> {
  const ready = await asWorker(ctx.db, scope, async (tx) => {
    const number = await defaultNumber(tx, scope.workspaceId);
    const account = await loadAccount(tx, scope.workspaceId, ctx.sealer);
    const room = await walletRoom(tx, scope.workspaceId, 'text', (msg, e) =>
      ctx.log.error({ err: e }, msg),
    );
    return number?.status === 'active' && account && room.allowed ? { number, account } : null;
  });
  if (!ready) return false;
  try {
    await ctx.telephony.sendMessage(ready.account, {
      from: ready.number.e164,
      messagingServiceSid: ready.account.messagingServiceSid,
      to,
      body: plainSmsText(words),
      mediaUrls: [],
      statusCallbackUrl: webhookUrls(ctx.publicUrl).smsStatusUrl,
    });
    return true;
  } catch (e) {
    if (!isPermanentProviderError(e)) throw e;
    ctx.log.warn({ err: e.message }, 'a safety text could not be sent');
    return false;
  }
}

export { sha256 as safetyTokenHash };

/**
 * A text to one of the business's numbers that answers a safety ask (round six): OK from someone asked to be a
 * contact agrees, and stays out of the Inbox; STOP marks them stopped (the carrier already stopped the texts) and
 * still reaches message.receive, which keeps the business's opt-out records. True when it was a safety answer.
 */
export async function safetyReply(
  ctx: Pick<WorkerServices, 'db' | 'sealer' | 'log' | 'telephony' | 'publicUrl'>,
  scope: TenantScope,
  from: string,
  body: string,
  stopped: boolean,
): Promise<boolean> {
  const word = body
    .trim()
    .toUpperCase()
    .replace(/[^A-Z ]/g, '')
    .replace(/\s+/g, ' ');
  const agrees = SAFETY_AGREE_WORDS.has(word);
  if (!agrees && !stopped) return false;
  const answered = await asWorker(ctx.db, scope, async (tx) => {
    const waiting = await rows<{ id: string }>(
      tx,
      sql`select id from app.safety_contacts
          where workspace_id = ${scope.workspaceId}::uuid and phone_e164 = ${from} and contact_user_id is null
            and stopped_at is null and (${stopped} or (asked_at is not null and agreed_at is null))`,
    );
    if (!waiting.length) return null;
    const { output } = await executeCommandIn(
      tx,
      safetyContactRecord,
      { workspaceId: scope.workspaceId, phone: from, what: stopped ? 'stopped' : 'agreed' },
      systemActor(scope),
      workerMeta(),
    );
    return output.people;
  });
  if (!answered) return false;
  if (stopped) return false;
  await sendSafetyText(ctx, scope, from, safetyAgreedText({ people: answered }));
  return true;
}
