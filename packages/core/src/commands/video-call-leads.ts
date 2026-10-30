/**
 * Who to follow up with after a HandsFreeOS video call with a live poll (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md,
 * part 5; meetings/leads.ts).
 *
 * - **Scoring** (`video_call.score_leads`, the worker's, once the call ended and its answers were sent): every customer
 *   who came gets points for their answers, the buttons they pressed and staying to the end, then Hot, Warm or Cold
 *   at the poll's lines. One row of `app.video_call_leads` each. Someone newly rated, or rated differently, gets a
 *   line on their timeline and `webinar.rated`, which starts the workflows on "Somebody is rated after a webinar".
 * - **The AI's reason** (`video_call.lead_reasons`, the worker's): one line each, written once everyone is scored.
 * - **A hot one followed up** (`video_call.lead_outcome`, the worker's): what became of the AI teammate's text,
 *   recorded once. A hot one the poll puts on Home, or one it couldn't text, holds a `webinar_hot` card.
 * - **The ranked list** (`video_call.leads`): everyone from the call, hottest first, for the appointment.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import {
  appointments,
  forms,
  formVersions,
  people,
  videoCallLeads,
  videoCalls,
} from '@hfos/db/schema';
import { z } from 'zod';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { parseStoredForm } from '../forms/load';
import { defineCommand, defineQuery } from '../kernel/define';
import {
  LEAD_FOLLOW_UPS,
  LEAD_LABELS,
  LEAD_OUTCOMES,
  LEAD_REASON_CHARS,
  STAYED_GRACE_MS,
  pollLeadsOf,
  scoreLead,
  type LeadFollowUp,
  type LeadLabel,
  type LeadPart,
} from '../meetings/leads';
import { isoDateTime, uuid } from '../schemas/common';
import { lockVideoCall } from './video-call';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const nameOf = (first: string | null, last: string | null) =>
  `${first ?? ''} ${last ?? ''}`.trim() || 'Customer';

/** What the poll scores with: the version people answered (the newest, should it have changed), else the published one. */
async function scoringVersion(
  tx: Parameters<typeof rows>[0],
  callId: string,
  formId: string,
): Promise<{ versionId: string; name: string } | null> {
  const [found] = await rows<{ version_id: string | null; name: string }>(
    tx,
    sql`select coalesce(
              (select r.version_id from app.form_responses r
               where r.video_call_id = ${callId} and r.form_id = ${formId}
               order by r.created_at desc limit 1),
              f.active_version_id) as version_id, f.name
        from app.forms f where f.id = ${formId}`,
  );
  return found?.version_id ? { versionId: found.version_id, name: found.name } : null;
}

