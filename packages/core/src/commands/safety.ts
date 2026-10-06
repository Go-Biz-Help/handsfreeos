/**
 * Check-ins (round six, 20261022000300): a person checks in somewhere alone with a planned end, and their contacts
 * are told if they don't check out (Chris, 2026-10-03: core, for everyone; Real Estate first). Checking in, adding
 * time and checking out work with no signal (they're the person's own, and a late one still counts from when it was
 * made); Help and contacts need signal. Events carry only ids, never the place: owners read the audit.
 *
 * The worker's ladder (asking, then telling each contact) hears these events (apps/worker/src/safety).
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { isUniqueViolation } from '../kernel/pg-errors';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import {
  SafetyCheckInInput,
  SafetyCheckInOutput,
  SafetyCheckInRef,
  SafetyContactOutput,
  SafetyContactRecordInput,
  SafetyContactRecordOutput,
  SafetyContactRemoveInput,
  SafetyContactRemoveOutput,
  SafetyContactSaveInput,
  SafetyEscalateInput,
  SafetyEscalateOutput,
  SafetyExtendInput,
  SafetyHelpInput,
  SafetyResolveByLinkInput,
  SafetyResolveByLinkOutput,
  SafetyResolveOutput,
  SafetySettingsInput,
  SafetySettingsOutput,
  SafetyWhereInput,
  SafetyWhereOutput,
} from '../schemas/safety';
import { contactStatus, SAFETY_LIMITS } from '../safety';

const scope = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

type CheckInRow = {
  id: string;
  appointment_id: string | null;
  place: string;
  started_at: Date | string;
  planned_end_at: Date | string;
  state: 'in' | 'asked' | 'alerted' | 'ok' | 'out' | 'help';
  extended_count: number;
};

const COLUMNS = sql`id, appointment_id, place, started_at, planned_end_at, state, extended_count`;

const shape = (r: CheckInRow) => ({
  id: r.id,
  appointmentId: r.appointment_id,
  place: r.place,
  startedAt: new Date(r.started_at).toISOString(),
  plannedEndAt: new Date(r.planned_end_at).toISOString(),
  state: r.state,
  extendedCount: r.extended_count,
});

/** One of the person's own check-ins, locked; theirs alone, so anyone else's reads as not there. */
async function ownCheckIn(ctx: CommandContext, id: string): Promise<CheckInRow> {
  const [r] = await rows<CheckInRow>(
    ctx.tx,
    sql`select ${COLUMNS} from app.safety_checkins
        where id = ${id}::uuid and workspace_id = ${ctx.scope.workspaceId!}::uuid for update`,
  );
  if (!r)
    throw HfosError.notFound(
      'That check-in isn’t on this phone’s account anymore. Check in again if you’re still there.',
    );
  return r;
}

async function emitFor(ctx: CommandContext, type: string, checkInId: string, extra = {}) {
  await ctx.emit({
    type,
    entityType: 'safety_checkin',
    entityId: checkInId,
    payload: { checkInId, ...extra },
  });
}

