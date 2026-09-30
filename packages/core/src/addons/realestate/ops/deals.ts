/**
 * A deal's life (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Deals"): opening one, moving it forward, the named
 * moves back (an offer lost, a contract terminated), closing, ending and reopening it, and the facts its duties
 * depend on. Each change is a line in the deal's history and its timeline, and settles its duties before it ends
 * (./engine.ts).
 */
import { and, asc, eq, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { leads, pipelineStages } from '@hfos/db/schema';
import { customRecordCreate } from '../../../commands/custom-record';
import { leadMoveStage } from '../../../commands/lead.move_stage';
import { relationshipCreate } from '../../../commands/relationship';
import { HfosError } from '../../../errors';
import { scopeCan, executeCommandWithin } from '../../../kernel/execute';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import {
  CATALOG_VERSION,
  DEAL_FACTS,
  factsHold,
  triggerOf,
  type DealEvent,
  type DealFact,
  type DutyDef,
} from '../catalog';
import { KEY_DATES, type KeyDateKey } from '../dates/key-dates';
import { realestateAddon } from '../manifest';
import { WIRE_CHECK_KEY } from '../own-duties';
import {
  BUYER_STAGES,
  FIRST_STAGE,
  LISTING_EXITS,
  LISTING_STAGES,
  isStageOf,
  stageAfterEvent,
  stageMove,
  stagesBetween,
  underContract,
  type DealSide,
  type DealStage,
} from '../states';
import { dealRoles, deals, templateSets, termEntries } from '../tables';
import { isTermKey, termDef } from '../terms';
import { EVENT_WORDS, PROPERTY_TYPE_KEY, sideWords } from '../words';
import {
  DealChangeOutput,
  DealCloseInput,
  DealCloseOutput,
  DealEndInput,
  DealMoveStageInput,
  DealOfferLostInput,
  DealOpenInput,
  DealOpenOutput,
  DealRecordEventInput,
  DealReopenInput,
  DealSetFactsInput,
  DealSetFactsOutput,
  DealTerminateInput,
  DEAL_FACT_KEYS,
} from '../schemas';
import {
  dealLine,
  historyLine,
  inWorkspace,
  kindIds,
  loadDeal,
  relationshipTypeId,
  requireNotArchived,
  requireOpen,
  stageWords,
  type Deal,
} from './common';
import { openWork, type Work } from './engine';

/** A side's run of stages, without a listing's ends. */
const runOf = (side: DealSide): readonly DealStage[] =>
  side === 'buyer' ? BUYER_STAGES : LISTING_STAGES;
const indexIn = (side: DealSide, stage: DealStage) =>
  (runOf(side) as readonly string[]).indexOf(stage);
/** After closing: where only a closed deal goes. */
const afterClosing = (side: DealSide, stage: DealStage) =>
  indexIn(side, stage) > indexIn(side, 'closing');

const badStage = (side: DealSide, stage: string) =>
  HfosError.rule(
    'realestate_bad_stage',
    400,
    `“${stage}” isn’t a stage of a ${sideWords(side)}. Pick one of its stages.`,
  );

const changed = (w: Work, stage: DealStage) => ({
  dealId: w.deal.recordId,
  stage,
  dutiesCreated: w.counts.created,
  dutiesCancelled: w.counts.cancelled,
});

async function setStage(
  ctx: CommandContext,
  w: Work,
  next: Partial<Pick<Deal, 'stage' | 'outcome' | 'outcomeReason'>> & { outcomeAt?: Date | null },
) {
  const d = w.deal;
  await ctx.tx
    .update(deals)
    .set({
      ...(next.stage && next.stage !== d.stage ? { stage: next.stage, stageEnteredAt: w.at } : {}),
      ...('outcome' in next
        ? {
            outcome: next.outcome ?? null,
            outcomeAt: next.outcome ? w.at : null,
            outcomeReason: next.outcomeReason ?? null,
          }
        : {}),
      updatedAt: w.at,
    })
    .where(and(eq(deals.recordId, d.recordId), eq(deals.workspaceId, d.workspaceId)));
  w.update({ ...next });
}

/**
 * Sets a deal's facts: duties that no longer apply and nobody has started are cancelled, and duties a new fact
 * brings are created for every moment the deal has already had (its stages so far, its confirmed dates, its events
 * since it last went back to looking).
 */
export async function applyFacts(
  ctx: CommandContext,
  w: Work,
  next: readonly DealFact[],
): Promise<{ added: DealFact[]; removed: DealFact[] }> {
  const deal = w.deal;
  const before = new Set(deal.facts);
  const after = new Set(next);
  const added = DEAL_FACT_KEYS.filter((f) => after.has(f) && !before.has(f));
  const removed = DEAL_FACT_KEYS.filter((f) => before.has(f) && !after.has(f));
  if (!added.length && !removed.length) return { added, removed };
  const facts = DEAL_FACT_KEYS.filter((f) => after.has(f));
  await ctx.tx
    .update(deals)
    .set({ facts, updatedAt: w.at })
    .where(and(eq(deals.recordId, deal.recordId), eq(deals.workspaceId, deal.workspaceId)));
  w.update({ facts });
  if (removed.length)
    await w.cancel(
      (d) =>
        (d.status === 'draft' || d.status === 'not_started') &&
        !factsHold(d.definition as unknown as DutyDef, after),
      `No longer applies: ${removed.map((f) => `“${DEAL_FACTS[f]}”`).join(', ')} ${removed.length > 1 ? 'were' : 'was'} taken off.`,
    );
  // Only a deal still being worked gets new duties.
  if (added.length && !deal.outcome) await replayMoments(w, { forFacts: new Set<DealFact>(added) });
  return { added, removed };
}

/**
 * Creates, for every moment the deal has already had (the stages it entered up to where it is, its confirmed dates,
 * its moments since it last went back to looking), the duties it's missing: those a new fact calls for, or those a
 * newer duty list has.
 */
export async function replayMoments(
  w: Work,
  opts: { readonly forFacts?: ReadonlySet<DealFact>; readonly onlyNew?: boolean },
): Promise<void> {
  const deal = w.deal;
  const here = indexIn(deal.side, deal.stage);
  for (const [stage, times] of w.past.entered) {
    const at = indexIn(deal.side, stage);
    if (at < 0 || at > here) continue;
    await w.create({ on: 'stage', stage }, { round: times > 1 ? 'later' : 'first', ...opts });
  }
  for (const key of Object.keys(w.keyDates) as KeyDateKey[])
    if (w.keyDates[key]?.confirmed) await w.create({ on: 'dates', key }, opts);
  for (const event of w.past.eventsSinceRestart) await w.create({ on: 'event', event }, opts);
}

/**
 * Sets aside the terms of a contract that's over, or an offer that was lost: they stay in the history, and the
 * next contract's dates start fresh.
 */
async function retireContractTerms(ctx: CommandContext, w: Work): Promise<void> {
  const live = await ctx.tx
    .select({ id: termEntries.id, key: termEntries.key })
    .from(termEntries)
    .where(
      and(
        eq(termEntries.dealRecordId, w.deal.recordId),
        dsql`${termEntries.supersededAt} is null and ${termEntries.rejectedAt} is null`,
      ),
    );
  const ids = live
    .filter((e) => isTermKey(e.key) && (termDef(e.key).contract || e.key === 'offer_expiration'))
    .map((e) => e.id);
  if (!ids.length) return;
  await rows(
    ctx.tx,
    sql`update addon_realestate.term_entries set superseded_at = ${w.at.toISOString()}
        where id = any(${`{${ids.join(',')}}`}::uuid[])`,
  );
  await w.reloadTerms();
}

/** Unfinished duties of the stages after this one, and of the contract's dates and moments. */
const aheadOf = (w: Work, stage: DealStage) => {
  const here = indexIn(w.deal.side, stage);
  return (d: Work['duties'][number]) => {
    const [kind, what] = d.startedBy.split(':') as [string, string];
    if (kind === 'dates')
      return what === 'offer_expiration' || !!KEY_DATES[what as KeyDateKey]?.contract;
    if (kind === 'event') return (CONTRACT_EVENTS as readonly string[]).includes(what);
    return kind === 'stage' && indexIn(w.deal.side, what as DealStage) > here;
  };
};

/** The moments that belong to one offer or contract, whose duties end with it. */
const CONTRACT_EVENTS = [
  'offer_received',
  'inspection_report',
  'repair_request',
  'repairs_agreed',
  'low_appraisal',
  'amendment',
] as const satisfies readonly DealEvent[];

// ---------- opening ----------

export const dealOpen = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.open',
  description:
    'Start a buyer deal or a listing: kept to the people on it, with its client, property and Pipeline lead, and the duties of the stage it starts in and every stage before it.',
  risk: 1,
  input: DealOpenInput,
  output: DealOpenOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_open_deal',
    description:
      'Start a buyer deal or a listing for a customer or Pipeline lead. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.deal.opened'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const first = FIRST_STAGE[input.side];
    const stage = input.stage ?? first;
    if (!isStageOf(input.side, stage) || indexIn(input.side, stage) < 0)
      throw badStage(input.side, stage);
    if (afterClosing(input.side, stage))
      throw HfosError.rule(
        'realestate_close_first',
        400,
        'A deal starts at Closing at the latest. Start it there, then mark it closed.',
      );
    if (input.propertyId && input.newPropertyAddress)
      throw HfosError.validation([
        { path: 'propertyId', message: 'Pick a property, or type a new address, not both.' },
      ]);
    const main = input.mainAgentUserId ?? me;
    if (main !== me && !scopeCan(ctx.scope, 'records.assign'))
      throw HfosError.rule(
        'record_team_not_yours',
        403,
        'Only an owner or admin opens a deal for someone else. Open it yourself, or ask one of them.',
      );
    const kinds = await kindIds(ctx);

    // The lead it came from: its customer is the client unless another is named.
    let lead: { id: string; personId: string | null } | null = null;
    if (input.leadId) {
      const [l] = await ctx.tx
        .select({ id: leads.id, personId: leads.personId })
        .from(leads)
        .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ws)));
      if (!l)
        throw HfosError.notFound(
          'That lead isn’t there anymore. It may have been deleted. Refresh and try again.',
        );
      lead = l;
    }
    const client = input.clientPersonId ?? lead?.personId ?? null;

    const made = await executeCommandWithin(ctx, customRecordCreate, {
      workspaceId: ws,
      typeId: kinds.deal,
      name: input.name,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(main ? { ownerUserId: main } : {}),
      ...(client
        ? {
            relateTo: {
              relationshipTypeId: await relationshipTypeId(ctx, 'realestate_client'),
              recordId: client,
              side: 'b' as const,
            },
          }
        : {}),
    });
    const dealId = made.output.customRecordId;
    // New deals follow the business's newest published duty list, if it has one (step 12).
    const [set] = await ctx.tx
      .select({ id: templateSets.id, catalogVersion: templateSets.catalogVersion })
      .from(templateSets)
      .where(eq(templateSets.workspaceId, ws))
      .orderBy(dsql`${templateSets.version} desc`)
      .limit(1);
    const facts = DEAL_FACT_KEYS.filter((f) => input.facts.includes(f));
    await ctx.tx.insert(deals).values({
      recordId: dealId,
      workspaceId: ws,
      side: input.side,
      stage,
      leadId: lead?.id ?? null,
      facts,
      templateSetId: set?.id ?? null,
      catalogVersion: set?.catalogVersion ?? CATALOG_VERSION,
      createdBy: me,
    });
    if (main)
      await ctx.tx
        .insert(dealRoles)
        .values({ workspaceId: ws, dealRecordId: dealId, userId: main, role: 'agent' });

    let propertyId = input.propertyId ?? null;
    if (input.newPropertyAddress)
      propertyId = (
        await executeCommandWithin(ctx, customRecordCreate, {
          workspaceId: ws,
          typeId: kinds.property,
          name: input.newPropertyAddress,
        })
      ).output.customRecordId;
    if (propertyId)
      await executeCommandWithin(ctx, relationshipCreate, {
        workspaceId: ws,
        relationshipTypeId: await relationshipTypeId(ctx, PROPERTY_TYPE_KEY),
        aId: dealId,
        bId: propertyId,
      });

    const passed = stagesBetween(input.side, first, stage);
    const deal = await loadDeal(ctx, dealId, { lock: true });
    const w = await openWork(ctx, deal);
    await historyLine(ctx, deal, 'opened', {
      after: { side: input.side, stage, passed, facts, clientPersonId: client, leadId: lead?.id },
    });
    await w.enterStages(passed);
    await w.settle();
    const eventId = await ctx.emit({
      type: 'realestate.deal.opened',
      entityType: 'custom_record',
      entityId: dealId,
      payload: {
        name: input.name,
        side: input.side,
        stage,
        clientPersonId: client,
        leadId: lead?.id ?? null,
        propertyId,
        duties: w.counts.created,
      },
      after: { name: input.name, side: input.side, stage },
    });
    // On the client's and the lead's timelines too, sealed with the deal so only its people see it there.
    await dealLine(ctx, deal, `started a ${sideWords(input.side)}, ${input.name}`, {
      eventId,
      personId: client,
      leadId: lead?.id ?? null,
    });
    return { dealId, propertyId, dutiesCreated: w.counts.created };
  },
});