export const videoCallScoreLeads = defineCommand({
  name: 'video_call.score_leads',
  description:
    'Worker: a HandsFreeOS video call with a live poll is over, so everyone who came is scored Hot, Warm or Cold for following up.',
  risk: 0,
  input: z.object({ workspaceId: uuid, callId: uuid }),
  output: z.object({
    scored: z.int().min(0),
    hot: z.int().min(0),
    warm: z.int().min(0),
    cold: z.int().min(0),
  }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['webinar.rated', 'video_call.leads_scored'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const none = { scored: 0, hot: 0, warm: 0, cold: 0 };
    const call = await lockVideoCall(ctx, input.callId);
    // Going again since it ended: it's scored when this stretch ends.
    if (call.state !== 'ended' || !call.pollFormId) return none;
    const poll = await scoringVersion(ctx.tx, call.id, call.pollFormId);
    if (!poll) return none;
    const [version] = await ctx.tx
      .select({ definition: formVersions.definition })
      .from(formVersions)
      .where(eq(formVersions.id, poll.versionId));
    if (!version) return none;
    const definition = parseStoredForm(version.definition);
    const leads = pollLeadsOf(definition);

    // The end is when the team finished: the last of them to leave (or the call's end, should none have joined).
    const [team] = await rows<{ ended: Date | string | null }>(
      ctx.tx,
      sql`select max(left_at) as ended from app.video_call_people
          where video_call_id = ${call.id} and kind = 'team' and joined_at is not null`,
    );
    // Raw SQL gives a time as text, so each goes through new Date().
    const end = new Date(team?.ended ?? call.endedAt ?? Date.now()).getTime();
    const came = await rows<{
      person_id: string;
      seconds: number;
      left_at: Date | string | null;
      first_name: string | null;
      last_name: string | null;
    }>(
      ctx.tx,
      sql`select v.person_id, sum(v.seconds)::int as seconds, max(v.left_at) as left_at,
            p.first_name, p.last_name
          from app.video_call_people v
          join app.people p on p.id = v.person_id
          where v.video_call_id = ${call.id} and v.kind = 'customer' and v.person_id is not null
            and v.joined_at is not null
          group by v.person_id, p.first_name, p.last_name`,
    );
    if (!came.length) return none;
    const sheets = new Map(
      (
        await rows<{ id: string; person_id: string; answers: Record<string, unknown> | null }>(
          ctx.tx,
          sql`select id, person_id, answers from app.form_responses
              where video_call_id = ${call.id} and form_id = ${call.pollFormId}`,
        )
      ).map((s) => [s.person_id, s]),
    );
    const before = new Map(
      (
        await ctx.tx
          .select({ personId: videoCallLeads.personId, label: videoCallLeads.label })
          .from(videoCallLeads)
          .where(eq(videoCallLeads.videoCallId, call.id))
      ).map((l) => [l.personId, l.label]),
    );
    const [appt] = call.appointmentId
      ? await ctx.tx
          .select({ title: appointments.title })
          .from(appointments)
          .where(eq(appointments.id, call.appointmentId))
      : [];
    const what = appt?.title || poll.name;

    const counts: Record<LeadLabel, number> = { hot: 0, warm: 0, cold: 0 };
    for (const person of came) {
      const stayed =
        !!person.left_at && new Date(person.left_at).getTime() >= end - STAYED_GRACE_MS;
      const sheet = sheets.get(person.person_id) ?? null;
      const score = scoreLead(definition, sheet?.answers ?? {}, stayed);
      counts[score.label] += 1;
      const [row] = await rows<{ id: string }>(
        ctx.tx,
        sql`insert into app.video_call_leads
              (workspace_id, video_call_id, person_id, form_id, response_id, points, label, stayed, seconds,
               parts, follow_up, scored_at)
            values (${ws}, ${call.id}, ${person.person_id}, ${call.pollFormId}, ${sheet?.id ?? null},
              ${score.points}, ${score.label}, ${stayed}, ${Math.max(0, person.seconds)},
              ${JSON.stringify(score.parts)}::jsonb, ${leads.hotAction}, now())
            on conflict (video_call_id, person_id) do update set
              form_id = excluded.form_id, response_id = excluded.response_id,
              -- A reason written for other points no longer fits them.
              reason = case when app.video_call_leads.points = excluded.points
                then app.video_call_leads.reason end,
              reason_at = case when app.video_call_leads.points = excluded.points
                then app.video_call_leads.reason_at end,
              points = excluded.points, label = excluded.label, stayed = excluded.stayed,
              seconds = excluded.seconds, parts = excluded.parts, follow_up = excluded.follow_up,
              scored_at = now()
            returning id`,
      );
      if (!row || before.get(person.person_id) === score.label) continue;
      const eventId = await ctx.emit({
        type: 'webinar.rated',
        entityType: 'video_call_lead',
        entityId: row.id,
        payload: {
          personId: person.person_id,
          videoCallId: call.id,
          appointmentId: call.appointmentId,
          formId: call.pollFormId,
          label: score.label,
          points: score.points,
          followUp: leads.hotAction,
        },
        after: { label: score.label, points: score.points },
      });
      await logSystemActivity(ctx, {
        subtype: 'webinar_rated',
        personId: person.person_id,
        body:
          score.parts.map((p) => `${p.what} (${p.points > 0 ? '+' : ''}${p.points})`).join(' · ') ||
          null,
        meta: { label: score.label, points: score.points, what, videoCallId: call.id },
        eventId,
      });
    }
    await ctx.emit({
      type: 'video_call.leads_scored',
      entityType: 'video_call',
      entityId: call.id,
      payload: {
        appointmentId: call.appointmentId,
        formId: call.pollFormId,
        hotAction: leads.hotAction,
        ...counts,
      },
      after: { scored: came.length, ...counts },
    });
    return { scored: came.length, ...counts };
  },
});

export const videoCallLeadReasons = defineCommand({
  name: 'video_call.lead_reasons',
  description:
    'Worker: the AI’s one line on why each person from a HandsFreeOS video call is Hot, Warm or Cold.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    callId: uuid,
    reasons: z
      .array(z.object({ leadId: uuid, reason: z.string().trim().min(1).max(LEAD_REASON_CHARS) }))
      .max(500),
  }),
  output: z.object({ written: z.int().min(0) }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    let written = 0;
    for (const r of input.reasons) {
      const done = await ctx.tx
        .update(videoCallLeads)
        .set({ reason: r.reason, reasonAt: new Date() })
        .where(
          and(
            eq(videoCallLeads.id, r.leadId),
            eq(videoCallLeads.videoCallId, input.callId),
            eq(videoCallLeads.workspaceId, ctx.scope.workspaceId!),
          ),
        )
        .returning({ id: videoCallLeads.id });
      written += done.length;
    }
    return { written };
  },
});

