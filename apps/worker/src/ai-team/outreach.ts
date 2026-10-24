/**
 * First messages (plan M7, "Other work"): to a new lead when the Respond skill says so, and to someone a workflow
 * handed over who has no conversation yet (handover.ts). One per lead, after the configured delay, within the
 * teammate's working hours.
 * - Skipped: imports (the system working for an importer), leads a booking opened (the booking page, the
 *   waitlist, a staff booking), the teammate's own leads, leads with no customer, customers a workflow is
 *   handing over, customers a funnel has (its first stage writes to them), and customers someone is already talking to (a conversation the teammate or a person handles,
 *   one assigned to someone, or one where they wrote in and are waiting for an answer).
 * - Consent picks the channel, the business's choice first: a text when they agreed to texts or texted or called
 *   in the last day (never after STOP), an email when they have an address, else nothing (the run says why).
 * - It runs as a reply run with no conversation (run.ts runFirstMessage): the send starts the conversation,
 *   which the teammate then handles.
 * - A new lead's greeting goes at once, whatever working hours the teammate has (Automations, "New lead
 *   greeting": Chris's call that a form fill is always answered right away). A text in quiet hours goes only
 *   within QUIET_FIRST_MESSAGE_WINDOW_MS of a lead that came in on its own; otherwise it waits for them to end.
 *   A workflow's hand-over still keeps to the teammate's hours.
 */
