/**
 * The CMA, step 9 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"). Chris decided: the agent
 * adds the comps, HandsFreeOS works out a price range (pure `cma.ts`), and the AI drafts the summary for the agent to
 * check.
 *
 * - **A draft** takes comps, each with the agent's own adjustments and whether it's used; its range is worked out
 *   whenever it's read. **Finalizing** keeps the range as it is and locks the comps; reopening (before it's shared)
 *   unlocks them.
 * - **The summary** is drafted by the worker from the CMA's numbers only (`realestate.cma.request_summary`), or
 *   written by the agent. Every version of its words gets both fair-housing checks, as a client update's do: the
 *   word list at once, the model a moment later.
 * - **Sharing** puts it in the client's portal as a one-page summary. Refused until it's final, its summary has been
 *   read by both checks, and any flag is fixed or kept with a reason. Dollar amounts the CMA doesn't support are
 *   pointed out for the agent to check.
 */
import { and, asc, desc, eq, max } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  CMA_METHOD,
  cmaCompOf,
  cmaLine,
  cmaPage,
  cmaSubjectOf,
  cmaValues,
  MAX_COMPS,
  rangeWords,
} from '../cma';
import { checkWords, FAIR_HOUSING_WORDS_VERSION, type FairHousingFlag } from '../fair-housing';
import { addressKey } from '../homes';
import { realestateAddon } from '../manifest';
import {
  CmaAcknowledgeInput,
  CmaAddCompInput,
  CmaAddCompOutput,
  CmaChangeOutput,
  CmaGetOutput,
  CmaInput,
  CmaRemoveCompInput,
  CmaSaveSummaryInput,
  CmaSaveSummaryOutput,
  CmasInput,
  CmaSetSubjectInput,
  CmasOutput,
  CmaStartInput,
  CmaStartOutput,
  CmaSummaryCheckedInput,
  CmaSummaryDraftedInput,
  CmaUpdateCompInput,
} from '../schemas';
import { cmaComps, cmas, fairHousingChecks } from '../tables';
import { textHashOf } from './client-updates';
import {
  actorKind,
  actorUserId,
  dealLine,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  requireOpen,
  timeZoneOf,
  todayIn,
  userNames,
  type Ctx,
  type Deal,
} from './common';
import { addProof, PROOF_EVENTS } from './proof-hooks';
import { loadHome, requireBuyerSide } from './homes';
import { listingAddress, listingOf, listPriceOf } from './listing';

type Cma = typeof cmas.$inferSelect;
type CompRow = typeof cmaComps.$inferSelect;
type Check = typeof fairHousingChecks.$inferSelect;

export async function loadCma(
  ctx: Ctx,
  cmaId: string,
  lock = false,
): Promise<{ cma: Cma; deal: Deal }> {
  const q = ctx.tx
    .select()
    .from(cmas)
    .where(and(eq(cmas.id, cmaId), eq(cmas.workspaceId, ctx.scope.workspaceId!)));
  const [cma] = lock ? await q.for('update') : await q;
  if (!cma)
    throw HfosError.notFound(
      'That CMA isn’t there anymore, or you’re not on its deal. Refresh the deal’s CMAs.',
    );
  return { cma, deal: await loadDeal(ctx, cma.dealRecordId) };
}

export async function compsOf(ctx: Ctx, cmaId: string): Promise<CompRow[]> {
  return ctx.tx
    .select()
    .from(cmaComps)
    .where(eq(cmaComps.cmaId, cmaId))
    .orderBy(asc(cmaComps.position), asc(cmaComps.id));
}

/** Only a draft's comps and home change. */
export function requireDraft(cma: Cma): void {
  if (cma.status !== 'draft')
    throw HfosError.rule(
      'realestate_cma_final',
      409,
      cma.status === 'shared'
        ? `CMA ${cma.number} was shared with the client, so it stays as it is. Start another CMA from it to change it.`
        : `CMA ${cma.number} is final. Reopen it to change its comps.`,
    );
}

function requireNotShared(cma: Cma): void {
  if (cma.status === 'shared')
    throw HfosError.rule(
      'realestate_cma_final',
      409,
      `CMA ${cma.number} was shared with the client, so it stays as it is. Start another CMA from it to change it.`,
    );
}

