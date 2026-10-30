/**
 * Who to follow up with after a HandsFreeOS video call with a live poll (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md,
 * part 5; core's commands/video-call-leads.ts).
 *
 * 1. **Scored** once the call's answers are sent (polls.ts runs `video_call.score_leads` straight after
 *    `video_call.polls_finish`), so `video_call.leads_scored` goes out a little over ten seconds after the end.
 * 2. **The AI's one line** on why each is Hot, Warm or Cold (`video_call.lead_reasons`): one quick call for every
 *    fifty people, the hot ones first, on the business's AI as `meetings`. An empty budget or balance leaves the
 *    lines out; nothing else waits on them.
 * 3. **The hot ones texted** when the poll says so (its default), as soon as the hot ones' lines are in: one job each
 *    (`webinar.text_hot`), as Automations' thank-you does. The AI teammate writes it, a draft to OK while it's on
 *    training wheels. When it can't (there's none, it's off, or someone on the team has their conversation) a card on
 *    Home asks a person instead. Quiet hours hold it.
 */
import {
  executeCommand,
  loadTeammate,
  scheduleJob,
  videoCallLeadOutcome,
  videoCallLeadReasons,
  videoCallLeadsToText,
  workspaceMessaging,
  type TeammateChannel,
} from '@hfos/core/server';
import { LEAD_REASON_CHARS, type LeadOutcome } from '@hfos/core';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { AiAskError, askStructured } from '../ai/ask';
import { runtimeConfigOf } from '../ai-team/config';
import { QUIET_GRACE_MS } from '../ai-team/constants';
import { runFirstMessage } from '../ai-team/run';
import { quietEndAt, reachOf } from '../booking/deliver';
import type { EventHandler } from '../handlers/types';
import type { JobContext, JobHandler } from '../jobs';
import { payloadOf } from '../push/moment';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