export const videoCallLeadOutcome = defineCommand({
  name: 'video_call.lead_outcome',
  description:
    'Worker: what became of the AI teammate’s text to someone hot after a HandsFreeOS video call, recorded once.',
  risk: 0,
  input: z.object({
    workspaceId: uuid,
    leadId: uuid,
    outcome: z.enum(LEAD_OUTCOMES),
    reason: z.string().trim().max(200).nullable().default(null),
  }),
  output: z.object({ changed: z.boolean() }),
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  emits: ['video_call_lead.followed_up'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(videoCallLeads)
      .set({ outcome: input.outcome, outcomeReason: input.reason })
      .where(
        and(
          eq(videoCallLeads.id, input.leadId),
          eq(videoCallLeads.workspaceId, ctx.scope.workspaceId!),
          sql`${videoCallLeads.outcome} is null`,
        ),
      )
      .returning();
    if (!row) return { changed: false };
    await ctx.emit({
      type: 'video_call_lead.followed_up',
      entityType: 'video_call_lead',
      entityId: row.id,
      payload: { personId: row.personId, videoCallId: row.videoCallId, outcome: input.outcome },
      after: { outcome: input.outcome, reason: input.reason },
    });
    return { changed: true };
  },
});

// ---------- reading ----------

const LeadOut = z.object({
  id: uuid,
  personId: uuid,
  name: z.string(),
  points: z.int(),
  label: z.enum(LEAD_LABELS),
  parts: z.array(z.object({ what: z.string(), points: z.int() })),
  reason: z.string().nullable(),
  stayed: z.boolean(),
  seconds: z.int(),
  followUp: z.enum(LEAD_FOLLOW_UPS),
  outcome: z.enum(LEAD_OUTCOMES).nullable(),
  outcomeReason: z.string().nullable(),
  scoredAt: isoDateTime,
});
export type VideoCallLeadOut = z.infer<typeof LeadOut>;