// ---------- the summary's fair-housing checks ----------

async function checksOf(ctx: Ctx, cmaId: string): Promise<Check[]> {
  return ctx.tx
    .select()
    .from(fairHousingChecks)
    .where(eq(fairHousingChecks.cmaId, cmaId))
    .orderBy(desc(fairHousingChecks.checkedAt));
}

/** The checks of the summary as it is now, and the flags they raise. */
function currentChecks(cma: Cma, checks: readonly Check[]) {
  const hash = textHashOf(null, cma.summary);
  const now = checks.filter((c) => c.textHash === hash);
  const latest = (source: 'words' | 'model') => now.find((c) => c.source === source) ?? null;
  const words = latest('words');
  const model = latest('model');
  const flags: FairHousingFlag[] = [];
  const seen = new Set<string>();
  for (const c of [words, model])
    for (const f of (c?.flags ?? []) as FairHousingFlag[]) {
      if (seen.has(f.phrase.toLowerCase())) continue;
      seen.add(f.phrase.toLowerCase());
      flags.push(f);
    }
  return { hash, words, model, flags };
}

async function recordCheck(
  ctx: CommandContext,
  cma: Cma,
  check: {
    source: 'words' | 'model';
    version: string;
    status: 'passed' | 'flagged' | 'unavailable';
    flags: readonly FairHousingFlag[];
    textHash: string;
  },
) {
  await ctx.tx.insert(fairHousingChecks).values({
    workspaceId: cma.workspaceId,
    dealRecordId: cma.dealRecordId,
    cmaId: cma.id,
    source: check.source,
    version: check.version,
    status: check.flags.length ? 'flagged' : check.status === 'flagged' ? 'passed' : check.status,
    flags: [...check.flags],
    textHash: check.textHash,
  });
}

/** Why a CMA can't be shared yet, in words, with its rule; null when it can. */
function shareBlock(cma: Cma, checks: readonly Check[]): { rule: string; words: string } | null {
  if (cma.status === 'shared')
    return { rule: 'realestate_cma_final', words: `CMA ${cma.number} is already shared.` };
  if (cma.status === 'draft')
    return {
      rule: 'realestate_cma_not_final',
      words: `Finalize CMA ${cma.number} first, so its range stays as the client sees it.`,
    };
  if (cma.summaryState !== 'ready')
    return {
      rule: 'realestate_cma_no_summary',
      words:
        cma.summaryState === 'drafting'
          ? 'The summary is still being written. Try again in a moment.'
          : 'Write the summary, or ask for a draft, before sharing it.',
    };
  const now = currentChecks(cma, checks);
  if (!now.words || !now.model)
    return {
      rule: 'realestate_check_running',
      words: 'The fair-housing check is still reading the summary. Try again in a moment.',
    };
  if (now.flags.length && !cma.flagsAcknowledgedAt)
    return {
      rule: 'realestate_fair_housing_flags',
      words: `The summary has words that could read as a preference about who should live somewhere: ${now.flags
        .map((f) => `“${f.phrase}”`)
        .join(', ')}. Change them, or confirm they’re fine with a reason.`,
    };
  return null;
}

/**
 * The home a new CMA is for, and its facts as the deal has them: one of a buyer deal's homes (its price is what it's
 * listed at), or a listing's own home, with its confirmed facts and its list price if it has one yet (S-06).
 */