export const safetyCheckIn = defineCommand({
  name: 'safety.check_in',
  description:
    'Check in somewhere you’re alone, with when you plan to leave. If you don’t check out, HandsFreeOS asks you, then tells your safety contacts where you were.',
  risk: 1,
  input: SafetyCheckInInput,
  output: SafetyCheckInOutput,
  permission: 'workspace.read',
  scope,
  // An earlier check-in still open ends here, checked out.
  emits: ['safety.checked_in', 'safety.checked_out'],
  actors: ['human'],
  offline: 'anytime',
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    // Made before with this id: the same check-in (a phone's repeat).
    const [before] = await rows<CheckInRow & { user_id: string }>(
      ctx.tx,
      sql`select ${COLUMNS}, user_id from app.safety_checkins where id = ${input.id}::uuid`,
    );
    if (before) {
      if (before.user_id !== me.userId)
        throw HfosError.validation([
          { path: 'id', message: 'That id can’t be used. Make a new one.' },
        ]);
      return { checkIn: shape(before) };
    }
    const startedAt = changeMoment(ctx.meta);
    const end = new Date(input.plannedEndAt);
    // Times go to SQL as ISO strings, never Date objects.
    const startedIso = startedAt.toISOString();
    if (end.getTime() <= startedAt.getTime())
      throw HfosError.validation([
        { path: 'plannedEndAt', message: 'Pick a time after now for when you plan to leave.' },
      ]);
    if (end.getTime() - startedAt.getTime() > SAFETY_LIMITS.longestMinutes * 60_000)
      throw HfosError.validation([
        { path: 'plannedEndAt', message: 'A check-in lasts up to 12 hours. Pick an earlier time.' },
      ]);
    // One at a time: an earlier one still open ends here.
    const ended = await rows<{ id: string }>(
      ctx.tx,
      sql`update app.safety_checkins set state = 'out', checked_out_at = ${startedIso}::timestamptz
          where workspace_id = ${ws}::uuid and user_id = ${me.userId}::uuid and state in ('in', 'asked')
          returning id`,
    );
    for (const e of ended) await emitFor(ctx, 'safety.checked_out', e.id);
    const located = input.latitude !== undefined && input.longitude !== undefined;
    // Following the phone needs a first reading: the person turned Share where I am on, and allowed it.
    const follows = located && input.follow === true;
    const row = await rows<CheckInRow>(
      ctx.tx,
      sql`insert into app.safety_checkins (id, workspace_id, user_id, appointment_id, place, latitude, longitude,
            located_at, follows, started_at, planned_end_at)
          values (${input.id}::uuid, ${ws}::uuid, ${me.userId}::uuid, ${input.appointmentId ?? null}::uuid,
            ${input.place}, ${located ? input.latitude! : null}, ${located ? input.longitude! : null},
            ${located ? startedIso : null}::timestamptz, ${follows}, ${startedIso}::timestamptz,
            ${end.toISOString()}::timestamptz)
          returning ${COLUMNS}`,
    )
      .then((r) => r[0])
      .catch((e: unknown) => {
        // Someone else's id: refused the same way whoever holds it.
        if (isUniqueViolation(e, 'safety_checkins_pkey'))
          throw HfosError.validation([
            { path: 'id', message: 'That id can’t be used. Make a new one.' },
          ]);
        throw e;
      });
    await emitFor(ctx, 'safety.checked_in', input.id);
    return { checkIn: shape(row!) };
  },
});

export const safetyExtend = defineCommand({
  name: 'safety.extend',
  description:
    'Add time to your check-in. Answering “Still there?” this way also tells HandsFreeOS you’re OK.',
  risk: 1,
  input: SafetyExtendInput,
  output: SafetyCheckInOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety.extended'],
  actors: ['human'],
  offline: 'anytime',
  async handler(ctx, input) {
    requireHuman(ctx);
    const r = await ownCheckIn(ctx, input.checkInId);
    if (r.state === 'out' || r.state === 'ok') return { checkIn: shape(r) };
    const wasAlerted = r.state === 'alerted' || r.state === 'help';
    const at = changeMoment(ctx.meta).toISOString();
    const [row] = await rows<CheckInRow>(
      ctx.tx,
      sql`update app.safety_checkins
          set planned_end_at = greatest(planned_end_at, ${at}::timestamptz) + make_interval(mins => ${input.minutes}),
              extended_count = extended_count + 1, state = 'in', asked_at = null,
              resolved_at = case when ${wasAlerted} then ${at}::timestamptz else resolved_at end,
              resolved_via = case when ${wasAlerted} then 'person' else resolved_via end
          where id = ${r.id}::uuid returning ${COLUMNS}`,
    );
    await emitFor(ctx, 'safety.extended', r.id, { wasAlerted });
    return { checkIn: shape(row!) };
  },
});

/**
 * Where the phone is now, during a check-in it shares that for (round seven, Chris 2026-10-05): one spot per
 * check-in, the latest by when it was taken, never a trail. It waits on the phone with no signal (only the latest is
 * sent), so one taken after the check-in ended, or older than the spot kept, changes nothing. No event: the ladder
 * reads the spot when it tells someone, and the history keeps only that the check-in was shared.
 */
