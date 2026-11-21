/**
 * Networking calls (docs/outreach.md, decision 187; core's rules in packages/core/src/addons/outreach/calls.ts).
 *
 * - A booking (`appointment.booked`) through the person's networking call link (its `ref`) is a networking call with
 *   whoever the ref names. One on their Networking calendar (or, with none picked, their own calendar) under the name
 *   of exactly one person they chat with is too. Each is kept once (`outreach.call.note`).
 * - Half an hour before it (`outreach.call_prep`), the AI writes a prep note: what they do and where, what the chat was
 *   about, who the person could refer them to from the people they chat with, and a question to ask. It's pushed to
 *   the person's phone and kept (`outreach.call.prepped`). With no AI, the note says what's known of them. A call
 *   moved (`appointment.rescheduled`) gets its push at the new time; a cancelled one gets none.
 * - Monday's morning push (./alerts.ts) also tells each person last week's 1-on-1s, once they've had any lately.
 *
 * The thank-you after a call is on Today (core's ops/today.ts), drafted and sent as the day's other messages are, and
 * always waits for the person's OK.
 */
import {
  CALL_PEOPLE_MOST,
  CALL_PREP_MINUTES,
  CALL_PREP_SCHEMA,
  CALL_PREP_SYSTEM,
  CALL_WORDS,
  CallPrepAnswer,
  callPrepNote,
  callPrepPlain,
  callPrepPrompt,
  mondayCallWords,
  type CallHow,
  type CallPerson,
} from '@hfos/core/addons/outreach/calls';
import { CALL_REF_PREFIX, readCallRef } from '@hfos/core/addons/outreach/demos';
import { theirWorkFact } from '@hfos/core/addons/outreach/local';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { callNote, callPrepped, oneOnOnesOf } from '@hfos/core/addons/outreach/ops/calls';
import { REFER_REPLIES } from '@hfos/core/addons/outreach/referrals';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';
import { candidateOf, type CandidateRow } from './referrals';

export const CALL_PREP_JOB = 'outreach.call_prep';
const TODAY_HREF = '/a/outreach?view=today';
const MINUTE = 60_000;
const PREP_BEFORE = CALL_PREP_MINUTES * MINUTE;

const todayHref = (platform: Platform) =>
  platform === 'facebook' ? TODAY_HREF : `${TODAY_HREF}&net=${platform}`;

/** Queues a call's prep push half an hour before it, or moves it sooner; nothing for a call that's begun. */
async function armPrep(
  tx: Tx,
  ctx: AddonScopeContext,
  callId: string,
  startsAt: Date,
  now = Date.now(),
): Promise<void> {
  if (startsAt.getTime() <= now) return;
  await scheduleAddonJob(
    tx,
    { id: ctx.manifest.id, generation: ctx.generation },
    {
      kind: CALL_PREP_JOB,
      dedupeKey: `${CALL_PREP_JOB}:${callId}`,
      runAt: new Date(Math.max(now, startsAt.getTime() - PREP_BEFORE)),
      payload: { callId },
      workspaceId: ctx.scope.workspaceId,
      organizationId: ctx.scope.organizationId,
    },
    { pullEarlier: true },
  );
}

type Booked = {
  attendee_id: string;
  person_id: string | null;
  link_ref: string | null;
  name: string;
};

/**
 * `appointment.booked`: a networking call with someone the person chats with is kept, and its prep push queued. A demo
 * or partner link's booking is ./demos.ts's.
 */
export async function callBooked(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { attendeeId?: string | null };
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  const ws = ctx.scope.workspaceId;
  const booked = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<Booked>(
      tx,
      sql`select aa.id as attendee_id, aa.person_id, aa.link_ref,
            btrim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) as name
          from app.appointment_attendees aa
          left join app.people pe on pe.id = aa.person_id
          where aa.workspace_id = ${ws} and aa.appointment_id = ${appointmentId} and aa.status = 'booked'
            and (${p.attendeeId ?? null}::uuid is null or aa.id = ${p.attendeeId ?? null}::uuid)`,
    ),
  );
  for (const a of booked) {
    const named = readCallRef(a.link_ref);
    // Another link's ref (a demo's, a partner's, a campaign's) is never a networking call by name.
    const matched = named
      ? [{ userId: named.userId, profileId: named.profileId, how: 'link' as CallHow }]
      : a.link_ref && !a.link_ref.startsWith(CALL_REF_PREFIX)
        ? []
        : await byName(ctx, appointmentId, a.name);
    for (const m of matched) {
      const { output: out } = await executeCommand(
        ctx.db,
        callNote,
        {
          workspaceId: ws,
          appointmentId,
          personId: a.person_id,
          userId: m.userId,
          profileId: m.profileId,
          how: m.how,
        },
        ctx.actor,
        ctx.meta,
      );
      if (out.callId && out.startsAt) {
        const callId = out.callId;
        const startsAt = new Date(out.startsAt);
        await asWorker(ctx.db, ctx.scope, (tx) => armPrep(tx, ctx, callId, startsAt));
      }
    }
  }
}