async function subjectFor(
  ctx: Ctx,
  deal: Deal,
  homeId: string | undefined,
): Promise<{
  homeId: string | null;
  address: string;
  facts: Record<string, unknown>;
  priceCents: number | null;
}> {
  if (deal.side === 'listing') {
    if (homeId)
      throw HfosError.rule(
        'realestate_cma_listing_home',
        409,
        `A CMA on ${deal.name} is for the listing’s own home. Start it without picking a home.`,
      );
    const address = await listingAddress(ctx, deal);
    if (!address)
      throw HfosError.rule(
        'realestate_no_address',
        409,
        `${deal.name} has no home’s address yet. Set the property on the deal, then start its CMA.`,
      );
    const l = await listingOf(ctx, deal.recordId);
    return {
      homeId: null,
      address,
      facts: (l?.facts ?? {}) as Record<string, unknown>,
      priceCents: await listPriceOf(ctx, deal.recordId),
    };
  }
  requireBuyerSide(deal);
  if (!homeId)
    throw HfosError.validation(
      [{ path: 'homeId', message: 'Pick one of the deal’s homes.' }],
      'Pick which of the buyer’s homes the CMA is for.',
    );
  const home = await loadHome(ctx, homeId);
  if (home.dealRecordId !== deal.recordId || home.status === 'removed')
    throw HfosError.notFound(
      `That home isn’t on ${deal.name}. Add it to the deal’s homes first, then start its CMA.`,
    );
  const facts = home.facts as Record<string, unknown>;
  return {
    homeId: home.id,
    address: home.address,
    facts,
    priceCents: typeof facts['price_cents'] === 'number' ? (facts['price_cents'] as number) : null,
  };
}

// ---------- commands ----------

export const cmaStart = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.start',
  description:
    'Start a CMA for one of a buyer deal’s homes or a listing’s own home, with its facts as the deal has them; or another CMA from an earlier one’s comps.',
  risk: 1,
  input: CmaStartInput,
  output: CmaStartOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_start_cma',
    description:
      'Start a CMA (comparable sales) for one of a buyer deal’s homes, or for a listing’s own home (leave out the home).',
  },
  emits: ['realestate.cma.started'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireOpen(deal);
    const subject = await subjectFor(ctx, deal, input.homeId);
    const from = input.fromCmaId ? (await loadCma(ctx, input.fromCmaId)).cma : null;
    if (from && from.dealRecordId !== deal.recordId)
      throw HfosError.notFound(
        `That CMA isn’t on ${deal.name}. Start from one of this deal’s CMAs.`,
      );
    const [last] = await ctx.tx
      .select({ n: max(cmas.number) })
      .from(cmas)
      .where(eq(cmas.dealRecordId, deal.recordId));
    const number = (last?.n ?? 0) + 1;
    const facts = subject.facts;
    const factNum = (k: string) => (typeof facts[k] === 'number' ? (facts[k] as number) : null);
    const tz = await timeZoneOf(ctx);
    const [cma] = await ctx.tx
      .insert(cmas)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        homeId: subject.homeId,
        subjectAddress: subject.address,
        subjectBeds: factNum('beds'),
        subjectBaths: factNum('baths')?.toString() ?? null,
        subjectSqft: factNum('sqft'),
        subjectListPriceCents: subject.priceCents,
        subjectYearBuilt: factNum('year_built'),
        number,
        method: CMA_METHOD,
        asOf: todayIn(tz),
        createdBy: actorUserId(ctx),
      })
      .returning();
    let copied = 0;
    if (from) {
      const list = await compsOf(ctx, from.id);
      if (list.length)
        await ctx.tx.insert(cmaComps).values(
          list.map((c) => ({
            workspaceId: deal.workspaceId,
            dealRecordId: deal.recordId,
            cmaId: cma!.id,
            address: c.address,
            priceCents: c.priceCents,
            status: c.status,
            soldOn: c.soldOn,
            beds: c.beds,
            baths: c.baths,
            sqft: c.sqft,
            yearBuilt: c.yearBuilt,
            distanceMiles: c.distanceMiles,
            adjustments: c.adjustments,
            used: c.used,
            note: c.note,
            source: c.source,
            mlsNumber: c.mlsNumber,
            mls: c.mls,
            position: c.position,
            createdBy: actorUserId(ctx),
          })),
        );
      copied = list.length;
    }
    await historyLine(ctx, deal, 'cma_started', { after: { number, address: subject.address } });
    await ctx.emit({
      type: 'realestate.cma.started',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma!.id, number, homeId: subject.homeId, fromCmaId: from?.id ?? null },
    });
    return { cmaId: cma!.id, number, comps: copied };
  },
});