// ---------- moving on ----------

export const dealMoveStage = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.move_stage',
  description:
    'Move a deal forward to a later stage. Every stage it passes gets its duties too. It moves back only through what happened (an offer lost, a contract terminated, a listing back on the market).',
  risk: 1,
  input: DealMoveStageInput,
  output: DealChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_move_deal',
    description: 'Move a deal forward to a later stage. Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.deal.stage_changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const to = input.stage;
    if (!isStageOf(deal.side, to)) throw badStage(deal.side, to);
    if (deal.outcome && !(deal.outcome === 'closed' && afterClosing(deal.side, to)))
      requireOpen(deal);
    if ((LISTING_EXITS as readonly string[]).includes(to))
      throw HfosError.rule(
        'realestate_stage_needs_event',
        409,
        `A listing is ${stageWords(to).toLowerCase()} by ending it: use End listing on ${deal.name}’s page.`,
      );
    const how = stageMove(deal.side, deal.stage, to);
    if (how === 'same')
      return { dealId: deal.recordId, stage: to, dutiesCreated: 0, dutiesCancelled: 0 };
    if (how !== 'forward')
      throw HfosError.rule(
        'realestate_stage_back',
        409,
        deal.side === 'buyer'
          ? `A deal moves back only through what happened. On ${deal.name}’s page, record the lost offer or the terminated contract, and it goes back to the right stage.`
          : `A listing moves back only through what happened. On ${deal.name}’s page, record the terminated contract, or put it back on the market.`,
      );
    if (afterClosing(deal.side, to) && deal.outcome !== 'closed')
      throw HfosError.rule(
        'realestate_close_first',
        409,
        `Mark ${deal.name} closed first (Close deal on its page), then move it on.`,
      );
    const passed = stagesBetween(deal.side, deal.stage, to).slice(1);
    const w = await openWork(ctx, deal);
    await setStage(ctx, w, { stage: to });
    await historyLine(ctx, deal, 'stage', {
      before: { stage: deal.stage },
      after: { stage: to, passed },
      note: input.note ?? null,
    });
    await w.enterStages(passed);
    await w.settle();
    const eventId = await ctx.emit({
      type: 'realestate.deal.stage_changed',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, from: deal.stage, to, passed, duties: w.counts.created },
      before: { name: deal.name, stage: deal.stage },
      after: { name: deal.name, stage: to },
    });
    await dealLine(ctx, deal, `moved this deal to ${stageWords(to)}`, {
      eventId,
      body: input.note ?? null,
    });
    return changed(w, to);
  },
});

