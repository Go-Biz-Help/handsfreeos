/**
 * Running a person through their funnel (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "How it runs"): one
 * `funnel.tick` job a person, keyed by their funnel row. Each time it wakes it works out, from the funnel as it is now,
 * the one thing due: a quiet move, the stage's hand-off, or the next message. It does that, then sleeps until the next
 * thing is due. Anything that changes what's due (they reached a stage, did something, the funnel was saved, it was
 * picked up again) wakes it at once (`pokeFunnelPerson`), so a reschedule or an edit reaches them right away.
 *
 * Before a message goes it checks again: still at that stage and in the funnel, the funnel and the teammate on, the
 * "only if" holds, not past its good-until, nobody on the team has the conversation, nothing of theirs is waiting
 * for an answer, and it isn't quiet hours for a text. The message is marked sent as it's handed to the teammate, so a
 * retry never sends it twice; the teammate's `funnel` run (ai-team/run.ts) writes it, or sends the exact words, and
 * the funnel's approval setting decides whether it goes or waits on Approvals.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  definitionOf,
  executeCommandIn,
  fillFunnelText,
  funnelMessageDueAt,
  funnelMovePerson,
  funnelNoteProgress,
  funnelOnlyIfHolds,
  funnelPausePerson,
  funnelRemovePerson,
  funnelUpcoming,
  loadTeammate,
  timedByBooking,
  uuidArray,
  workspaceMessaging,
  type FunnelDefinition,
  type FunnelMessage,
  type FunnelStage,
  type TeammateChannel,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { conversations, funnelPeople, funnels } from '@hfos/db/schema';
import { quietEndAt, reachOf } from '../booking/deliver';
import { joinUrlFor, type BookingLinks } from '../booking/links';
import { clockLabel, dayLabel } from '../assistant/calendar-format';
import { runtimeConfigOf } from '../ai-team/config';
import { QUIET_GRACE_MS } from '../ai-team/constants';
import { handOffAsSystem } from '../ai-team/handoff';
import { recentContact } from '../ai-team/outreach';
import {
  runFirstMessage,
  runFunnelMessage,
  type FirstTarget,
  type FunnelRunSpec,
} from '../ai-team/run';
import { scheduleDebouncedJob, type JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { FUNNEL_HANDOFF_MARK, FUNNEL_JOBS, tickJobKey } from './constants';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const MIN = 60_000;
/** How soon it looks again after doing something, or when something of theirs waits for an answer. */
const AGAIN_MS = 5_000;
const BUSY_MS = 2 * MIN;
/** A session still counts as theirs for this long after it started (the messages around it, its end). */
const BOOKING_LOOKBACK = sql`interval '6 hours'`;