export const cmaSetSubject = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.set_subject',
  description:
    'Set the facts of the home a draft CMA is for: beds, baths, square feet, list price, year built.',
  risk: 1,
  input: CmaSetSubjectInput,
  output: CmaChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_cma_set_subject' },
  scope: inWorkspace,
  emits: ['realestate.cma.changed'],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireNotArchived(deal);
    requireDraft(cma);
    await ctx.tx
      .update(cmas)
      .set({
        subjectBeds: input.beds,
        subjectBaths: input.baths?.toString() ?? null,
        subjectSqft: input.sqft,
        subjectListPriceCents: input.listPriceCents,
        subjectYearBuilt: input.yearBuilt,
        updatedAt: new Date(),
      })
      .where(eq(cmas.id, cma.id));
    await ctx.emit({
      type: 'realestate.cma.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, what: 'subject' },
    });
    return { cmaId: cma.id, status: cma.status };
  },
});

export const cmaAddComp = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.add_comp',
  description:
    'Add a comparable home to a draft CMA: its address, sold price and date (or asking price while pending or for sale), beds, baths, square feet and distance.',
  risk: 1,
  input: CmaAddCompInput,
  output: CmaAddCompOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_add_comp',
    description: 'Add a comparable sale to a draft CMA, with its price, sold date and size.',
  },
  emits: ['realestate.cma.changed'],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireNotArchived(deal);
    requireDraft(cma);
    const list = await compsOf(ctx, cma.id);
    if (list.length >= MAX_COMPS)
      throw HfosError.rule(
        'realestate_cma_full',
        409,
        `A CMA can have up to ${MAX_COMPS} comps. Take one off, or untick the ones you don’t use.`,
      );
    const key = addressKey(input.address);
    if (key === addressKey(cma.subjectAddress) || list.some((c) => addressKey(c.address) === key))
      throw HfosError.rule(
        'realestate_cma_comp_already',
        409,
        key === addressKey(cma.subjectAddress)
          ? `${input.address} is the home the CMA is for, so it can’t be one of its comps.`
          : `${input.address} is already a comp on CMA ${cma.number}. Change that one instead.`,
      );
    const [row] = await ctx.tx
      .insert(cmaComps)
      .values({
        workspaceId: cma.workspaceId,
        dealRecordId: cma.dealRecordId,
        cmaId: cma.id,
        address: input.address,
        priceCents: input.priceCents,
        status: input.status,
        soldOn: input.soldOn ?? null,
        beds: input.beds ?? null,
        baths: input.baths?.toString() ?? null,
        sqft: input.sqft ?? null,
        yearBuilt: input.yearBuilt ?? null,
        distanceMiles: input.distanceMiles?.toString() ?? null,
        note: input.note ?? null,
        position: Math.max(0, ...list.map((c) => c.position)) + 1,
        createdBy: actorUserId(ctx),
      })
      .returning({ id: cmaComps.id });
    await ctx.tx.update(cmas).set({ updatedAt: new Date() }).where(eq(cmas.id, cma.id));
    await ctx.emit({
      type: 'realestate.cma.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, what: 'comp_added', compId: row!.id },
    });
    return { cmaId: cma.id, compId: row!.id };
  },
});

async function loadComp(ctx: Ctx, compId: string): Promise<CompRow> {
  const [c] = await ctx.tx
    .select()
    .from(cmaComps)
    .where(and(eq(cmaComps.id, compId), eq(cmaComps.workspaceId, ctx.scope.workspaceId!)));
  if (!c)
    throw HfosError.notFound(
      'That comp isn’t on the CMA anymore. Refresh to see the CMA as it is now.',
    );
  return c;
}