export const VIDEO_CALL_LEAD_REASONS_JOB = 'video_call.lead_reasons';
export const WEBINAR_TEXT_HOT_JOB = 'webinar.text_hot';
/** The run's `triggered_by`, which is also how the job finds the run it started. */
export const WEBINAR_TEXT_HOT_TRIGGER = 'webinar.text_hot';
/** People in one question to the model. */
const REASONS_PER_ASK = 50;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** `video_call.leads_scored`: the AI's lines, then the hot ones' texts. */
export const onVideoCallLeadsScored: EventHandler = async (ctx) => {
  const callId = ctx.event.entityId;
  if (!callId) return;
  const p = payloadOf(ctx);
  if (!Number(p['hot'] ?? 0) && !Number(p['warm'] ?? 0) && !Number(p['cold'] ?? 0)) return;
  const scope = tenantOf(ctx.scope);
  await scheduleJob(ctx.tx, {
    kind: VIDEO_CALL_LEAD_REASONS_JOB,
    dedupeKey: `${VIDEO_CALL_LEAD_REASONS_JOB}:${callId}:${ctx.event.id}`,
    runAt: new Date(),
    payload: { callId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

interface LeadRow extends Record<string, unknown> {
  id: string;
  label: 'hot' | 'warm' | 'cold';
  points: number;
  stayed: boolean;
  seconds: number;
  parts: { what?: unknown; points?: unknown }[] | null;
  first_name: string | null;
}

export const LEAD_REASONS_SYSTEM = [
  'You help a small business decide whom to follow up with after its webinar.',
  'Each person was scored from their answers to the live poll, the buttons they pressed, and how long they stayed.',
  'For each person, write one short plain sentence on why they are where they are: what makes them look ready, lukewarm or not interested yet, from what they did.',
  'Name what they said or did, never the points. At most 25 words. No names, no greetings, no emoji.',
].join('\n');

const LeadReasonsAnswer = z.object({
  people: z.array(z.object({ id: z.string(), reason: z.string() })).max(REASONS_PER_ASK * 2),
});
const LEAD_REASONS_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['people'],
  additionalProperties: false,
} as const;

/** The request's last line, which the scripted stand-in answers. */
export const LEAD_REASONS_ASK = 'Write the one line for each person.';

/** What one person did, as the model reads it. */
export function leadLine(l: LeadRow, minutes: number | null): string {
  const did = (l.parts ?? [])
    .map((p) => (typeof p.what === 'string' ? p.what : ''))
    .filter(Boolean)
    .filter((w) => w !== 'Stayed to the end');
  const stay = l.stayed
    ? 'stayed to the end'
    : minutes !== null
      ? `stayed ${Math.max(1, Math.round(l.seconds / 60))} of ${minutes} minutes`
      : `stayed ${Math.max(1, Math.round(l.seconds / 60))} minutes`;
  return `- ${l.id} (${l.label}): ${[...did, stay].join('; ') || 'came, said nothing'}`;
}

/** The AI's lines for one group of people, or none when the AI can't answer now. */
async function reasonsFor(
  ctx: JobContext,
  scope: TenantScope,
  what: string,
  minutes: number | null,
  people: readonly LeadRow[],
): Promise<{ leadId: string; reason: string }[]> {
  const out: { leadId: string; reason: string }[] = [];
  for (let i = 0; i < people.length; i += REASONS_PER_ASK) {
    const batch = people.slice(i, i + REASONS_PER_ASK);
    try {
      const { value } = await askStructured(ctx, scope, {
        system: LEAD_REASONS_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              `The webinar: ${what}`,
              'The people:',
              ...batch.map((l) => leadLine(l, minutes)),
              LEAD_REASONS_ASK,
            ].join('\n'),
          },
        ],
        schema: LEAD_REASONS_SCHEMA,
        zod: LeadReasonsAnswer,
        maxTokens: 4_000,
        usage: { source: 'meetings' },
      });
      const asked = new Set(batch.map((l) => l.id));
      for (const r of value.people) {
        const reason = r.reason.replace(/\s+/g, ' ').trim().slice(0, LEAD_REASON_CHARS);
        if (asked.has(r.id) && reason) out.push({ leadId: r.id, reason });
      }
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      ctx.log.warn({ code: e.code }, 'the AI couldn’t write why webinar leads are hot');
      // Out of budget or balance, or not set up: the rest won't fare better.
      if (!e.retryable) break;
    }
  }
  return out;
}

/** `video_call.lead_reasons`: the hot ones' lines, their texts, then everyone else's lines. */
export const videoCallLeadReasonsJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const callId = str(ctx.job.payload['callId']);
  if (!callId) return;
  const { leads, what, minutes } = await asWorker(ctx.db, scope, async (tx) => {
    const [call] = await rows<{ what: string | null; minutes: number | null }>(
      tx,
      sql`select coalesce(a.title, f.name) as what,
            round(extract(epoch from (a.ends_at - a.starts_at)) / 60)::int as minutes
          from app.video_calls c
          left join app.appointments a on a.id = c.appointment_id
          left join app.forms f on f.id = c.poll_form_id
          where c.id = ${callId} and c.workspace_id = ${scope.workspaceId}`,
    );
    const list = await rows<LeadRow>(
      tx,
      sql`select v.id, v.label, v.points, v.stayed, v.seconds, v.parts, p.first_name
          from app.video_call_leads v join app.people p on p.id = v.person_id
          where v.video_call_id = ${callId} and v.reason is null
          order by v.points desc
          limit 500`,
    );
    return { leads: list, what: call?.what ?? 'The webinar', minutes: call?.minutes ?? null };
  });
  const hot = leads.filter((l) => l.label === 'hot');
  const rest = leads.filter((l) => l.label !== 'hot');
  const write = async (reasons: { leadId: string; reason: string }[]) => {
    if (!reasons.length) return;
    await executeCommand(
      ctx.db,
      videoCallLeadReasons,
      { workspaceId: scope.workspaceId, callId, reasons },
      systemActor(scope),
      workerMeta(),
    );
  };
  try {
    await write(await reasonsFor(ctx, scope, what, minutes, hot));
  } finally {
    // The texts go whether or not the lines came: they're what's due within minutes of the end.
    await asWorker(ctx.db, scope, async (tx) => {
      for (const lead of await videoCallLeadsToText(tx, callId))
        await scheduleJob(tx, {
          kind: WEBINAR_TEXT_HOT_JOB,
          dedupeKey: `${WEBINAR_TEXT_HOT_JOB}:${lead.id}`,
          runAt: new Date(),
          payload: { leadId: lead.id },
          workspaceId: scope.workspaceId,
          organizationId: scope.organizationId,
        });
    });
  }
  await write(await reasonsFor(ctx, scope, what, minutes, rest));
};