/** Whether any duty of this side's list is started by the moment. */
const sideHasEvent = (w: Work, event: DealEvent) =>
  w.list.some((def) => {
    const t = triggerOf(def as unknown as DutyDef, w.deal.side);
    return t?.on === 'event' && t.event === event;
  });

export const dealRecordEvent = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.record_event',
  description:
    'Record something that happened on a deal (an offer came in, the inspection report is in, a repair request, repairs agreed, a low appraisal, an amendment, a changed search), which brings its duties.',
  risk: 1,
  input: DealRecordEventInput,
  output: DealChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_record_deal_moment',
    description:
      'Record something that happened on a deal (an offer in, the inspection report, a repair request, an amendment…). Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.deal.event_recorded'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const w = await openWork(ctx, deal);
    if (!sideHasEvent(w, input.event))
      throw HfosError.rule(
        'realestate_event_not_here',
        400,
        `On a ${sideWords(deal.side)}, nothing follows when ${EVENT_WORDS[input.event]}, so there’s nothing to record here.`,
      );
    await historyLine(ctx, deal, 'event', {
      after: { events: [input.event] },
      note: input.note ?? null,
    });
    await w.happen([input.event]);
    await w.settle();
    const eventId = await ctx.emit({
      type: 'realestate.deal.event_recorded',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, event: input.event, duties: w.counts.created },
      after: { name: deal.name, event: input.event },
    });
    await dealLine(ctx, deal, `recorded that ${EVENT_WORDS[input.event]}`, {
      eventId,
      body: input.note ?? null,
    });
    return changed(w, deal.stage);
  },
});

