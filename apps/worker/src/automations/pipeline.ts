/**
 * Automations' pipeline rows, as things happen:
 * - "Move deals along for you": when someone gets back to a customer, a quote goes out, a visit is booked, or the
 *   customer says yes (accepts the quote, or the job is done), their open deal moves to the stage that says so.
 *   Forward only, never out of won or lost, and its timeline says why ("New → Estimate sent (Quote 1042 went
 *   out)"). Which stage means what is guessed from the stage names; Adjust fixes a guess.
 * - "Add people you're talking with": someone with no open deal who is really talking with the business (they
 *   wrote twice and a person or the AI teammate wrote back, or a call that went on for a minute) gets a deal in
 *   the first stage, as that channel's lead intake says.
 */
import {
  automationSettingsOf,
  dealFacts,
  dealMoveOf,
  executeCommandIn,
  leadCreate,
  leadMoveStage,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { EventHandler, HandlerContext } from '../handlers/types';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';

const DAY = 86_400_000;
/** "Really talking": within this long. */
export const ENGAGED_WINDOW_MS = 14 * DAY;
/** At least this many messages from them… */
export const ENGAGED_INBOUND = 2;
/** …or a call at least this long. */
export const ENGAGED_CALL_SECONDS = 60;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

async function settingsOf(tx: Tx, workspaceId: string) {
  const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
    tx,
    sql`select settings from app.workspaces where id = ${workspaceId}`,
  );
  return automationSettingsOf(ws?.settings);
}

/** The deals and customers an event is about. */
async function whoOf(ctx: HandlerContext): Promise<{ leadIds: string[]; personIds: string[] }> {
  const { event, tx } = ctx;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const leadIds = [str(p['leadId'])].filter((x): x is string => !!x);
  const personIds = [str(p['personId']), ...strs(p['personIds'])].filter((x): x is string => !!x);
  if (event.entityType === 'appointment' && event.entityId) {
    const found = await rows<{ lead_id: string | null; person_id: string | null }>(
      tx,
      sql`select a.lead_id, aa.person_id from app.appointments a
          left join app.appointment_attendees aa on aa.appointment_id = a.id and aa.status <> 'cancelled'
          where a.id = ${event.entityId}`,
    );
    for (const f of found) {
      if (f.lead_id) leadIds.push(f.lead_id);
      if (f.person_id) personIds.push(f.person_id);
    }
  }
  const conversationId = str(p['conversationId']);
  if (personIds.length === 0 && conversationId) {
    const [c] = await rows<{ person_id: string | null }>(
      tx,
      sql`select person_id from app.conversations where id = ${conversationId}`,
    );
    if (c?.person_id) personIds.push(c.person_id);
  }
  return { leadIds: [...new Set(leadIds)], personIds: [...new Set(personIds)] };
}

/** Moves each of these deals as far forward as what happened to it says. Returns how many moved. */
export async function moveDeals(
  tx: Tx,
  scope: TenantScope,
  who: { readonly leadIds?: readonly string[]; readonly personIds?: readonly string[] },
  meta: ReturnType<typeof workerMeta>,
): Promise<number> {
  const settings = await settingsOf(tx, scope.workspaceId);
  if (!settings.switches.pipelineMoves) return 0;
  const deals = await dealFacts(tx, scope.workspaceId, who);
  let moved = 0;
  for (const deal of deals) {
    const move = dealMoveOf(deal, deal.stages, settings.pipeline.roles, deal.evidence);
    if (!move) continue;
    try {
      await executeCommandIn(
        tx,
        leadMoveStage,
        {
          workspaceId: scope.workspaceId,
          leadId: deal.leadId,
          stageId: move.stage.id,
          because: move.why,
        },
        systemActor(scope),
        meta,
      );
      moved += 1;
    } catch {
      // Moved or closed in the meantime: the card catches anything still behind tomorrow.
    }
  }
  return moved;
}

/** Something happened that a deal's stage may not show yet. */
export const onPipelineEvidence: EventHandler = async (ctx) => {
  const who = await whoOf(ctx);
  if (who.leadIds.length === 0 && who.personIds.length === 0) return;
  await moveDeals(
    ctx.tx,
    tenantOf(ctx.scope),
    who,
    workerMeta(ctx.event.correlationId, ctx.event.id),
  );
};

interface Engagement extends Record<string, unknown> {
  first_name: string | null;
  last_name: string | null;
  archived: boolean;
  own: boolean;
  open_deal: boolean;
  recently_won: boolean;
  visit_ahead: boolean;
  inbound: number;
  replied_by: string | null;
  ai_replied: boolean;
  call_by: string | null;
  long_call: boolean;
}