export const safetyWhere = defineCommand({
  name: 'safety.where',
  description:
    'Where your phone is now, while you’re checked in and sharing it. Only the latest spot is kept, for your contacts if they’re told.',
  risk: 0,
  input: SafetyWhereInput,
  output: SafetyWhereOutput,
  permission: 'workspace.read',
  scope,
  emits: [],
  actors: ['human'],
  offline: 'anytime',
  async handler(ctx, input) {
    requireHuman(ctx);
    const r = await ownCheckIn(ctx, input.checkInId);
    const at = changeMoment(ctx.meta).toISOString();
    const [moved] = await rows<{ id: string }>(
      ctx.tx,
      sql`update app.safety_checkins
          set latitude = ${input.latitude}, longitude = ${input.longitude}, located_at = ${at}::timestamptz
          where id = ${r.id}::uuid and follows
            and state in ('in', 'asked', 'alerted', 'help')
            and (located_at is null or located_at < ${at}::timestamptz)
          returning id`,
    );
    if (moved) return { checkInId: r.id, kept: true, open: true };
    const [f] = await rows<{ follows: boolean; state: string }>(
      ctx.tx,
      sql`select follows, state from app.safety_checkins where id = ${r.id}::uuid`,
    );
    if (!f?.follows)
      throw HfosError.rule(
        'safety_not_shared',
        409,
        'This check-in doesn’t share where you are. Check in again with Share where I am on to share it.',
      );
    return {
      checkInId: r.id,
      kept: false,
      open: ['in', 'asked', 'alerted', 'help'].includes(f.state),
    };
  },
});

export const safetyCheckOut = defineCommand({
  name: 'safety.check_out',
  description: 'Check out: you’ve left. If anyone was told, they hear you’re OK.',
  risk: 1,
  input: SafetyCheckInRef,
  output: SafetyCheckInOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety.checked_out'],
  actors: ['human'],
  offline: 'anytime',
  async handler(ctx, input) {
    requireHuman(ctx);
    const r = await ownCheckIn(ctx, input.checkInId);
    if (r.state === 'out') return { checkIn: shape(r) };
    const wasAlerted = r.state === 'alerted' || r.state === 'help';
    const [row] = await rows<CheckInRow>(
      ctx.tx,
      sql`update app.safety_checkins set state = 'out', checked_out_at = ${changeMoment(ctx.meta).toISOString()}::timestamptz
          where id = ${r.id}::uuid returning ${COLUMNS}`,
    );
    await emitFor(ctx, 'safety.checked_out', r.id, { wasAlerted });
    return { checkIn: shape(row!) };
  },
});

export const safetyHelp = defineCommand({
  name: 'safety.help',
  description:
    'Ask for help now: your safety contacts are told at once where you are. HandsFreeOS never calls 911; call them yourself if you’re in danger.',
  risk: 2,
  input: SafetyHelpInput,
  output: SafetyCheckInOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety.help'],
  actors: ['human'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const located = input.latitude !== undefined && input.longitude !== undefined;
    let row: CheckInRow | undefined;
    if (input.checkInId) {
      const r = await ownCheckIn(ctx, input.checkInId);
      [row] = await rows<CheckInRow>(
        ctx.tx,
        sql`update app.safety_checkins set state = 'help',
              latitude = coalesce(${located ? input.latitude! : null}, latitude),
              longitude = coalesce(${located ? input.longitude! : null}, longitude),
              located_at = case when ${located} then now() else located_at end
            where id = ${r.id}::uuid returning ${COLUMNS}`,
      );
    } else {
      if (!input.place)
        throw HfosError.validation([
          { path: 'place', message: 'Say where you are, so your contacts can find you.' },
        ]);
      [row] = await rows<CheckInRow>(
        ctx.tx,
        sql`insert into app.safety_checkins (id, workspace_id, user_id, place, latitude, longitude, located_at,
              started_at, planned_end_at, state)
            values (gen_random_uuid(), ${ws}::uuid, ${me.userId}::uuid, ${input.place},
              ${located ? input.latitude! : null}, ${located ? input.longitude! : null},
              case when ${located} then now() end, now(), now() + interval '1 hour', 'help')
            returning ${COLUMNS}`,
      );
    }
    await emitFor(ctx, 'safety.help', row!.id);
    return { checkIn: shape(row!) };
  },
});