// ---------- the moves back ----------

export const dealOfferLost = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.record_offer_lost',
  description:
    'A buyer’s offer was turned down or withdrawn: the deal goes back to Touring, the offer’s terms and unfinished duties are set aside (kept in history), and the next steps are added.',
  risk: 2,
  input: DealOfferLostInput,
  output: DealChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.offer_lost'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const to = stageAfterEvent(deal.side, 'offer_lost', deal.stage);
    if (!to)
      throw HfosError.rule(
        'realestate_no_offer',
        409,
        deal.side === 'listing'
          ? `A listing doesn’t lose an offer this way. If ${deal.name}’s contract ended, record it as terminated.`
          : `${deal.name} is at ${stageWords(deal.stage)}, with no offer out. An offer is lost from Offer or Negotiation.`,
      );
    const w = await openWork(ctx, deal);
    const reason = `The offer was lost: ${input.reason}`;
    await w.cancel(aheadOf(w, to), reason);
    await retireContractTerms(ctx, w);
    await setStage(ctx, w, { stage: to });
    await historyLine(ctx, deal, 'offer_lost', {
      before: { stage: deal.stage },
      after: { stage: to, events: ['offer_lost', 'deal_failed'] },
      note: input.reason,
    });
    await w.happen(['offer_lost', 'deal_failed']);
    await w.settle();
    const eventId = await ctx.emit({
      type: 'realestate.deal.offer_lost',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, from: deal.stage, to, reason: input.reason },
      before: { name: deal.name, stage: deal.stage },
      after: { name: deal.name, stage: to },
    });
    await dealLine(ctx, deal, `recorded that the offer was lost`, {
      eventId,
      body: input.reason,
      tone: 'warning',
    });
    return changed(w, to);
  },
});