export const videoCallLeadsGet = defineQuery({
  name: 'video_call.leads',
  description:
    'Who to follow up with after a HandsFreeOS video call with a live poll: everyone who came, Hot, Warm or Cold, hottest first, with their points and the AI’s reason.',
  input: z
    .object({ workspaceId: uuid, callId: uuid.optional(), appointmentId: uuid.optional() })
    .refine((i) => !!i.callId !== !!i.appointmentId, {
      error: 'Name the call or its appointment, not both.',
    }),
  output: z.object({
    call: z
      .object({
        id: uuid,
        ended: z.boolean(),
        endedAt: isoDateTime.nullable(),
        formId: uuid.nullable(),
        formName: z.string().nullable(),
        hot: z.int(),
        warm: z.int(),
        hotAction: z.enum(LEAD_FOLLOW_UPS),
      })
      .nullable(),
    counts: z.object({ hot: z.int(), warm: z.int(), cold: z.int() }),
    leads: z.array(LeadOut),
  }),
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const counts = { hot: 0, warm: 0, cold: 0 };
    const [call] = await ctx.tx
      .select()
      .from(videoCalls)
      .where(
        and(
          eq(videoCalls.workspaceId, ws),
          input.callId
            ? eq(videoCalls.id, input.callId)
            : eq(videoCalls.appointmentId, input.appointmentId!),
        ),
      );
    if (!call) {
      if (input.callId) throw HfosError.notFound('That video call isn’t here anymore.');
      return { call: null, counts, leads: [] };
    }
    const list = await ctx.tx
      .select()
      .from(videoCallLeads)
      .where(eq(videoCallLeads.videoCallId, call.id))
      .orderBy(desc(videoCallLeads.points), desc(videoCallLeads.seconds));
    const formId = list[0]?.formId ?? call.pollFormId;
    const [form] = formId
      ? await ctx.tx
          .select({ name: forms.name, activeVersionId: forms.activeVersionId })
          .from(forms)
          .where(eq(forms.id, formId))
      : [];
    const [version] = form?.activeVersionId
      ? await ctx.tx
          .select({ definition: formVersions.definition })
          .from(formVersions)
          .where(eq(formVersions.id, form.activeVersionId))
      : [];
    const settings = pollLeadsOf(version ? parseStoredForm(version.definition) : {});
    const names = new Map(
      list.length
        ? (
            await ctx.tx
              .select({ id: people.id, first: people.firstName, last: people.lastName })
              .from(people)
              .where(
                inArray(
                  people.id,
                  list.map((l) => l.personId),
                ),
              )
          ).map((p) => [p.id, nameOf(p.first, p.last)])
        : [],
    );
    const leads = list.map((l) => {
      const label = l.label as LeadLabel;
      counts[label] += 1;
      return {
        id: l.id,
        personId: l.personId,
        name: names.get(l.personId) ?? 'Customer',
        points: l.points,
        label,
        parts: (Array.isArray(l.parts) ? l.parts : []) as LeadPart[],
        reason: l.reason,
        stayed: l.stayed,
        seconds: l.seconds,
        followUp: l.followUp as LeadFollowUp,
        outcome: l.outcome as VideoCallLeadOut['outcome'],
        outcomeReason: l.outcomeReason,
        scoredAt: iso(l.scoredAt)!,
      };
    });
    return {
      call: {
        id: call.id,
        ended: call.state === 'ended',
        endedAt: iso(call.endedAt),
        formId: formId ?? null,
        formName: form?.name ?? null,
        hot: settings.hot,
        warm: settings.warm,
        hotAction: settings.hotAction,
      },
      counts,
      leads,
    };
  },
});

/** For the worker: the hot ones from a call that the poll says the AI teammate texts, not yet followed up. */
export async function videoCallLeadsToText(
  tx: Parameters<typeof rows>[0],
  callId: string,
): Promise<{ id: string; personId: string }[]> {
  return rows<{ id: string; personId: string }>(
    tx,
    sql`select id, person_id as "personId" from app.video_call_leads
        where video_call_id = ${callId} and label = 'hot' and follow_up = 'text' and outcome is null
        order by points desc`,
  );
}

export const videoCallLeadCommands = [
  videoCallScoreLeads,
  videoCallLeadReasons,
  videoCallLeadOutcome,
] as const;

export const videoCallLeadQueries = [videoCallLeadsGet] as const;