/** The intake source a channel's leads land in: its stage, if the business pointed it anywhere, and whether it makes leads. */
async function intakeTarget(
  tx: Tx,
  workspaceId: string,
  kind: 'text' | 'call' | 'email' | null,
): Promise<{ createLead: boolean; pipelineId: string | null; stageId: string | null }> {
  if (!kind) return { createLead: true, pipelineId: null, stageId: null };
  const [row] = await rows<{
    create_lead: boolean;
    active: boolean;
    pipeline_id: string | null;
    stage_id: string | null;
    live_stage: boolean;
  }>(
    tx,
    sql`select s.create_lead, s.active, s.pipeline_id, s.stage_id,
          exists (select 1 from app.pipeline_stages st join app.pipelines p on p.id = st.pipeline_id
            where st.id = s.stage_id and st.pipeline_id = s.pipeline_id and st.kind = 'open'
              and p.archived_at is null) as live_stage
        from app.intake_sources s
        where s.workspace_id = ${workspaceId} and s.kind = ${kind} and s.public_key is null
        limit 1`,
  );
  if (!row) return { createLead: true, pipelineId: null, stageId: null };
  return {
    createLead: row.active && row.create_lead,
    pipelineId: row.live_stage ? row.pipeline_id : null,
    stageId: row.live_stage ? row.stage_id : null,
  };
}

/**
 * A message or a call: if they're really talking with the business and have no open deal, one is made. Left alone:
 * archived people, the business's own numbers, a customer with a visit already booked or a deal won in the last
 * two weeks (that's the job they're talking about), and a channel whose lead intake is off.
 */
export const onEngaged: EventHandler = async (ctx) => {
  const { event, tx } = ctx;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const personId = str(p['personId']);
  if (!personId) return;
  const scope = tenantOf(ctx.scope);
  const settings = await settingsOf(tx, scope.workspaceId);
  if (!settings.switches.engagedLeads) return;
  const since = new Date(Date.now() - ENGAGED_WINDOW_MS).toISOString();
  const [e] = await rows<Engagement>(
    tx,
    sql`select p.first_name, p.last_name, p.archived_at is not null as archived,
          p.phone_e164 is not null and (
            exists (select 1 from app.phone_numbers n where n.workspace_id = p.workspace_id
              and n.e164 = p.phone_e164)
            or exists (select 1 from app.user_phones up
              join app.workspace_access wa on wa.user_id = up.user_id and wa.workspace_id = p.workspace_id
              where up.e164 = p.phone_e164 and up.verified_at is not null)) as own,
          exists (select 1 from app.leads l where l.workspace_id = p.workspace_id and l.person_id = p.id
            and l.status = 'open' and l.archived_at is null) as open_deal,
          exists (select 1 from app.leads l where l.workspace_id = p.workspace_id and l.person_id = p.id
            and l.status = 'won' and l.won_at > now() - interval '14 days') as recently_won,
          exists (select 1 from app.appointment_attendees aa join app.appointments a on a.id = aa.appointment_id
            where aa.person_id = p.id and aa.status = 'booked' and a.status = 'scheduled'
              and a.ends_at > now()) as visit_ahead,
          (select count(*)::int from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.person_id = p.id and m.direction = 'inbound' and m.created_at > ${since}::timestamptz) as inbound,
          (select m.sent_by from app.messages m join app.conversations c on c.id = m.conversation_id
            where c.person_id = p.id and m.direction = 'outbound' and m.sent_by is not null
              and m.created_at > ${since}::timestamptz
            order by m.created_at desc limit 1) as replied_by,
          exists (select 1 from app.ai_teammate_runs r join app.conversations c on c.id = r.conversation_id
            where c.person_id = p.id and r.outcome = 'replied' and not r.is_test
              and r.started_at > ${since}::timestamptz) as ai_replied,
          (select k.answered_by_user_id from app.calls k where k.person_id = p.id
            and k.duration_seconds >= ${ENGAGED_CALL_SECONDS} and k.answered_at is not null
            and k.started_at > ${since}::timestamptz
            order by k.started_at desc limit 1) as call_by,
          exists (select 1 from app.calls k where k.person_id = p.id
            and k.duration_seconds >= ${ENGAGED_CALL_SECONDS} and k.answered_at is not null
            and k.started_at > ${since}::timestamptz) as long_call
        from app.people p
        where p.id = ${personId} and p.workspace_id = ${scope.workspaceId}`,
  );
  if (!e || e.archived || e.own || e.open_deal || e.recently_won || e.visit_ahead) return;
  const texting = e.inbound >= ENGAGED_INBOUND && (!!e.replied_by || e.ai_replied);
  if (!texting && !e.long_call) return;
  const channel = str(p['channel']);
  const kind =
    event.eventType.startsWith('call.') || (!texting && e.long_call)
      ? 'call'
      : channel === 'email'
        ? 'email'
        : channel === 'sms'
          ? 'text'
          : null;
  const target = await intakeTarget(tx, scope.workspaceId, kind);
  if (!target.createLead) return;
  const name = `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || 'New customer';
  const how = kind === 'call' ? 'call' : 'conversation';
  try {
    await executeCommandIn(
      tx,
      leadCreate,
      {
        workspaceId: scope.workspaceId,
        title: `${name} (${how})`,
        personId,
        ...(target.pipelineId && target.stageId
          ? { pipelineId: target.pipelineId, stageId: target.stageId }
          : {}),
        source: kind === 'call' ? 'A call with you' : 'A conversation with you',
        assigneeUserId:
          (kind === 'call' ? e.call_by : e.replied_by) ?? e.replied_by ?? e.call_by ?? null,
      },
      systemActor(scope),
      workerMeta(event.correlationId, event.id),
    );
  } catch (err) {
    ctx.log.info({ err, personId }, 'no lead made for an engaged customer');
  }
};