export const dealTerminate = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.terminate',
  description:
    'A contract fell through: a buyer deal goes back to Searching and a listing back to Active, the contract’s terms and unfinished duties are set aside (kept in history), and the steps that follow a termination are added.',
  risk: 3,
  input: DealTerminateInput,
  output: DealChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.terminated'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const to = stageAfterEvent(deal.side, 'terminated', deal.stage);
    if (!to)
      throw HfosError.rule(
        'realestate_not_under_contract',
        409,
        `${deal.name} isn’t under contract, so there’s no contract to end.`,
      );
    const w = await openWork(ctx, deal);
    await w.cancel(aheadOf(w, to), `The contract was terminated: ${input.reason}`);
    await retireContractTerms(ctx, w);
    await setStage(ctx, w, { stage: to });
    await historyLine(ctx, deal, 'terminated', {
      before: { stage: deal.stage },
      after: { stage: to, events: ['terminated', 'deal_failed'] },
      note: input.reason,
    });
    await w.happen(['terminated', 'deal_failed']);
    await w.settle();
    const eventId = await ctx.emit({
      type: 'realestate.deal.terminated',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, from: deal.stage, to, reason: input.reason },
      before: { name: deal.name, stage: deal.stage },
      after: { name: deal.name, stage: to },
    });
    await dealLine(ctx, deal, `recorded that the contract was terminated`, {
      eventId,
      body: input.reason,
      tone: 'danger',
    });
    return changed(w, to);
  },
});

// ---------- closing and ending ----------