export const cmaUpdateComp = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.update_comp',
  description:
    'Change a draft CMA’s comp: its facts, whether it’s used, and the agent’s adjustments, each with its reason.',
  risk: 1,
  input: CmaUpdateCompInput,
  output: CmaChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_cma_update_comp' },
  scope: inWorkspace,
  emits: ['realestate.cma.changed'],
  async handler(ctx, input) {
    const comp = await loadComp(ctx, input.compId);
    const { cma, deal } = await loadCma(ctx, comp.cmaId, true);
    requireNotArchived(deal);
    requireDraft(cma);
    const status = input.status ?? comp.status;
    const soldOn = input.soldOn !== undefined ? input.soldOn : comp.soldOn;
    if (status === 'sold' && !soldOn)
      throw HfosError.validation(
        [{ path: 'soldOn', message: 'Enter the date it sold.' }],
        'Enter the date it sold.',
      );
    if (input.address && addressKey(input.address) !== addressKey(comp.address)) {
      const others = (await compsOf(ctx, cma.id)).filter((c) => c.id !== comp.id);
      if (others.some((c) => addressKey(c.address) === addressKey(input.address!)))
        throw HfosError.rule(
          'realestate_cma_comp_already',
          409,
          `${input.address} is already a comp on CMA ${cma.number}. Change that one instead.`,
        );
    }
    const dec = (v: number | null | undefined) =>
      v === undefined ? undefined : v === null ? null : v.toString();
    await ctx.tx
      .update(cmaComps)
      .set({
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
        status,
        soldOn,
        ...(input.beds !== undefined ? { beds: input.beds } : {}),
        ...(input.baths !== undefined ? { baths: dec(input.baths) } : {}),
        ...(input.sqft !== undefined ? { sqft: input.sqft } : {}),
        ...(input.yearBuilt !== undefined ? { yearBuilt: input.yearBuilt } : {}),
        ...(input.distanceMiles !== undefined ? { distanceMiles: dec(input.distanceMiles) } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.used !== undefined ? { used: input.used } : {}),
        ...(input.adjustments !== undefined ? { adjustments: input.adjustments } : {}),
        updatedAt: new Date(),
      })
      .where(eq(cmaComps.id, comp.id));
    await ctx.tx.update(cmas).set({ updatedAt: new Date() }).where(eq(cmas.id, cma.id));
    await ctx.emit({
      type: 'realestate.cma.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, what: 'comp_changed', compId: comp.id },
    });
    return { cmaId: cma.id, status: cma.status };
  },
});

export const cmaRemoveComp = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.remove_comp',
  description: 'Take a comp off a draft CMA.',
  risk: 1,
  input: CmaRemoveCompInput,
  output: CmaChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_cma_remove_comp' },
  scope: inWorkspace,
  emits: ['realestate.cma.changed'],
  async handler(ctx, input) {
    const comp = await loadComp(ctx, input.compId);
    const { cma, deal } = await loadCma(ctx, comp.cmaId, true);
    requireNotArchived(deal);
    requireDraft(cma);
    await ctx.tx.delete(cmaComps).where(eq(cmaComps.id, comp.id));
    await ctx.tx.update(cmas).set({ updatedAt: new Date() }).where(eq(cmas.id, cma.id));
    await ctx.emit({
      type: 'realestate.cma.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, what: 'comp_removed', compId: comp.id },
    });
    return { cmaId: cma.id, status: cma.status };
  },
});

export const cmaFinalize = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.finalize',
  description:
    'Finalize a CMA: its range is kept as the comps give it now, and its comps stay as they are.',
  risk: 1,
  input: CmaInput,
  output: CmaChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_cma_finalize', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.cma.finalized', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireNotArchived(deal);
    requireDraft(cma);
    const result = cmaValues(
      cmaSubjectOf(cma),
      (await compsOf(ctx, cma.id)).map(cmaCompOf),
      cma.asOf,
    );
    if (!result.range)
      throw HfosError.rule(
        'realestate_cma_no_range',
        409,
        result.missing ?? 'Add a sold comp first.',
      );
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(cmas)
      .set({
        status: 'final',
        lowCents: result.range.lowCents,
        likelyCents: result.range.likelyCents,
        highCents: result.range.highCents,
        perSqftCents: result.range.perSqftCents,
        finalizedBy: actorUserId(ctx),
        finalizedAt: at,
        updatedAt: at,
      })
      .where(eq(cmas.id, cma.id));
    await historyLine(ctx, deal, 'cma_finalized', {
      after: { number: cma.number, address: cma.subjectAddress, range: rangeWords(result.range) },
    });
    // B-10 "Research and create CMA" (B-15 for another), or S-06 "Create seller CMA": linked to it.
    await addProof(
      ctx,
      deal,
      { keys: deal.side === 'listing' ? ['S-06'] : ['B-10', 'B-15'] },
      {
        kind: 'record',
        refKind: 'cma',
        refId: cma.id,
        body: `CMA ${cma.number} for ${cma.subjectAddress}: ${rangeWords(result.range)}`,
      },
    );
    await ctx.emit({
      type: 'realestate.cma.finalized',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, number: cma.number, ...result.range },
    });
    return { cmaId: cma.id, status: 'final' as const };
  },
});