export const safetyResolve = defineCommand({
  name: 'safety.resolve',
  description:
    'Say you reached the teammate who didn’t check out and they’re OK: the alerts stop for everyone. Only someone they asked to be told can.',
  risk: 1,
  input: SafetyCheckInRef,
  output: SafetyResolveOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety.resolved'],
  actors: ['human'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const [r] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select private.safety_resolve_as_contact(${input.workspaceId}::uuid, ${input.checkInId}::uuid) as ok`,
    );
    if (!r?.ok)
      throw HfosError.rule(
        'safety_not_yours_to_answer',
        409,
        'This alert has already been answered, or it wasn’t sent to you. Nothing more to do.',
      );
    await emitFor(ctx, 'safety.resolved', input.checkInId, { via: 'teammate' });
    return { checkInId: input.checkInId, resolved: true };
  },
});

type ContactRow = {
  id: string;
  contact_user_id: string | null;
  name: string;
  phone_e164: string | null;
  email: string | null;
  agreed_at: Date | string | null;
  stopped_at: Date | string | null;
};

const contactShape = (c: ContactRow) => ({
  id: c.id,
  contactUserId: c.contact_user_id,
  name: c.name,
  phone: c.phone_e164,
  email: c.email,
  status: contactStatus({
    teammate: !!c.contact_user_id,
    agreed: !!c.agreed_at,
    stopped: !!c.stopped_at,
  }),
});

export const safetyContactSave = defineCommand({
  name: 'safety_contact.save',
  description:
    'Add or change someone to tell if you miss a check-out: a teammate, or someone outside by phone and email. Someone outside is asked to agree by text first.',
  risk: 1,
  input: SafetyContactSaveInput,
  output: SafetyContactOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety_contact.saved'],
  actors: ['human'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    let name = input.name ?? null;
    if (input.contactUserId) {
      if (input.contactUserId === me.userId)
        throw HfosError.validation([
          { path: 'contactUserId', message: 'Pick someone other than yourself.' },
        ]);
      const [u] = await rows<{ name: string; works: boolean }>(
        ctx.tx,
        sql`select coalesce(nullif(full_name, ''), email::text) as name,
              private.works_in(id, ${ws}::uuid) as works
            from app.users where id = ${input.contactUserId}::uuid`,
      );
      if (!u?.works)
        throw HfosError.validation([
          {
            path: 'contactUserId',
            message: 'That person isn’t on this business’s team. Pick someone who is.',
          },
        ]);
      name = u.name;
    }
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.safety_contacts where workspace_id = ${ws}::uuid and user_id = ${me.userId}::uuid`,
    );
    if (!input.id && (count?.n ?? 0) >= SAFETY_LIMITS.contacts)
      throw HfosError.rule(
        'safety_contacts_full',
        409,
        `You have ${SAFETY_LIMITS.contacts} safety contacts, the most there can be. Remove one to add another.`,
      );
    const outside = !input.contactUserId;
    const [row] = input.id
      ? await rows<ContactRow>(
          ctx.tx,
          sql`update app.safety_contacts set contact_user_id = ${input.contactUserId ?? null}::uuid, name = ${name},
                phone_e164 = ${outside ? (input.phone ?? null) : null}, email = ${outside ? (input.email ?? null) : null},
                -- A new number is asked again.
                agreed_at = case when phone_e164 is distinct from ${outside ? (input.phone ?? null) : null} then null else agreed_at end,
                asked_at = case when phone_e164 is distinct from ${outside ? (input.phone ?? null) : null} then null else asked_at end
              where id = ${input.id}::uuid and workspace_id = ${ws}::uuid
              returning id, contact_user_id, name, phone_e164, email, agreed_at, stopped_at`,
        )
      : await rows<ContactRow>(
          ctx.tx,
          sql`insert into app.safety_contacts (workspace_id, user_id, contact_user_id, name, phone_e164, email, position)
              values (${ws}::uuid, ${me.userId}::uuid, ${input.contactUserId ?? null}::uuid, ${name},
                ${outside ? (input.phone ?? null) : null}, ${outside ? (input.email ?? null) : null}, ${count?.n ?? 0})
              returning id, contact_user_id, name, phone_e164, email, agreed_at, stopped_at`,
        );
    if (!row)
      throw HfosError.notFound(
        'That contact isn’t there anymore. Refresh My safety and try again.',
      );
    await ctx.emit({
      type: 'safety_contact.saved',
      entityType: 'safety_contact',
      entityId: row.id,
      payload: {
        contactId: row.id,
        outside,
        needsAsking: outside && !row.agreed_at && !!row.phone_e164,
      },
    });
    return { contact: contactShape(row) };
  },
});