export const dealClose = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.close',
  description:
    'Mark a deal at Closing closed: a buyer deal moves to Possession and a listing to Sold, the after-closing duties are added, and its Pipeline lead can be marked won too.',
  risk: 2,
  input: DealCloseInput,
  output: DealCloseOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.closed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    if (deal.stage !== 'closing')
      throw HfosError.rule(
        'realestate_not_closing',
        409,
        `${deal.name} is at ${stageWords(deal.stage)}. Move it to Closing first, then mark it closed.`,
      );
    const to: DealStage = deal.side === 'buyer' ? 'possession' : 'sold';
    const w = await openWork(ctx, deal);
    await setStage(ctx, w, { stage: to, outcome: 'closed', outcomeReason: null });
    await historyLine(ctx, deal, 'closed', {
      before: { stage: deal.stage },
      after: { stage: to, passed: [to], events: ['closed', 'deal_ended'] },
      note: input.note ?? null,
    });
    await w.enterStages([to]);
    await w.happen(['closed', 'deal_ended']);
    await w.settle();

    let leadWon = false;
    if (input.markLeadWon && deal.leadId) {
      const [lead] = await ctx.tx
        .select({
          status: leads.status,
          pipelineId: leads.pipelineId,
          archivedAt: leads.archivedAt,
        })
        .from(leads)
        .where(eq(leads.id, deal.leadId));
      if (lead && lead.status === 'open' && !lead.archivedAt) {
        const [won] = await ctx.tx
          .select({ id: pipelineStages.id })
          .from(pipelineStages)
          .where(
            and(eq(pipelineStages.pipelineId, lead.pipelineId), eq(pipelineStages.kind, 'won')),
          )
          .orderBy(asc(pipelineStages.position))
          .limit(1);
        if (won) {
          await executeCommandWithin(ctx, leadMoveStage, {
            workspaceId: ctx.scope.workspaceId!,
            leadId: deal.leadId,
            stageId: won.id,
          });
          leadWon = true;
        }
      }
    }
    const eventId = await ctx.emit({
      type: 'realestate.deal.closed',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, side: deal.side, leadId: deal.leadId, leadWon },
      before: { name: deal.name, stage: deal.stage },
      after: { name: deal.name, stage: to, outcome: 'closed' },
    });
    await dealLine(ctx, deal, 'marked this deal closed', {
      eventId,
      body: input.note ?? null,
      tone: 'success',
    });
    return { ...changed(w, to), leadWon };
  },
});

export const dealEnd = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.end',
  description:
    'End a deal that won’t close: a listing withdrawn, expired or cancelled, or a buyer who stopped looking or went elsewhere. Its unfinished duties are cancelled with the reason; it can be reopened.',
  risk: 3,
  input: DealEndInput,
  output: DealChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.ended'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    let to: DealStage = deal.stage;
    let events: DealEvent[];
    if (deal.side === 'listing') {
      if (input.how === 'lost')
        throw HfosError.validation([
          { path: 'how', message: 'A listing ends withdrawn, expired or cancelled.' },
        ]);
      const next = stageAfterEvent('listing', input.how, deal.stage);
      if (!next)
        throw underContract('listing', deal.stage)
          ? HfosError.rule(
              'realestate_end_under_contract',
              409,
              `${deal.name} is under contract. Record the contract as terminated first, then end the listing.`,
            )
          : HfosError.rule(
              'realestate_end_not_signed',
              409,
              `${deal.name} isn’t a signed listing yet, so it can’t be withdrawn or expire. End it as cancelled instead.`,
            );
      to = next;
      events = ['listing_ended', 'deal_ended'];
    } else {
      if (input.how !== 'lost')
        throw HfosError.validation([
          {
            path: 'how',
            message: 'A buyer deal ends as lost: the client stopped looking or went elsewhere.',
          },
        ]);
      if (indexIn('buyer', deal.stage) >= indexIn('buyer', 'under_contract'))
        throw HfosError.rule(
          'realestate_end_under_contract',
          409,
          `${deal.name} is under contract. Record the contract as terminated first, then end the deal.`,
        );
      events = ['deal_ended'];
    }
    const outcome = deal.side === 'listing' ? 'ended' : 'lost';
    const w = await openWork(ctx, deal);
    // A wire check stays: a changed wire is settled only by a person's phone check, deal or no deal.
    await w.cancel(
      (d) => d.dutyKey !== WIRE_CHECK_KEY,
      `The ${sideWords(deal.side)} ended: ${input.reason}`,
    );
    await setStage(ctx, w, { stage: to, outcome, outcomeReason: input.reason });
    await historyLine(ctx, deal, 'ended', {
      before: { stage: deal.stage },
      after: { stage: to, outcome, how: input.how, events },
      note: input.reason,
    });
    await w.happen(events);
    await w.settle();
    const eventId = await ctx.emit({
      type: 'realestate.deal.ended',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, how: input.how, reason: input.reason },
      before: { name: deal.name, stage: deal.stage },
      after: { name: deal.name, stage: to, outcome },
    });
    await dealLine(
      ctx,
      deal,
      deal.side === 'listing'
        ? `marked this listing ${stageWords(to).toLowerCase()}`
        : 'marked this deal lost',
      { eventId, body: input.reason, tone: 'muted' },
    );
    return changed(w, to);
  },
});