export const cmaReopen = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.reopen',
  description: 'Reopen a final CMA that hasn’t been shared, to change its comps.',
  risk: 1,
  input: CmaInput,
  output: CmaChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_cma_reopen', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.cma.changed'],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireNotArchived(deal);
    requireNotShared(cma);
    if (cma.status === 'draft') return { cmaId: cma.id, status: cma.status };
    await ctx.tx
      .update(cmas)
      .set({
        status: 'draft',
        lowCents: null,
        likelyCents: null,
        highCents: null,
        perSqftCents: null,
        finalizedBy: null,
        finalizedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(cmas.id, cma.id));
    await historyLine(ctx, deal, 'cma_reopened', { after: { number: cma.number } });
    await ctx.emit({
      type: 'realestate.cma.changed',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, what: 'reopened' },
    });
    return { cmaId: cma.id, status: 'draft' as const };
  },
});

export const cmaRequestSummary = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.request_summary',
  description:
    'Ask for the CMA’s summary to be drafted from its numbers, for the agent to check. Replaces the summary there is.',
  risk: 1,
  input: CmaInput,
  output: CmaChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  actors: ['human', 'system'],
  ai: {
    tool: 'realestate_draft_cma_summary',
    description:
      'Draft a CMA’s summary for the client from its comps and range, for the agent to check.',
  },
  emits: ['realestate.cma.summary_requested'],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireNotArchived(deal);
    requireNotShared(cma);
    if (cma.summaryState === 'drafting') return { cmaId: cma.id, status: cma.status };
    await ctx.tx
      .update(cmas)
      .set({
        summaryState: 'drafting',
        summary: null,
        summaryFailure: null,
        summaryModel: null,
        summaryEditedBy: null,
        summaryEditedAt: null,
        flagsAcknowledgedAt: null,
        flagsAcknowledgedBy: null,
        flagsAcknowledgedReason: null,
        updatedAt: new Date(),
      })
      .where(eq(cmas.id, cma.id));
    await ctx.emit({
      type: 'realestate.cma.summary_requested',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id },
      broadcast: false,
    });
    return { cmaId: cma.id, status: cma.status };
  },
});

export const cmaSummaryDrafted = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.summary_drafted',
  description:
    'Real Estate Agent’s own: the drafted CMA summary and its first fair-housing checks, or why it couldn’t be drafted.',
  risk: 0,
  input: CmaSummaryDraftedInput,
  output: CmaChangeOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['realestate.cma.summary_ready'],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    if (cma.summaryState !== 'drafting') return { cmaId: cma.id, status: cma.status };
    const failed = !input.summary;
    await ctx.tx
      .update(cmas)
      .set(
        failed
          ? {
              summaryState: 'failed',
              summaryFailure:
                input.failure?.slice(0, 500) ||
                'The summary couldn’t be written. Ask for it again, or write it.',
              updatedAt: new Date(),
            }
          : {
              summaryState: 'ready',
              summary: input.summary!,
              summaryModel: input.model ?? null,
              updatedAt: new Date(),
            },
      )
      .where(eq(cmas.id, cma.id));
    if (!failed) {
      const hash = textHashOf(null, input.summary!);
      for (const c of input.checks) await recordCheck(ctx, cma, { ...c, textHash: hash });
    }
    await ctx.emit({
      type: 'realestate.cma.summary_ready',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, failed },
      broadcast: false,
    });
    return { cmaId: cma.id, status: cma.status };
  },
});

