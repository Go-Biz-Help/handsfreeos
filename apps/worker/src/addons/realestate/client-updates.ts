/**
 * Client updates in the worker (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "The Assistant and client updates"):
 * the draft written from the deal's own facts, both fair-housing checks, and a draft offered at each milestone the
 * business keeps on. The model's use is counted as the add-on's. Nothing here sends anything: the agent does.
 */
import { KEY_DATES } from '@hfos/core/addons/realestate/dates/key-dates';
import { checkWords, FAIR_HOUSING_WORDS_VERSION } from '@hfos/core/addons/realestate/fair-housing';
import {
  statusEmailChecked,
  statusEmailDrafted,
  statusEmailRequest,
  textHashOf,
} from '@hfos/core/addons/realestate/ops/client-updates';
import { termEntriesOf } from '@hfos/core/addons/realestate/ops/engine';
import {
  CLIENT_UPDATE_SCHEMA,
  CLIENT_UPDATE_SYSTEM,
  ClientUpdateAnswer,
  clientUpdatePrompt,
  FAIR_HOUSING_SCHEMA,
  FAIR_HOUSING_SYSTEM,
  FairHousingAnswer,
  fairHousingPrompt,
  type ClientUpdateFacts,
} from '@hfos/core/addons/realestate/prompts';
import { STAGE_LABELS, type DealStage } from '@hfos/core/addons/realestate/states';
import { keyDatesOf, termsNow } from '@hfos/core/addons/realestate/terms';
import { executeCommand, fmtDateLong, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import type { AddonEventContext, AddonScopeContext } from '../types';

const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;
const usage = (ctx: AddonScopeContext) => ({ source: 'addon' as const, addonId: ctx.manifest.id });

/** What the model is told about a deal: its facts, never its notes. */
async function factsOf(
  ctx: AddonScopeContext,
  dealId: string,
  personId: string | null,
  milestone: string,
): Promise<ClientUpdateFacts | null> {
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const [deal] = await rows<{
      side: 'buyer' | 'listing';
      stage: string;
      business: string;
      agent: string | null;
      address: string | null;
    }>(
      tx,
      sql`select d.side, d.stage, w.name as business,
            coalesce(nullif(u.full_name, ''), u.email::text) as agent,
            (select pr.name from app.relationships rel
               join app.relationship_types rt on rt.id = rel.type_id and rt.addon_key = 'realestate_property_of'
               join app.custom_records pr on pr.id = rel.b_custom_record_id
               where rel.a_custom_record_id = d.record_id order by rel.created_at desc limit 1) as address
          from addon_realestate.deals d
          join app.custom_records r on r.id = d.record_id
          join app.workspaces w on w.id = d.workspace_id
          left join app.users u on u.id = r.owner_user_id
          where d.record_id = ${dealId}`,
    );
    if (!deal) return null;
    const [client] = personId
      ? await rows<{ first_name: string }>(
          tx,
          sql`select first_name from app.people where id = ${personId}`,
        )
      : [];
    const keyDates = keyDatesOf(termsNow(await termEntriesOf({ tx }, dealId)));
    const done = await rows<{ title: string }>(
      tx,
      sql`select title from addon_realestate.duties
          where deal_record_id = ${dealId} and status = 'completed' and not exception
            and finished_at > now() - interval '21 days'
          order by finished_at desc limit 6`,
    );
    const next = await rows<{ title: string; due_date: string | null }>(
      tx,
      sql`select title, due_date::text from addon_realestate.duties
          where deal_record_id = ${dealId}
            and status in ('not_started', 'in_progress', 'waiting_external', 'blocked')
            and duty_key <> 'W-00' and (due_date is null or due_date <= current_date + 21)
          order by due_date asc nulls last limit 6`,
    );
    return {
      business: deal.business,
      agentName: deal.agent ?? 'Your agent',
      clientFirstName: client?.first_name?.trim() || 'there',
      clientIs: deal.side === 'buyer' ? 'buying' : 'selling',
      address: deal.address,
      stage: STAGE_LABELS[deal.stage as DealStage] ?? deal.stage,
      milestone,
      confirmedDates: (Object.keys(keyDates) as (keyof typeof keyDates)[])
        .filter((k) => keyDates[k]?.confirmed)
        .map((k) => ({ what: KEY_DATES[k].label, when: fmtDateLong(keyDates[k]!.date) })),
      done: done.map((d) => d.title),
      next: next.map((d) => ({ what: d.title, due: d.due_date ? fmtDateLong(d.due_date) : null })),
    };
  });
}

/** The model's fair-housing read of an email; unavailable when it can't be asked. */
async function modelCheck(ctx: AddonScopeContext, subject: string, body: string) {
  try {
    const { value, model } = await askStructured(ctx, ctx.scope, {
      system: FAIR_HOUSING_SYSTEM,
      messages: [{ role: 'user', content: fairHousingPrompt(subject, body) }],
      schema: FAIR_HOUSING_SCHEMA,
      zod: FairHousingAnswer,
      maxTokens: 800,
      usage: usage(ctx),
    });
    return {
      source: 'model' as const,
      version: model,
      status: value.flags.length ? ('flagged' as const) : ('passed' as const),
      flags: value.flags,
    };
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // The draft still has the fixed list's check; the agent reads it before it goes.
    return {
      source: 'model' as const,
      version: 'unavailable',
      status: 'unavailable' as const,
      flags: [],
    };
  }
}