/**
 * Who a booking with no ref is a networking call with: for each host on it whose Networking calendar it's on (or, with
 * none picked, their own calendar that isn't their Lead calendar), the one person they chat with by exactly that name.
 * Two of the same name is nobody: a wrong prep note costs more than none.
 */
async function byName(
  ctx: AddonEventContext,
  appointmentId: string,
  name: string,
): Promise<{ userId: string; profileId: string; how: CallHow }[]> {
  if (name.replace(/\s+/g, '').length < 2) return [];
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ user_id: string; profile_id: string; n: number }>(
      tx,
      sql`select s.user_id, (array_agg(distinct p.id::text))[1] as profile_id, count(distinct p.id)::int as n
          from app.appointment_staff s
          join app.appointments a on a.id = s.appointment_id
          join app.calendars c on c.id = a.calendar_id
          left join addon_outreach.automation au on au.workspace_id = a.workspace_id and au.user_id = s.user_id
          join addon_outreach.file_chats fc on fc.workspace_id = a.workspace_id and fc.user_id = s.user_id
          join addon_outreach.profiles p on p.id = fc.profile_id
            and lower(regexp_replace(btrim(p.name), '\\s+', ' ', 'g'))
              = lower(regexp_replace(btrim(${name}), '\\s+', ' ', 'g'))
          where s.workspace_id = ${ws} and s.appointment_id = ${appointmentId} and s.role = 'host' and s.active
            and a.calendar_id is distinct from au.lead_calendar_id
            and (au.networking_calendar_id = a.calendar_id
              or (au.networking_calendar_id is null and c.owner_user_id = s.user_id))
          group by s.user_id`,
    ),
  );
  return found
    .filter((f) => f.n === 1)
    .map((f) => ({ userId: f.user_id, profileId: f.profile_id, how: 'name' as CallHow }));
}

/** `appointment.rescheduled`: each networking call on it gets its prep push at the new time. */
export async function callRescheduled(ctx: AddonEventContext): Promise<void> {
  const appointmentId = ctx.event.entityId;
  if (!appointmentId) return;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const found = await rows<{ id: string; starts_at: Date | string }>(
      tx,
      sql`select k.id, a.starts_at from addon_outreach.calls k
          join app.appointments a on a.id = k.appointment_id
          where k.workspace_id = ${ctx.scope.workspaceId} and k.appointment_id = ${appointmentId}
            and a.status = 'scheduled' and a.bin_item_id is null`,
    );
    for (const k of found) await armPrep(tx, ctx, k.id, new Date(k.starts_at));
  });
}

type CallRow = CandidateRow & {
  user_id: string;
  person_id: string | null;
  platform: Platform;
  starts_at: Date | string;
  status: string;
  binned: boolean;
  gone: boolean;
  prepped_for: Date | string | null;
};

/**
 * `outreach.call_prep`: the prep note, half an hour before the call, pushed and kept. Nothing for a call cancelled,
 * missed, binned, or begun; a call moved later waits for its new time.
 */