interface Seat extends Record<string, unknown> {
  id: string;
  person_id: string;
  label: string;
  follow_up: string;
  outcome: string | null;
  scored_at: Date | string;
  reason: string | null;
  parts: { what?: unknown }[] | null;
  what: string | null;
  lead_id: string | null;
  phone: string | null;
  email: string | null;
  sms_ok: boolean;
  sms_consent: 'unknown' | 'opted_in' | 'opted_out';
  person_archived: boolean;
  messaged: boolean;
  someone_has: boolean;
  recent: boolean;
}

type Plan =
  | { readonly done: true }
  | { readonly wait: Date }
  | { readonly outcome: LeadOutcome; readonly reason: string | null }
  | { readonly seat: Seat; readonly channel: TeammateChannel; readonly stopWording: boolean };

async function record(
  ctx: JobContext,
  scope: TenantScope,
  leadId: string,
  outcome: LeadOutcome,
  reason: string | null,
): Promise<void> {
  await executeCommand(
    ctx.db,
    videoCallLeadOutcome,
    { workspaceId: scope.workspaceId, leadId, outcome, reason },
    systemActor(scope),
    workerMeta(),
  );
}

/** `webinar.text_hot`: the AI teammate's text to someone hot after a webinar, or the Home card that asks a person. */
export const webinarTextHotJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const leadId = str(ctx.job.payload['leadId']);
  if (!leadId) return;
  const resuming = !!str(ctx.job.payload['_runId']);
  const plan = await asWorker(ctx.db, scope, async (tx): Promise<Plan> => {
    const done = { done: true } as const;
    const recentSince = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const [seat] = await rows<Seat>(
      tx,
      sql`select v.id, v.person_id, v.label, v.follow_up, v.outcome, v.scored_at, v.reason, v.parts,
            coalesce(a.title, f.name) as what,
            (select l.id from app.leads l where l.workspace_id = v.workspace_id and l.person_id = v.person_id
               and l.status = 'open' and l.archived_at is null order by l.created_at desc limit 1) as lead_id,
            coalesce(seat.contact_phone_e164, p.phone_e164) as phone,
            coalesce(seat.contact_email, p.email::text) as email,
            coalesce(seat.sms_ok, false) as sms_ok, p.sms_consent::text as sms_consent,
            p.archived_at is not null as person_archived,
            -- Anybody wrote to them since they were scored (a draft of this very text aside).
            exists (select 1 from app.messages m join app.conversations c on c.id = m.conversation_id
              where c.workspace_id = v.workspace_id and c.person_id = v.person_id
                and m.direction = 'outbound' and m.occurred_at > v.scored_at) as messaged,
            exists (select 1 from app.conversations c
              where c.workspace_id = v.workspace_id and c.person_id = v.person_id
                and (c.handled_by = 'person' or (c.handled_by = 'none' and c.assignee_user_id is not null)))
              as someone_has,
            exists (select 1 from app.conversations c
              where c.workspace_id = v.workspace_id and c.person_id = v.person_id and c.channel = 'sms'
                and c.last_inbound_at > ${recentSince}::timestamptz) as recent
          from app.video_call_leads v
          join app.people p on p.id = v.person_id
          join app.video_calls vc on vc.id = v.video_call_id
          left join app.appointments a on a.id = vc.appointment_id
          left join app.forms f on f.id = v.form_id
          -- Their seat on the webinar: the number and the agreement to texts they gave when they booked.
          left join lateral (select aa.contact_phone_e164, aa.contact_email, aa.sms_ok
            from app.video_call_people vp join app.appointment_attendees aa on aa.id = vp.attendee_id
            where vp.video_call_id = v.video_call_id and vp.person_id = v.person_id
            order by aa.sms_ok desc limit 1) seat on true
          where v.workspace_id = ${scope.workspaceId} and v.id = ${leadId}`,
    );
    // Scored again since (cooled off), the poll changed its mind, or already decided.
    if (!seat || seat.label !== 'hot' || seat.follow_up !== 'text' || seat.outcome) return done;
    if (seat.person_archived) return { outcome: 'skipped', reason: 'customer archived' };
    if (seat.messaged && !resuming)
      return { outcome: 'skipped', reason: 'someone already wrote to them' };
    const teammate = await loadTeammate(tx, scope.workspaceId);
    const config = teammate ? runtimeConfigOf(teammate.config) : null;
    const reach = await reachOf(
      tx,
      scope.workspaceId,
      {
        phone: seat.phone,
        email: seat.email,
        smsOk: seat.sms_ok || seat.recent,
        personConsent: seat.sms_consent,
      },
      { text: config?.channels.sms ?? true, email: config?.channels.email ?? true },
    );
    const channel: TeammateChannel | null =
      reach.text === null ? 'sms' : reach.email === null ? 'email' : null;
    if (!channel) return { outcome: 'skipped', reason: 'no way to reach them' };
    if (!teammate || teammate.status === 'off')
      return {
        outcome: 'card',
        reason: teammate ? 'Your AI teammate is off' : 'No AI teammate to write to them',
      };
    if (seat.someone_has && !resuming)
      return { outcome: 'card', reason: 'Someone on the team has their conversation' };
    if (channel === 'sms') {
      const m = await workspaceMessaging(tx, scope.workspaceId);
      const end = quietEndAt(m.settings.quietHours, m.timezone || 'UTC', Date.now());
      if (end !== null) return { wait: new Date(end + QUIET_GRACE_MS) };
    }
    return { seat, channel, stopWording: channel === 'sms' && reach.firstText };
  });
  if ('done' in plan) return;
  if ('wait' in plan) return { rescheduleAt: plan.wait };
  if ('outcome' in plan) {
    await record(ctx, scope, leadId, plan.outcome, plan.reason);
    return;
  }
  const { seat } = plan;
  const result = await runFirstMessage(
    ctx,
    scope,
    {
      personId: seat.person_id,
      leadId: seat.lead_id,
      channel: plan.channel,
      stopWording: plan.stopWording,
    },
    {
      kind: 'task',
      trigger: WEBINAR_TEXT_HOT_TRIGGER,
      origin: null,
      handover: null,
      task: {
        purpose: 'webinar_hot',
        webinar: seat.what ?? 'The webinar',
        endedAt: new Date(seat.scored_at).getTime(),
        answers: (seat.parts ?? [])
          .map((p) => (typeof p.what === 'string' ? p.what : ''))
          .filter(Boolean),
        reason: seat.reason,
      },
    },
  );
  // Waiting (another first message to them is running, or quiet hours came on): it runs again then.
  if (result) return result;
  // What its run did decides: a message or a draft, else a person is asked.
  const [run] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ outcome: string | null }>(
      tx,
      sql`select outcome from app.ai_teammate_runs
          where workspace_id = ${scope.workspaceId} and person_id = ${seat.person_id}
            and triggered_by = ${WEBINAR_TEXT_HOT_TRIGGER}
            and started_at >= ${new Date(seat.scored_at).toISOString()}::timestamptz
          order by started_at desc limit 1`,
    ),
  );
  if (run?.outcome === 'replied') await record(ctx, scope, leadId, 'sent', null);
  else if (run?.outcome === 'drafted') await record(ctx, scope, leadId, 'drafted', null);
  else await record(ctx, scope, leadId, 'card', 'Your AI teammate didn’t write one');
};