export const safetyContactRemove = defineCommand({
  name: 'safety_contact.remove',
  description: 'Stop telling someone when you miss a check-out.',
  risk: 1,
  input: SafetyContactRemoveInput,
  output: SafetyContactRemoveOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety_contact.removed'],
  actors: ['human'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const gone = await rows<{ id: string }>(
      ctx.tx,
      sql`delete from app.safety_contacts where id = ${input.id}::uuid and workspace_id = ${input.workspaceId}::uuid
          returning id`,
    );
    if (gone.length)
      await ctx.emit({
        type: 'safety_contact.removed',
        entityType: 'safety_contact',
        entityId: input.id,
        payload: { contactId: input.id },
      });
    return { id: input.id, removed: gone.length > 0 };
  },
});

// ---------- the worker's ladder (apps/worker/src/safety/ladder.ts) ----------

export const safetyEscalate = defineCommand({
  name: 'safety.escalate',
  description:
    'Worker: a step of a missed check-out’s ladder. The person was asked “Still there?”, their contacts were told (again), or one text or email’s link was made. Records who, never the place.',
  risk: 0,
  input: SafetyEscalateInput,
  output: SafetyEscalateOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety.escalated'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [c] = await rows<{ state: CheckInRow['state']; alert_round: number; user_id: string }>(
      ctx.tx,
      sql`select state, alert_round, user_id from app.safety_checkins
          where id = ${input.checkInId}::uuid and workspace_id = ${ws}::uuid for update`,
    );
    if (!c) throw HfosError.notFound('That check-in isn’t there anymore.');
    const open = c.state === 'alerted' || c.state === 'help';
    let state = c.state;
    let round = c.alert_round;
    if (input.step === 'ask' && c.state === 'in') {
      await ctx.tx.execute(
        sql`update app.safety_checkins set state = 'asked', asked_at = now() where id = ${input.checkInId}::uuid`,
      );
      state = 'asked';
    } else if (
      (input.step === 'alert' && (c.state === 'asked' || c.state === 'help')) ||
      (input.step === 'repeat' && open)
    ) {
      round = c.alert_round + 1;
      state = c.state === 'help' ? 'help' : 'alerted';
      await ctx.tx.execute(
        sql`update app.safety_checkins
            set state = ${state}, alert_round = ${round}, last_alerted_at = now(),
                alerted_at = coalesce(alerted_at, now())
            where id = ${input.checkInId}::uuid`,
      );
      for (const t of input.told)
        await ctx.tx.execute(
          sql`insert into app.safety_escalations (workspace_id, checkin_id, contact_id, told_user_id, channel, round)
              values (${ws}::uuid, ${input.checkInId}::uuid, ${t.contactId}::uuid, ${t.userId}::uuid, 'app', ${round})`,
        );
    } else if (input.step === 'link' && input.link && open) {
      await ctx.tx.execute(
        sql`insert into app.safety_escalations (workspace_id, checkin_id, contact_id, channel, token_hash, round)
            select ${ws}::uuid, ${input.checkInId}::uuid, k.id, ${input.link.channel}, ${input.link.tokenHash},
              ${input.link.round}
            from app.safety_contacts k
            where k.id = ${input.link.contactId}::uuid and k.workspace_id = ${ws}::uuid and k.user_id = ${c.user_id}::uuid`,
      );
    } else {
      // Already past this step (the person answered, or a repeat run): nothing.
      return { checkInId: input.checkInId, state, round };
    }
    await emitFor(ctx, 'safety.escalated', input.checkInId, {
      step: input.step,
      round,
      told: input.told.length + (input.link ? 1 : 0),
    });
    return { checkInId: input.checkInId, state, round };
  },
});

export const safetyContactRecord = defineCommand({
  name: 'safety_contact.record',
  description:
    'Worker: someone outside was asked by text to be a safety contact, or answered: OK agrees, STOP stops everything to them.',
  risk: 0,
  input: SafetyContactRecordInput,
  output: SafetyContactRecordOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety_contact.answered'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const which = input.contactId
      ? sql`k.id = ${input.contactId}::uuid`
      : sql`k.phone_e164 = ${input.phone!}`;
    const set =
      input.what === 'asked'
        ? sql`asked_at = coalesce(k.asked_at, now())`
        : input.what === 'agreed'
          ? sql`agreed_at = now()`
          : sql`stopped_at = now()`;
    const only =
      input.what === 'agreed'
        ? sql`and k.asked_at is not null and k.agreed_at is null`
        : input.what === 'asked'
          ? sql`and k.agreed_at is null`
          : sql``;
    const changed = await rows<{ id: string; owner: string }>(
      ctx.tx,
      sql`update app.safety_contacts k set ${set}
          from app.users u
          where u.id = k.user_id and k.workspace_id = ${ws}::uuid and ${which}
            and k.contact_user_id is null and k.stopped_at is null ${only}
          returning k.id, coalesce(nullif(trim(u.full_name), ''), u.email::text) as owner`,
    );
    for (const k of changed)
      await ctx.emit({
        type: 'safety_contact.answered',
        entityType: 'safety_contact',
        entityId: k.id,
        payload: { contactId: k.id, what: input.what },
      });
    return { contacts: changed.length, people: [...new Set(changed.map((k) => k.owner))] };
  },
});