export async function callPrepJob(ctx: AddonJobContext): Promise<JobResult> {
  const callId = (ctx.job.payload as { callId?: string } | null)?.callId;
  if (!callId) return;
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [call] = await rows<CallRow>(
      tx,
      sql`select pr.id, pr.name, pr.intro, ck.about, pr.work, pr.area, pr.reach, fc.recent, null::uuid as playbook_id,
            k.user_id, pr.person_id, pr.platform, a.starts_at, a.status::text as status,
            a.bin_item_id is not null as binned, k.prepped_for,
            exists (select 1 from app.appointment_attendees aa
              where aa.appointment_id = a.id and aa.person_id = k.person_id
                and aa.status in ('cancelled', 'no_show')) as gone
          from addon_outreach.calls k
          join addon_outreach.profiles pr on pr.id = k.profile_id
          join app.appointments a on a.id = k.appointment_id
          left join lateral (select c.about from addon_outreach.checks c
                where c.workspace_id = ${ws} and c.profile_id = pr.id and c.user_id = k.user_id
                order by c.checked_at desc nulls last limit 1) ck on true
          left join lateral (select c.recent from addon_outreach.file_chats c
                where c.workspace_id = ${ws} and c.profile_id = pr.id and c.user_id = k.user_id
                order by c.last_at desc limit 1) fc on true
          where k.workspace_id = ${ws} and k.id = ${callId}`,
    );
    if (!call) return null;
    // Who the person could refer them to: the people they chat with who wrote back at least twice, with something
    // known of what they do, the most recent talks first.
    const people = await rows<CandidateRow>(
      tx,
      sql`select pr.id, pr.name, pr.intro, ck.about, pr.work, pr.area, pr.reach, null::jsonb as recent,
            null::uuid as playbook_id
          from addon_outreach.profiles pr
          join (select profile_id, max(seen_at) as last from addon_outreach.replies
                where workspace_id = ${ws} and user_id = ${call.user_id}
                group by profile_id having count(*) >= ${REFER_REPLIES}) rp on rp.profile_id = pr.id
          left join lateral (select c.about from addon_outreach.checks c
                where c.workspace_id = ${ws} and c.profile_id = pr.id and c.user_id = ${call.user_id}
                order by c.checked_at desc nulls last limit 1) ck on true
          where pr.workspace_id = ${ws} and pr.id <> ${call.id} and pr.friendship <> 'self'
            and not pr.never_contact and (pr.work is not null or ck.about is not null)
          order by rp.last desc
          limit ${CALL_PEOPLE_MOST}`,
    );
    const [business] = await rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${ws}`,
    );
    const groups = await rows<{ name: string }>(
      tx,
      sql`select name from addon_outreach.groups where workspace_id = ${ws} and name is not null`,
    );
    return { call, people, business, groups: groups.map((g) => g.name) };
  });
  if (!found) return;
  const { call } = found;
  if (call.status !== 'scheduled' || call.binned || call.gone) return;
  const startsAt = new Date(call.starts_at);
  const due = startsAt.getTime() - PREP_BEFORE;
  // Moved later: it waits for the new time. Begun, or already pushed for this time: nothing.
  if (due > ctx.now + MINUTE) return { rescheduleAt: new Date(due) };
  if (startsAt.getTime() <= ctx.now) return;
  if (call.prepped_for && new Date(call.prepped_for).getTime() === startsAt.getTime()) return;
  const person = candidateOf(call, found.groups);
  const people: CallPerson[] = found.people.map((c) => ({
    ...candidateOf(c, found.groups),
    said: [],
  }));
  const plain = callPrepPlain(
    theirWorkFact({
      work: call.work,
      area: call.area,
      reach: call.reach,
      miles: null,
      near: false,
    }),
  );
  let note = plain;
  try {
    const { value } = await askStructured(ctx, ctx.scope, {
      system: CALL_PREP_SYSTEM,
      messages: [
        {
          role: 'user',
          content: callPrepPrompt({
            business: found.business?.name ?? 'the business',
            person,
            people,
          }),
        },
      ],
      schema: CALL_PREP_SCHEMA,
      zod: CallPrepAnswer,
      maxTokens: 500,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    note = callPrepNote(value, people) ?? plain;
  } catch (e) {
    // It can't wait: with no AI, or none now, the note says what's known of them.
    if (!(e instanceof AiAskError)) throw e;
    ctx.log.warn({ err: e.message, code: e.code }, 'call prep note written without the AI');
  }
  await executeCommand(
    ctx.db,
    callPrepped,
    { workspaceId: ws, callId, prep: note, for: startsAt.toISOString() },
    ctx.actor,
    ctx.meta,
  );
  const minutes = Math.max(1, Math.round((startsAt.getTime() - ctx.now) / MINUTE));
  await asWorker(ctx.db, ctx.scope, (tx) =>
    pushAddonNotice(ctx, tx, {
      key: `call-prep:${callId}:${startsAt.getTime()}`,
      userIds: [call.user_id],
      permission: 'outreach.use',
      title: CALL_WORDS.prepTitle(call.name, minutes),
      body: note,
      href: todayHref(call.platform),
      collapseKey: `call-prep-${callId}`,
      personId: call.person_id,
    }),
  );
}

/**
 * Monday's line on last week's 1-on-1s (the owner's 6a), with the morning push: to each person who can use Social
 * Outreach and had a networking call in the last few weeks, once a day.
 */
export async function mondayCallsPush(ctx: AddonJobContext, day: string): Promise<void> {
  const ws = ctx.scope.workspaceId;
  const now = new Date(ctx.now);
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const people = await rows<{ user_id: string }>(
      tx,
      sql`select distinct wa.user_id from app.workspace_access wa
          join app.users u on u.id = wa.user_id and u.deleted_at is null
          where wa.workspace_id = ${ws} and 'outreach.use' = any (wa.permissions)
            and (exists (select 1 from addon_outreach.calls k
                  where k.workspace_id = ${ws} and k.user_id = wa.user_id)
              or exists (select 1 from addon_outreach.automation au
                  where au.workspace_id = ${ws} and au.user_id = wa.user_id
                    and au.networking_calendar_id is not null))
          order by wa.user_id`,
    );
    for (const { user_id: userId } of people) {
      const w = await oneOnOnesOf(tx, ws, userId, now);
      if (w.lastWeek === 0 && w.earlier === 0) continue;
      await pushAddonNotice(ctx, tx, {
        key: `calls-week:${userId}:${day}`,
        userIds: [userId],
        permission: 'outreach.use',
        ...mondayCallWords(w.lastWeek, w.before),
        href: TODAY_HREF,
        collapseKey: `calls-week-${userId}`,
      });
    }
  });
}