import {
  AI_TEAMMATE_SOURCE,
  loadTeammate,
  QUIET_FIRST_MESSAGE_WINDOW_MS,
  openHoursOf,
  scheduleJob,
  uuidArray,
  workspaceMessaging,
  type TeammateChannel,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { quietEndAt, reachOf } from '../booking/deliver';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { tenantOf, type TenantScope } from '../services';
import { runtimeConfigOf } from './config';
import { inFunnel } from './funnel-context';
import { outreachJobKey, QUIET_GRACE_MS, RECENT_CONTACT_MS, TEAMMATE_JOBS } from './constants';
import { nextWorkingAt } from './hours';
import { handoverOf, originOf, runFirstMessage, type FirstTarget } from './run';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Whether someone is already talking to this customer: nobody should get a first message on top. */
async function someoneHas(tx: Tx, workspaceId: string, personId: string): Promise<boolean> {
  const [r] = await rows<{ busy: boolean }>(
    tx,
    sql`select exists (select 1 from app.conversations c
          where c.workspace_id = ${workspaceId} and c.person_id = ${personId}
            and (c.handled_by <> 'none' or c.assignee_user_id is not null
              or (c.awaiting_reply_since is not null and c.last_inbound_at > now() - interval '1 day')))
        as busy`,
  );
  return !!r?.busy;
}

/** A workflow is handing this customer to the teammate, or just did: its own first message goes instead. */
async function workflowHasThem(tx: Tx, workspaceId: string, personId: string): Promise<boolean> {
  const [r] = await rows<{ yes: boolean }>(
    tx,
    sql`select exists (select 1 from app.scheduled_jobs j
              where j.workspace_id = ${workspaceId} and j.kind = ${TEAMMATE_JOBS.outreach}
                and j.status = 'pending' and j.payload ->> 'personId' = ${personId}
                and j.payload ->> 'trigger' = 'workflow')
          or exists (select 1 from app.ai_teammate_runs r
              where r.workspace_id = ${workspaceId} and r.person_id = ${personId}
                and r.triggered_by = 'workflow' and r.started_at > now() - interval '1 day') as yes`,
  );
  return !!r?.yes;
}

/** They texted or called this business themselves in the last day (the M6 consent rule). */
export async function recentContact(tx: Tx, workspaceId: string, phone: string): Promise<boolean> {
  const since = new Date(Date.now() - RECENT_CONTACT_MS).toISOString();
  const [r] = await rows<{ yes: boolean }>(
    tx,
    sql`select exists (select 1 from app.conversations c
              where c.workspace_id = ${workspaceId} and c.channel = 'sms' and c.counterpart = ${phone}
                and c.last_inbound_at > ${since}::timestamptz)
          or exists (select 1 from app.calls k
              where k.workspace_id = ${workspaceId} and k.direction = 'inbound' and k.from_e164 = ${phone}
                and k.started_at > ${since}::timestamptz) as yes`,
  );
  return !!r?.yes;
}

const TEXT_WHY: Readonly<Record<string, string>> = {
  text_off: 'it doesn’t send texts',
  no_phone: 'there’s no mobile number',
  opted_out: 'they opted out of texts',
  no_consent: 'they haven’t agreed to texts or texted in the last day',
  texting_not_ready: 'texting isn’t set up yet',
};
const EMAIL_WHY: Readonly<Record<string, string>> = {
  email_off: 'it doesn’t send email',
  no_email: 'there’s no email address',
};

/** `lead.created`: a first message to the new lead, after the Respond skill's delay. */
export const onLeadCreated: EventHandler = async (ctx) => {
  const e = ctx.event;
  if (!e.workspaceId || !e.organizationId || !e.entityId) return;
  const p = isRecord(e.payload) ? e.payload : {};
  // Its own leads come from a conversation already; an import works for the person importing.
  if (e.actorType === 'ai_employee' || (e.actorType === 'system' && str(p['onBehalfOf']))) return;
  const ws = e.workspaceId;
  const teammate = await loadTeammate(ctx.tx, ws);
  if (!teammate || teammate.status === 'off') return;
  const config = runtimeConfigOf(teammate.config);
  if (!config.respond.enabled || !config.respond.newLeads.enabled) return;
  const [lead] = await rows<{
    person_id: string | null;
    source: string | null;
    status: string;
    archived_at: Date | null;
  }>(
    ctx.tx,
    sql`select person_id, source, status::text as status, archived_at from app.leads where id = ${e.entityId}`,
  );
  if (!lead?.person_id || lead.status !== 'open' || lead.archived_at) return;
  if (lead.source === 'Booking page' || lead.source === AI_TEAMMATE_SOURCE) return;
  // A lead a booking opened (the booking page, the waitlist, a staff booking): they're booked already.
  const [booked] = await rows(
    ctx.tx,
    sql`select 1 from app.events where correlation_id = ${e.correlationId}
          and event_type = 'appointment.booked' limit 1`,
  );
  if (booked) return;
  if (await someoneHas(ctx.tx, ws, lead.person_id)) return;
  // A funnel took them in: its first stage writes to them (funnels/events.ts runs before this).
  if (await inFunnel(ctx.tx, lead.person_id)) return;
  await scheduleJob(ctx.tx, {
    kind: TEAMMATE_JOBS.outreach,
    dedupeKey: outreachJobKey(e.entityId),
    runAt: new Date(Date.now() + config.respond.newLeads.delayMinutes * 60_000),
    payload: { personId: lead.person_id, leadId: e.entityId, trigger: 'lead.created' },
    workspaceId: ws,
    organizationId: e.organizationId,
  });
};

type Plan = { readonly skip: true } | { readonly wait: Date } | { readonly target: FirstTarget };

/** Who, how and when: consent picks the channel; the teammate's hours and quiet hours pick the time. */
async function planFirstMessage(
  tx: Tx,
  scope: TenantScope,
  p: Readonly<Record<string, unknown>>,
  resuming: boolean,
): Promise<Plan> {
  const skip = { skip: true } as const;
  const ws = scope.workspaceId;
  const personId = str(p['personId']);
  const leadId = str(p['leadId']);
  const fromWorkflow = p['trigger'] === 'workflow';
  if (!personId) return skip;
  const teammate = await loadTeammate(tx, ws);
  if (!teammate || teammate.status === 'off') return skip;
  const config = runtimeConfigOf(teammate.config);
  if (!fromWorkflow && !(config.respond.enabled && config.respond.newLeads.enabled)) return skip;
  const [person] = await rows<{
    first_name: string;
    phone_e164: string | null;
    email: string | null;
    sms_consent: 'unknown' | 'opted_in' | 'opted_out';
    archived_at: Date | null;
  }>(
    tx,
    sql`select first_name, phone_e164, email::text as email, sms_consent::text as sms_consent, archived_at
        from app.people where id = ${personId}`,
  );
  if (!person || person.archived_at) return skip;
  // A lead that came in on its own (nobody typed it in) this recently may be greeted in quiet hours.
  let freshUntil = 0;
  if (!fromWorkflow) {
    const [lead] = await rows<{
      status: string;
      archived_at: Date | null;
      written: boolean;
      created_at: Date | string;
      typed_in: boolean;
    }>(
      tx,
      sql`select l.status::text as status, l.archived_at, l.created_at, l.created_by is not null as typed_in,
            exists (select 1 from app.ai_teammate_runs r where r.lead_id = l.id
              and r.triggered_by = 'lead.created') as written
          from app.leads l where l.id = ${leadId}`,
    );
    // One first message per lead, while it's still open.
    if (!lead || lead.status !== 'open' || lead.archived_at || (lead.written && !resuming))
      return skip;
    if (await workflowHasThem(tx, ws, personId)) return skip;
    if (!lead.typed_in)
      freshUntil = new Date(lead.created_at).getTime() + QUIET_FIRST_MESSAGE_WINDOW_MS;
  }
  if (!resuming && (await someoneHas(tx, ws, personId))) return skip;
  if (!fromWorkflow && (await inFunnel(tx, personId))) return skip;
  const wanted = str(p['channel']);
  const preferred: 'sms' | 'email' =
    wanted === 'sms' || wanted === 'email' ? wanted : config.respond.newLeads.channel;
  const recent = person.phone_e164 ? await recentContact(tx, ws, person.phone_e164) : false;
  const reach = await reachOf(
    tx,
    ws,
    {
      phone: person.phone_e164,
      email: person.email,
      smsOk: recent,
      personConsent: person.sms_consent,
    },
    { text: config.channels.sms, email: config.channels.email },
  );
  const order: readonly ('sms' | 'email')[] =
    preferred === 'email' ? ['email', 'sms'] : ['sms', 'email'];
  const channel = order.find((c) => (c === 'sms' ? reach.text === null : reach.email === null));
  if (!channel) {
    // Nothing can reach them: the run says so, for the Activity view.
    const why = `Didn’t write to ${person.first_name || 'them'}: ${TEXT_WHY[reach.text ?? ''] ?? 'no text'}, and ${EMAIL_WHY[reach.email ?? ''] ?? 'no email'}.`;
    await tx.execute(
      sql`insert into app.ai_teammate_runs
            (workspace_id, teammate_id, person_id, lead_id, triggered_by, status, outcome, summary, message_ids,
             ended_at)
          values (${ws}, ${teammate.id}, ${personId}, ${leadId}, ${fromWorkflow ? 'workflow' : 'lead.created'},
            'done', 'no_reply', ${why}, ${uuidArray([])}, now())`,
    );
    return skip;
  }
  const m = await workspaceMessaging(tx, ws);
  const tz = m.timezone || 'UTC';
  const now = Date.now();
  // A new lead is greeted whatever the teammate's hours; a workflow's hand-over keeps to them.
  if (fromWorkflow) {
    const working = nextWorkingAt(config, openHoursOf(m.rawSettings), tz, now);
    if (working > now) return { wait: new Date(working) };
  }
  if (channel === 'sms' && now > freshUntil) {
    const end = quietEndAt(m.settings.quietHours, tz, now);
    if (end !== null) return { wait: new Date(end + QUIET_GRACE_MS) };
  }
  return {
    target: {
      personId,
      leadId,
      channel: channel as TeammateChannel,
      stopWording: channel === 'sms' && reach.firstText,
    },
  };
}

/** `ai_teammate.outreach`: a first message to someone with no conversation yet. */
export const outreachJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload;
  const plan = await asWorker(ctx.db, scope, (tx) =>
    planFirstMessage(tx, scope, p, !!str(p['_runId'])),
  );
  if ('skip' in plan) return;
  if ('wait' in plan) return { rescheduleAt: plan.wait };
  return runFirstMessage(ctx, scope, plan.target, {
    kind: 'first',
    trigger: p['trigger'] === 'workflow' ? 'workflow' : 'lead.created',
    origin: originOf(p['origin']),
    handover: handoverOf(p),
  });
};