/** Wakes the person's funnel now (or at `at`): one job a person, moved to the soonest time asked. */
export async function pokeFunnelPerson(
  tx: Tx,
  scope: TenantScope,
  funnelPersonId: string,
  at: Date = new Date(),
): Promise<void> {
  await scheduleDebouncedJob(tx, {
    kind: FUNNEL_JOBS.tick,
    dedupeKey: tickJobKey(funnelPersonId),
    runAt: at,
    payload: { funnelPersonId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
}

/** Wakes everyone in it now: the funnel was saved, or turned back on, or the teammate was. */
export async function pokeFunnel(
  tx: Tx,
  scope: TenantScope,
  where: { readonly funnelId?: string; readonly all?: boolean },
): Promise<number> {
  const list = await rows<{ id: string }>(
    tx,
    sql`select fp.id from app.funnel_people fp join app.funnels f on f.id = fp.funnel_id
        where fp.workspace_id = ${scope.workspaceId} and fp.status = 'active' and f.status = 'on'
          and (${where.funnelId ?? null}::uuid is null or fp.funnel_id = ${where.funnelId ?? null}::uuid)
        limit 5000`,
  );
  for (const r of list) await pokeFunnelPerson(tx, scope, r.id);
  return list.length;
}

/** Stops the person's pending tick: they left, or were paused. */
export async function dropFunnelTick(tx: Tx, funnelPersonId: string): Promise<void> {
  await tx.execute(
    sql`update app.scheduled_jobs set status = 'cancelled', finished_at = now()
        where kind = ${FUNNEL_JOBS.tick} and dedupe_key = ${tickJobKey(funnelPersonId)} and status = 'pending'
          and locked_at is null`,
  );
}

type PersonRow = typeof funnelPeople.$inferSelect;

/** What the tick does this time. */
type Plan =
  | { readonly kind: 'done' }
  | { readonly kind: 'wait'; readonly at: Date }
  | { readonly kind: 'again' }
  | {
      readonly kind: 'send';
      readonly spec: FunnelRunSpec;
      /** The conversation the teammate writes in, or whom a first message goes to, and how. */
      readonly conversationId: string | null;
      readonly target: FirstTarget | null;
    };

interface Booking {
  readonly appointmentId: string;
  readonly attendeeId: string;
  readonly startsAt: number;
  readonly virtual: boolean;
}

/** The booking the stage is timed around: the one noted for them, else their next one (noted now). */
async function bookingOf(tx: Tx, row: PersonRow): Promise<Booking | null> {
  const seat = (where: ReturnType<typeof sql>) =>
    rows<{
      appointment_id: string;
      attendee_id: string;
      starts_at: Date | string;
      virtual: boolean;
    }>(
      tx,
      sql`select a.id as appointment_id, aa.id as attendee_id, a.starts_at,
            (a.location ->> 'kind' = 'virtual' and coalesce(a.location ->> 'meetingUrl', '') <> '') as virtual
          from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
          where aa.person_id = ${row.personId} and aa.workspace_id = ${row.workspaceId}
            and aa.status <> 'cancelled' and a.status <> 'cancelled' and ${where}
          order by a.starts_at limit 1`,
    );
  const [b] = row.appointmentId
    ? await seat(sql`a.id = ${row.appointmentId}`)
    : await seat(sql`a.starts_at > now() - ${BOOKING_LOOKBACK}`);
  return b
    ? {
        appointmentId: b.appointment_id,
        attendeeId: b.attendee_id,
        startsAt: new Date(b.starts_at).getTime(),
        virtual: !!b.virtual,
      }
    : null;
}

/** The latest thing they wrote since reaching the stage, for a quiet move's clock. */
async function lastWroteAt(tx: Tx, row: PersonRow): Promise<number> {
  const [m] = await rows<{ at: Date | string | null }>(
    tx,
    sql`select max(m.occurred_at) as at from app.messages m join app.conversations c on c.id = m.conversation_id
        where c.person_id = ${row.personId} and c.workspace_id = ${row.workspaceId} and m.direction = 'inbound'
          and m.occurred_at > ${row.stageReachedAt.toISOString()}::timestamptz`,
  );
  return m?.at ? new Date(m.at).getTime() : 0;
}

/** The conversation the teammate would write in: theirs on this channel, the newest first. */
async function conversationFor(
  tx: Tx,
  row: PersonRow,
  channels: readonly TeammateChannel[],
): Promise<typeof conversations.$inferSelect | null> {
  const list = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, row.workspaceId),
        eq(conversations.personId, row.personId),
        inArray(conversations.channel, [...channels]),
      ),
    )
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`);
  // The one the teammate already has, else the newest.
  return list.find((c) => c.handledBy === 'ai') ?? list[0] ?? null;
}

/** Something of theirs waits: a message nobody answered yet, a run under way, or a draft for a person's OK. */
async function somethingWaits(tx: Tx, conv: typeof conversations.$inferSelect): Promise<boolean> {
  const [r] = await rows<{ yes: boolean }>(
    tx,
    sql`select exists (select 1 from app.messages m where m.conversation_id = ${conv.id}
              and m.direction = 'inbound'
              and m.occurred_at > coalesce(${conv.aiAnsweredThrough?.toISOString() ?? null}::timestamptz,
                '-infinity'::timestamptz)
              and m.occurred_at > now() - interval '1 day')
          or exists (select 1 from app.ai_teammate_runs r where r.conversation_id = ${conv.id}
              and r.status = 'running')
          or exists (select 1 from app.ai_teammate_drafts d where d.conversation_id = ${conv.id}
              and d.status = 'pending') as yes`,
  );
  return !!r?.yes;
}

/** What an exact message fills in, and the Join link an AI-written one carries. */
async function fills(
  tx: Tx,
  links: BookingLinks | null,
  row: PersonRow,
  m: FunnelMessage,
  booking: Booking | null,
  business: { readonly name: string; readonly timeZone: string },
): Promise<{ readonly text: string; readonly joinLink: string | null }> {
  const wantsJoin =
    m.wording === 'exact'
      ? m.text.includes('{join_link}')
      : /\bjoin\b|\blog ?on\b|\blink\b/i.test(m.text);
  const joinLink =
    wantsJoin && links && booking?.virtual ? await joinUrlFor(tx, links, booking.attendeeId) : null;
  if (m.wording !== 'exact') return { text: m.text, joinLink };
  const [p] = await rows<{ first_name: string | null }>(
    tx,
    sql`select first_name from app.people where id = ${row.personId}`,
  );
  return {
    text: fillFunnelText(m.text, {
      first_name: p?.first_name ?? null,
      session_time: booking
        ? `${dayLabel(booking.startsAt, business.timeZone)} at ${clockLabel(booking.startsAt, business.timeZone)}`
        : null,
      join_link: joinLink,
      business: business.name,
    }),
    joinLink: null,
  };
}

const STAGE_NAME = (tx: Tx, stageId: string) =>
  rows<{ name: string }>(tx, sql`select name from app.pipeline_stages where id = ${stageId}`).then(
    (r) => r[0]?.name ?? 'a stage',
  );

/** Works out what's due for them now, and does what can be done in this transaction. */
async function planTick(
  tx: Tx,
  scope: TenantScope,
  funnelPersonId: string,
  now: number,
  links: BookingLinks | null,
  jobId: string,
): Promise<Plan> {
  const done = { kind: 'done' } as const;
  const actor = systemActor(scope);
  const meta = workerMeta(null, jobId);
  const [row] = await tx.select().from(funnelPeople).where(eq(funnelPeople.id, funnelPersonId));
  if (!row || row.status !== 'active' || !row.stageId || !row.leadId) return done;
  const [funnel] = await tx.select().from(funnels).where(eq(funnels.id, row.funnelId));
  if (!funnel || funnel.status !== 'on') return done;
  const teammate = await loadTeammate(tx, scope.workspaceId);
  if (!teammate || teammate.status === 'off') return done;
  const def: FunnelDefinition = definitionOf(funnel);
  const stage: FunnelStage | undefined = def.stages.find((s) => s.stageId === row.stageId);
  if (!stage) return done;
  const [lead] = await rows<{ status: string; archived_at: Date | null }>(
    tx,
    sql`select status::text as status, archived_at from app.leads where id = ${row.leadId}`,
  );
  if (!lead || lead.archived_at || lead.status !== 'open') {
    await executeCommandIn(
      tx,
      funnelRemovePerson,
      { workspaceId: scope.workspaceId, funnelPersonId: row.id, reason: 'lead_gone' },
      actor,
      meta,
    );
    return done;
  }
  const m = await workspaceMessaging(tx, scope.workspaceId);
  const business = { name: m.name, timeZone: m.timezone || 'UTC' };
  const reachedAt = row.stageReachedAt.getTime();
  const wakes: number[] = [];

  // Time passing with nothing from them moves them on.
  const quiet = stage.moves.filter((x) => x.kind === 'quiet');
  if (quiet.length) {
    const anchor = Math.max(reachedAt, await lastWroteAt(tx, row));
    for (const q of quiet) {
      const due = anchor + q.minutes * MIN;
      if (due > now) {
        wakes.push(due);
        continue;
      }
      await executeCommandIn(
        tx,
        funnelMovePerson,
        { workspaceId: scope.workspaceId, funnelPersonId: row.id, stageId: q.to, moveId: q.id },
        actor,
        meta,
      );
      return done;
    }
  }

  const booking = stage.messages.some(timedByBooking) ? await bookingOf(tx, row) : null;
  if (booking && booking.appointmentId !== row.appointmentId)
    await executeCommandIn(
      tx,
      funnelNoteProgress,
      {
        workspaceId: scope.workspaceId,
        funnelPersonId: row.id,
        stageId: row.stageId,
        appointmentId: booking.appointmentId,
      },
      actor,
      meta,
    );
  const clock = {
    reachedAt,
    booking: booking ? { startsAt: booking.startsAt } : null,
    timeZone: business.timeZone,
  };
  const upcoming = funnelUpcoming(stage, { ...clock, sent: row.sent, seen: row.seen, now });
  // An "only if they have" waits for them to do it: what they do wakes this again.
  const due = upcoming.filter((u) => u.dueAt <= now && funnelOnlyIfHolds(u.message, row.seen));
  for (const u of upcoming) if (u.dueAt > now) wakes.push(u.dueAt);
  const next = due[0];

  // After the stage's first messages, the team takes over.
  const firstOnes = stage.messages.filter((x) => x.when.kind === 'arrive' && x.when.minutes === 0);
  if (
    stage.handOff &&
    !row.sent.includes(FUNNEL_HANDOFF_MARK) &&
    firstOnes.every((x) => row.sent.includes(x.id))
  ) {
    const conv = await conversationFor(tx, row, ['sms', 'email', 'chat']);
    await executeCommandIn(
      tx,
      funnelNoteProgress,
      {
        workspaceId: scope.workspaceId,
        funnelPersonId: row.id,
        stageId: row.stageId,
        sent: [FUNNEL_HANDOFF_MARK],
      },
      actor,
      meta,
    );
    if (conv && conv.handledBy === 'ai')
      await handOffAsSystem(
        tx,
        scope,
        conv.id,
        'other',
        `${funnel.name}: they reached ${await STAGE_NAME(tx, row.stageId)}, which goes to the team.`,
        meta,
      );
    return { kind: 'again' };
  }

  if (!next) return wakes.length ? { kind: 'wait', at: new Date(Math.min(...wakes)) } : done;

  // Who writes, and where: the conversation the teammate has, else a first message by what they agreed to.
  const config = runtimeConfigOf(teammate.config);
  const message = next.message;
  const wanted: TeammateChannel[] =
    message.how === 'text'
      ? ['sms']
      : message.how === 'email'
        ? ['email']
        : ['sms', 'email', 'chat'];
  const conv = await conversationFor(tx, row, wanted);
  let channel: TeammateChannel;
  let stopWording = false;
  if (conv) {
    const mine = conv.handledBy === 'ai' && conv.aiTeammateId === teammate.id;
    const free = conv.handledBy === 'none' && !conv.assigneeUserId;
    // Someone on the team has them: the funnel waits until it's handed back.
    if (!mine && !free) {
      await executeCommandIn(
        tx,
        funnelPausePerson,
        {
          workspaceId: scope.workspaceId,
          funnelPersonId: row.id,
          paused: true,
          reason: 'taken_over',
        },
        actor,
        meta,
      );
      return done;
    }
    if (await somethingWaits(tx, conv)) return { kind: 'wait', at: new Date(now + BUSY_MS) };
    channel = conv.channel as TeammateChannel;
  } else {
    const [person] = await rows<{
      phone_e164: string | null;
      email: string | null;
      sms_consent: 'unknown' | 'opted_in' | 'opted_out';
    }>(
      tx,
      sql`select phone_e164, email::text as email, sms_consent::text as sms_consent
          from app.people where id = ${row.personId}`,
    );
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      {
        phone: person?.phone_e164 ?? null,
        email: person?.email ?? null,
        smsOk: person?.phone_e164
          ? await recentContact(tx, scope.workspaceId, person.phone_e164)
          : false,
        personConsent: person?.sms_consent ?? 'unknown',
      },
      { text: config.channels.sms, email: config.channels.email },
    );
    const order = wanted.filter((c): c is 'sms' | 'email' => c !== 'chat');
    const can = order.find((c) => (c === 'sms' ? reach.text === null : reach.email === null));
    if (!can) {
      // Nothing reaches them this way: it's skipped, and the Activity view says why.
      await executeCommandIn(
        tx,
        funnelNoteProgress,
        {
          workspaceId: scope.workspaceId,
          funnelPersonId: row.id,
          stageId: row.stageId,
          sent: [message.id],
        },
        actor,
        meta,
      );
      await tx.execute(
        sql`insert into app.ai_teammate_runs
              (workspace_id, teammate_id, person_id, lead_id, triggered_by, status, outcome, summary, message_ids,
               ended_at)
            values (${scope.workspaceId}, ${teammate.id}, ${row.personId}, ${row.leadId}, 'funnel.message', 'done',
              'no_reply', ${`${funnel.name}: couldn’t send this message, since nothing reaches them ${message.how === 'email' ? 'by email' : message.how === 'text' ? 'by text' : 'by text or email'}.`},
              ${uuidArray([])}, now())`,
      );
      return { kind: 'again' };
    }
    channel = can;
    stopWording = can === 'sms' && reach.firstText;
  }
  // A text waits for quiet hours to end (and a little after).
  if (channel === 'sms') {
    const end = quietEndAt(m.settings.quietHours, business.timeZone, now);
    if (end !== null) return { kind: 'wait', at: new Date(end + QUIET_GRACE_MS) };
  }
  // Marked sent as it's handed over: a retry never sends it twice.
  await executeCommandIn(
    tx,
    funnelNoteProgress,
    {
      workspaceId: scope.workspaceId,
      funnelPersonId: row.id,
      stageId: row.stageId,
      sent: [message.id],
    },
    actor,
    meta,
  );
  const filled = await fills(tx, links, row, message, booking, business);
  const dueAt = funnelMessageDueAt(message, clock);
  return {
    kind: 'send',
    conversationId: conv?.id ?? null,
    target: conv ? null : { personId: row.personId, leadId: row.leadId, channel, stopWording },
    spec: {
      funnelId: funnel.id,
      funnelName: funnel.name,
      funnelPersonId: row.id,
      stageId: row.stageId,
      stageName: await STAGE_NAME(tx, row.stageId),
      messageId: message.id,
      wording: message.wording,
      text: filled.text,
      joinLink: filled.joinLink,
      approval: def.approval,
      late: dueAt !== null && now - Math.max(dueAt, reachedAt) > 30 * MIN,
    },
  };
}

/** `funnel.tick`: the one thing due for a person in their funnel, then sleep until the next. */
export const funnelTickJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const funnelPersonId = str(ctx.job.payload['funnelPersonId']);
  if (!funnelPersonId) return;
  // A run already under way for this tick (a busy provider retried it): it resumes, writing the same message.
  const resuming = str(ctx.job.payload['_funnelRun']);
  const plan: Plan = resuming
    ? (JSON.parse(resuming) as Plan)
    : await asWorker(ctx.db, scope, (tx) =>
        planTick(tx, scope, funnelPersonId, ctx.now, ctx.bookingLinks ?? null, ctx.job.id),
      );
  if (plan.kind === 'done') return;
  if (plan.kind === 'wait') return { rescheduleAt: plan.at };
  if (plan.kind === 'again') return { rescheduleAt: new Date(Date.now() + AGAIN_MS) };
  if (!resuming)
    await asWorker(ctx.db, scope, (tx) =>
      tx.execute(
        sql`update app.scheduled_jobs set payload = payload || ${JSON.stringify({ _funnelRun: JSON.stringify(plan) })}::jsonb
            where id = ${ctx.job.id}`,
      ),
    );
  const spec = {
    kind: 'funnel' as const,
    trigger: 'funnel.message',
    origin: null,
    handover: null,
    funnel: plan.spec,
  };
  const result = plan.conversationId
    ? await runFunnelMessage(ctx, scope, plan.conversationId, spec)
    : plan.target
      ? await runFirstMessage(ctx, scope, plan.target, spec)
      : undefined;
  await asWorker(ctx.db, scope, (tx) =>
    tx.execute(
      sql`update app.scheduled_jobs set payload = (payload - '_funnelRun') - '_runId' where id = ${ctx.job.id}`,
    ),
  );
  return result?.rescheduleAt ? result : { rescheduleAt: new Date(Date.now() + AGAIN_MS) };
};