export const cmaSaveSummary = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.save_summary',
  description:
    'Save the agent’s own words for a CMA’s summary. They’re checked again for fair-housing risk (the list at once, the model a moment later), and any earlier confirmation of flags no longer counts.',
  risk: 1,
  input: CmaSaveSummaryInput,
  output: CmaSaveSummaryOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_cma_save_summary' },
  scope: inWorkspace,
  emits: ['realestate.cma.summary_saved'],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireNotArchived(deal);
    requireNotShared(cma);
    const at = changeMoment(ctx.meta);
    const [next] = await ctx.tx
      .update(cmas)
      .set({
        summary: input.summary,
        summaryState: 'ready',
        summaryFailure: null,
        summaryEditedBy: actorUserId(ctx),
        summaryEditedAt: at,
        flagsAcknowledgedAt: null,
        flagsAcknowledgedBy: null,
        flagsAcknowledgedReason: null,
        updatedAt: at,
      })
      .where(eq(cmas.id, cma.id))
      .returning();
    const flags = checkWords(input.summary);
    await recordCheck(ctx, next!, {
      source: 'words',
      version: FAIR_HOUSING_WORDS_VERSION,
      status: 'passed',
      flags,
      textHash: textHashOf(null, input.summary),
    });
    await ctx.emit({
      type: 'realestate.cma.summary_saved',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id },
      broadcast: false,
    });
    return { cmaId: cma.id, status: cma.status, flags };
  },
});

export const cmaSummaryChecked = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.summary_checked',
  description: 'Real Estate Agent’s own: the model’s fair-housing check of a CMA summary’s words.',
  risk: 0,
  input: CmaSummaryCheckedInput,
  output: CmaChangeOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: [],
  async handler(ctx, input) {
    const { cma } = await loadCma(ctx, input.cmaId, true);
    // Words since changed get their own check; this one would be about text nobody will share.
    if (cma.summaryState === 'ready' && textHashOf(null, cma.summary) === input.textHash)
      await recordCheck(ctx, cma, {
        source: 'model',
        version: input.version,
        status: input.status,
        flags: input.flags,
        textHash: input.textHash,
      });
    return { cmaId: cma.id, status: cma.status };
  },
});

export const cmaAcknowledgeFlags = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.acknowledge_flags',
  description:
    'Confirm a CMA summary’s fair-housing flags are fine as written, with the reason. Kept with the CMA; editing it again asks again.',
  risk: 1,
  input: CmaAcknowledgeInput,
  output: CmaChangeOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_cma_acknowledge_flags', autonomy: 'confirm' },
  scope: inWorkspace,
  emits: ['realestate.cma.flags_acknowledged'],
  async handler(ctx, input) {
    if (actorKind(ctx) !== 'person')
      throw HfosError.forbidden(
        'Only a person confirms fair-housing flags are fine, from the CMA’s page.',
      );
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireNotArchived(deal);
    requireNotShared(cma);
    const now = currentChecks(cma, await checksOf(ctx, cma.id));
    if (!now.flags.length) return { cmaId: cma.id, status: cma.status };
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(cmas)
      .set({
        flagsAcknowledgedAt: at,
        flagsAcknowledgedBy: actorUserId(ctx),
        flagsAcknowledgedReason: input.reason,
        updatedAt: at,
      })
      .where(eq(cmas.id, cma.id));
    await historyLine(ctx, deal, 'fair_housing_confirmed', {
      after: { cmaId: cma.id, phrases: now.flags.map((f) => f.phrase) },
      note: input.reason,
    });
    await ctx.emit({
      type: 'realestate.cma.flags_acknowledged',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, phrases: now.flags.map((f) => f.phrase), reason: input.reason },
    });
    return { cmaId: cma.id, status: cma.status };
  },
});