export const dealReopen = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.reopen',
  description:
    'Reopen a deal that ended: a listing goes back on the market (Active) and a buyer deal back to work where it was, each with its stage’s duties again.',
  risk: 2,
  input: DealReopenInput,
  output: DealChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.deal.reopened'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    if (!deal.outcome)
      return { dealId: deal.recordId, stage: deal.stage, dutiesCreated: 0, dutiesCancelled: 0 };
    if (deal.outcome === 'closed')
      throw HfosError.rule(
        'realestate_deal_closed',
        409,
        `${deal.name} closed, and a closed deal stays closed. Start a new deal for what comes next.`,
      );
    const to =
      deal.side === 'listing'
        ? (stageAfterEvent('listing', 'back_on_market', deal.stage) ?? 'active')
        : deal.stage;
    const w = await openWork(ctx, deal);
    await setStage(ctx, w, { stage: to, outcome: null, outcomeReason: null });
    await historyLine(ctx, deal, 'reopened', {
      before: { stage: deal.stage, outcome: deal.outcome },
      after: { stage: to, passed: [to] },
      note: input.reason,
    });
    await w.enterStages([to]);
    await w.settle();
    const eventId = await ctx.emit({
      type: 'realestate.deal.reopened',
      entityType: 'custom_record',
      entityId: deal.recordId,
      payload: { name: deal.name, from: deal.stage, to, reason: input.reason },
      before: { name: deal.name, stage: deal.stage, outcome: deal.outcome },
      after: { name: deal.name, stage: to, outcome: null },
    });
    await dealLine(
      ctx,
      deal,
      deal.side === 'listing' ? 'put this listing back on the market' : 'reopened this deal',
      { eventId, body: input.reason },
    );
    return changed(w, to);
  },
});

// ---------- facts ----------

export const dealSetFacts = defineAddonCommand(realestateAddon, {
  name: 'realestate.deal.set_facts',
  description:
    'Say what’s true of a deal or its home (financed, an HOA, a well, septic, solar, open houses, a backup offer…). Duties a fact brings are added; ones that no longer apply and haven’t been started are cancelled.',
  risk: 1,
  input: DealSetFactsInput,
  output: DealSetFactsOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_set_deal_facts',
    description:
      'Say what’s true of a deal or its home (financed, HOA, well, septic…). Asks the person first.',
    autonomy: 'confirm',
  },
  emits: ['realestate.deal.facts_changed'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    const w = await openWork(ctx, deal);
    const { added, removed } = await applyFacts(ctx, w, input.facts);
    if (added.length || removed.length) {
      await historyLine(ctx, deal, 'facts', {
        before: { facts: deal.facts },
        after: { facts: w.deal.facts, added, removed },
      });
      await w.settle();
      const eventId = await ctx.emit({
        type: 'realestate.deal.facts_changed',
        entityType: 'custom_record',
        entityId: deal.recordId,
        payload: { name: deal.name, added, removed },
        before: { name: deal.name, facts: deal.facts },
        after: { name: deal.name, facts: w.deal.facts },
      });
      const said = [
        ...added.map((f) => `added “${DEAL_FACTS[f]}”`),
        ...removed.map((f) => `took off “${DEAL_FACTS[f]}”`),
      ].join('; ');
      await dealLine(ctx, deal, `changed what’s true of this deal: ${said}`.slice(0, 300), {
        eventId,
      });
    }
    return {
      dealId: deal.recordId,
      facts: [...w.deal.facts],
      dutiesCreated: w.counts.created,
      dutiesCancelled: w.counts.cancelled,
    };
  },
});

export const dealLifeCommands = [
  dealOpen,
  dealMoveStage,
  dealRecordEvent,
  dealOfferLost,
  dealTerminate,
  dealClose,
  dealEnd,
  dealReopen,
  dealSetFacts,
];