export const safetyResolveByLink = defineCommand({
  name: 'safety.resolve_by_link',
  description:
    'A safety contact’s page: they reached the person, who’s OK, and the alerts stop for everyone; or they couldn’t, and the teammates who were told hear it.',
  risk: 1,
  input: SafetyResolveByLinkInput,
  output: SafetyResolveByLinkOutput,
  permission: 'workspace.read',
  scope,
  emits: ['safety.resolved', 'safety.unreached'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [e] = await rows<{ checkin_id: string; state: string }>(
      ctx.tx,
      sql`select e.checkin_id, c.state from app.safety_escalations e
          join app.safety_checkins c on c.id = e.checkin_id
          where e.id = ${input.escalationId}::uuid and e.workspace_id = ${ws}::uuid
          for update of c`,
    );
    if (!e) throw HfosError.notFound('This link doesn’t work. Call the person yourself.');
    if (e.state !== 'alerted' && e.state !== 'help')
      return { checkInId: e.checkin_id, resolved: e.state === 'ok' || e.state === 'out' };
    if (input.how === 'unreached') {
      await ctx.tx.execute(
        sql`update app.safety_escalations set acknowledged_at = coalesce(acknowledged_at, now())
            where id = ${input.escalationId}::uuid`,
      );
      await emitFor(ctx, 'safety.unreached', e.checkin_id, { escalationId: input.escalationId });
      return { checkInId: e.checkin_id, resolved: false };
    }
    await ctx.tx.execute(
      sql`update app.safety_checkins set state = 'ok', resolved_at = now(), resolved_via = 'contact_page'
          where id = ${e.checkin_id}::uuid`,
    );
    await ctx.tx.execute(
      sql`update app.safety_escalations set acknowledged_at = coalesce(acknowledged_at, now())
          where checkin_id = ${e.checkin_id}::uuid`,
    );
    await emitFor(ctx, 'safety.resolved', e.checkin_id, { via: 'contact_page' });
    return { checkInId: e.checkin_id, resolved: true };
  },
});

// ---------- Settings → Safety ----------

export const safetySettingsSave = defineCommand({
  name: 'safety.settings_save',
  description:
    'Settings → Safety: how long after a planned end the person is asked, how long before their contacts are told, and who’s told when someone has no contacts.',
  risk: 2,
  input: SafetySettingsInput,
  output: SafetySettingsOutput,
  permission: 'workspace.update',
  scope,
  emits: ['safety.settings_saved'],
  actors: ['human'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    if (input.safetyUserId) {
      const [u] = await rows<{ works: boolean }>(
        ctx.tx,
        sql`select private.works_in(${input.safetyUserId}::uuid, ${ws}::uuid) as works`,
      );
      if (!u?.works)
        throw HfosError.validation([
          {
            path: 'safetyUserId',
            message: 'That person isn’t on this business’s team. Pick someone who is.',
          },
        ]);
    }
    const safety = {
      askAfterMinutes: input.askAfterMinutes,
      alertAfterMinutes: input.alertAfterMinutes,
      safetyUserId: input.safetyUserId,
    };
    await ctx.tx.execute(
      sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('safety', ${JSON.stringify(safety)}::jsonb)
          where id = ${ws}::uuid`,
    );
    await ctx.emit({
      type: 'safety.settings_saved',
      entityType: 'workspace',
      entityId: ws,
      payload: {},
    });
    return safety;
  },
});

export const safetyCommands = [
  safetyCheckIn,
  safetyWhere,
  safetyExtend,
  safetyCheckOut,
  safetyHelp,
  safetyResolve,
  safetyContactSave,
  safetyContactRemove,
  safetyEscalate,
  safetyContactRecord,
  safetyResolveByLink,
  safetySettingsSave,
];