/** `realestate.status_email.requested`: the draft, and both of its checks. */
export async function draftRequested(ctx: AddonEventContext): Promise<void> {
  const draftId = payloadOf(ctx)['draftId'];
  if (typeof draftId !== 'string' || !ctx.event.entityId) return;
  const [draft] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ status: string; person_id: string | null; milestone: string }>(
      tx,
      sql`select status, person_id, milestone from addon_realestate.drafts where id = ${draftId}`,
    ),
  );
  if (!draft || draft.status !== 'drafting') return;
  const done = (input: Record<string, unknown>) =>
    executeCommand(
      ctx.db,
      statusEmailDrafted,
      { workspaceId: ctx.scope.workspaceId, draftId, ...input },
      ctx.actor,
      ctx.meta,
    );
  const facts = await factsOf(ctx, ctx.event.entityId, draft.person_id, draft.milestone);
  if (!facts) return;
  let written: { subject: string; body: string; model: string };
  try {
    const { value, model } = await askStructured(ctx, ctx.scope, {
      system: CLIENT_UPDATE_SYSTEM,
      messages: [{ role: 'user', content: clientUpdatePrompt(facts) }],
      schema: CLIENT_UPDATE_SCHEMA,
      zod: ClientUpdateAnswer,
      maxTokens: 900,
      usage: usage(ctx),
    });
    written = { ...value, model };
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // A busy model is worth another try; anything else is said on the draft.
    if (e.retryable && ctx.attempt < 3) throw e;
    await done({ failure: e.message });
    return;
  }
  const words = checkWords(`${written.subject}\n${written.body}`);
  await done({
    subject: written.subject,
    body: written.body,
    model: written.model,
    facts,
    checks: [
      {
        source: 'words',
        version: FAIR_HOUSING_WORDS_VERSION,
        status: words.length ? 'flagged' : 'passed',
        flags: words,
      },
      await modelCheck(ctx, written.subject, written.body),
    ],
  });
}

/** `realestate.status_email.saved`: the model reads the agent's edited words. */
export async function draftSaved(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  if (typeof p['draftId'] !== 'string') return;
  const [draft] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ status: string; subject: string | null; body: string | null }>(
      tx,
      sql`select status, subject, body from addon_realestate.drafts where id = ${p['draftId']}`,
    ),
  );
  if (!draft || draft.status !== 'ready' || !draft.subject || !draft.body) return;
  const check = await modelCheck(ctx, draft.subject, draft.body);
  await executeCommand(
    ctx.db,
    statusEmailChecked,
    {
      workspaceId: ctx.scope.workspaceId,
      draftId: p['draftId'],
      // The words it read: if they've changed again since, that save's own check follows.
      textHash: textHashOf(draft.subject, draft.body),
      version: check.version,
      status: check.status,
      flags: check.flags,
    },
    ctx.actor,
    ctx.meta,
  );
}

/** The milestones a client update is offered at, from the deal's own moments. */
function milestoneOf(ctx: AddonEventContext): string | null {
  const p = payloadOf(ctx);
  switch (ctx.event.eventType) {
    case 'realestate.deal.stage_changed':
      return p['to'] === 'under_contract'
        ? 'under_contract'
        : p['to'] === 'closing'
          ? 'clear_to_close'
          : null;
    case 'realestate.deal.event_recorded':
      return p['event'] === 'inspection_report' ? 'inspection_done' : null;
    case 'realestate.deal.closed':
      return 'closed';
    default:
      return null;
  }
}

/** A deal reached a milestone: a draft for the agent, if the business keeps that one on. */
export async function milestoneReached(ctx: AddonEventContext): Promise<void> {
  const milestone = milestoneOf(ctx);
  if (!milestone || !ctx.event.entityId) return;
  const [on] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ on: boolean | null }>(
      tx,
      sql`select (settings -> 'milestoneDrafts' ->> ${milestone})::boolean as on
          from app.addon_installations
          where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id}`,
    ),
  );
  if (on?.on === false) return;
  try {
    await executeCommand(
      ctx.db,
      statusEmailRequest,
      { workspaceId: ctx.scope.workspaceId, dealId: ctx.event.entityId, milestone },
      ctx.actor,
      ctx.meta,
    );
  } catch (e) {
    // No client with an email yet: nothing to draft, and nothing is wrong.
    if (e instanceof HfosError && e.rule === 'realestate_no_client_email') return;
    throw e;
  }
}

/** A milestone draft is ready: a card on the main agent's Home until it's sent or thrown away. */
export async function draftReady(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const draftId = p['draftId'];
  const dealId = ctx.event.entityId;
  // Someone who asked is looking at it already; a failed one is said on the deal.
  if (typeof draftId !== 'string' || !dealId || p['failed'] === true || p['requestedBy']) return;
  const agent = typeof p['mainAgentUserId'] === 'string' ? p['mainAgentUserId'] : null;
  await raiseAddonAlert(ctx, {
    key: `draft:${draftId}`,
    severity: 'info',
    title:
      `A client update for ${typeof p['name'] === 'string' ? p['name'] : 'a deal'} is ready to review`.slice(
        0,
        200,
      ),
    detail: 'Read it, change anything, and send it when it’s right.',
    href: `/a/realestate/deals/${dealId}`,
    permission: 'realestate.use',
    customRecordId: dealId,
    audienceUserIds: agent ? [agent] : [],
    assigneeUserId: agent,
    notify: true,
    email: false,
  });
}

export async function draftClosed(ctx: AddonEventContext): Promise<void> {
  const draftId = payloadOf(ctx)['draftId'];
  if (typeof draftId === 'string') await clearAddonAlert(ctx, `draft:${draftId}`, 'done');
}