export const cmaShare = defineAddonCommand(realestateAddon, {
  name: 'realestate.cma.share',
  description:
    'Share a final CMA with the deal’s client: its range and summary go in their portal as a one-page summary. Refused until its summary has been checked and any fair-housing flag is fixed or kept with a reason.',
  risk: 2,
  input: CmaInput,
  output: CmaChangeOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_share_cma',
    description:
      'Share a final, checked CMA with the deal’s client in their portal. Always asks the person first.',
  },
  emits: ['realestate.cma.shared', ...PROOF_EVENTS],
  async handler(ctx, input) {
    const { cma, deal } = await loadCma(ctx, input.cmaId, true);
    requireOpen(deal);
    const blocked = shareBlock(cma, await checksOf(ctx, cma.id));
    if (blocked) {
      if (cma.status === 'shared') return { cmaId: cma.id, status: cma.status };
      throw HfosError.rule(blocked.rule, 409, blocked.words);
    }
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(cmas)
      .set({ status: 'shared', sharedBy: actorUserId(ctx), sharedAt: at, updatedAt: at })
      .where(eq(cmas.id, cma.id));
    const range = {
      lowCents: cma.lowCents!,
      likelyCents: cma.likelyCents!,
      highCents: cma.highCents!,
    };
    await historyLine(ctx, deal, 'cma_shared', {
      after: { number: cma.number, address: cma.subjectAddress, range: rangeWords(range) },
    });
    // S-07 "Recommend listing price": the range the seller was shown, as a note; the talk is the agent's.
    if (deal.side === 'listing')
      await addProof(
        ctx,
        deal,
        { keys: ['S-07'] },
        { kind: 'note', body: `CMA ${cma.number} shared with the seller: ${rangeWords(range)}` },
      );
    const eventId = await ctx.emit({
      type: 'realestate.cma.shared',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { cmaId: cma.id, number: cma.number, ...range },
    });
    await dealLine(
      ctx,
      deal,
      `shared CMA ${cma.number} for ${cma.subjectAddress} with the client`.slice(0, 300),
      {
        eventId,
      },
    );
    return { cmaId: cma.id, status: 'shared' as const };
  },
});

// ---------- queries ----------

export const cmasList = defineAddonQuery(realestateAddon, {
  name: 'realestate.cmas',
  description: 'A deal’s CMAs: the home each is for, where it stands and its range.',
  input: CmasInput,
  output: CmasOutput,
  permission: 'realestate.use',
  ai: { tool: 'realestate_cmas' },
  scope: inWorkspace,
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(cmas)
      .where(eq(cmas.dealRecordId, deal.recordId))
      .orderBy(desc(cmas.number));
    const comps = list.length
      ? await ctx.tx
          .select({ cmaId: cmaComps.cmaId })
          .from(cmaComps)
          .where(eq(cmaComps.dealRecordId, deal.recordId))
      : [];
    return {
      cmas: list.map((c) => cmaLine(c, comps.filter((x) => x.cmaId === c.id).length)),
    };
  },
});

export const cmaGet = defineAddonQuery(realestateAddon, {
  name: 'realestate.cma',
  description:
    'One CMA: the home and its facts, each comp with its value for the home and why it is or isn’t counted, the range, the summary and its fair-housing checks, and whether it can be shared.',
  input: CmaInput,
  output: CmaGetOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_cma',
    description: 'A CMA’s comps, price range and summary.',
  },
  async handler(ctx, input) {
    const { cma } = await loadCma(ctx, input.cmaId);
    const page = cmaPage(cma, await compsOf(ctx, cma.id));
    const checks = await checksOf(ctx, cma.id);
    const now = currentChecks(cma, checks);
    const names = await userNames(ctx, [cma.flagsAcknowledgedBy]);
    const blocked = shareBlock(cma, checks);
    return {
      cma: {
        ...page,
        fairHousing: {
          checked: !!now.words && !!now.model,
          flags: now.flags,
          acknowledged:
            cma.flagsAcknowledgedAt && cma.flagsAcknowledgedReason
              ? {
                  reason: cma.flagsAcknowledgedReason,
                  by: cma.flagsAcknowledgedBy
                    ? {
                        id: cma.flagsAcknowledgedBy,
                        fullName: names.get(cma.flagsAcknowledgedBy) ?? 'Former member',
                      }
                    : null,
                }
              : null,
        },
        shareBlocked: cma.status === 'shared' ? null : (blocked?.words ?? null),
      },
    };
  },
});

export const cmaCommands = [
  cmaStart,
  cmaSetSubject,
  cmaAddComp,
  cmaUpdateComp,
  cmaRemoveComp,
  cmaFinalize,
  cmaReopen,
  cmaRequestSummary,
  cmaSummaryDrafted,
  cmaSaveSummary,
  cmaSummaryChecked,
  cmaAcknowledgeFlags,
  cmaShare,
] as const;
export const cmaQueries = [cmasList, cmaGet] as const;
