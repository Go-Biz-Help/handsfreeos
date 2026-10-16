/**
 * The business's main offer (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, Part 1). A person edits a draft while the
 * live version keeps running; the worker saves the AI's score of the draft it read; publishing keeps the draft as the
 * next version, which never changes, and add-ons that use the offer hear `main_offer.published`.
 *
 * The owner's direction for the whole offer is kept with it, and the worker keeps the AI's tries beside the draft,
 * which never change; a person takes parts of one into the draft
 * (HANDSFREEOS_MAIN_OFFER_TRIES_IMPLEMENTATION_PLAN.md).
 *
 * Every command refuses while no add-on that uses the main offer is on (`main_offer_not_in_use`): it's kept, hidden,
 * and comes back with one. Not the promotions under Knowledge (./offer.ts).
 */
import { and, eq, max } from 'drizzle-orm';
import { mainOfferTries, mainOfferVersions, mainOffers } from '@hfos/db/schema';
import { ADDON_CATALOG } from '../addons/catalog';
import { addonsUsing, coreFeatureRunning } from '../addons/capabilities';
import { loadActiveAddons } from '../addons/load';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  clearsBar,
  MAIN_OFFER_BAR,
  MainOfferParts,
  MainOfferScore,
  missingParts,
  missingWords,
  sameOffer,
  samePart,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  underBar,
  withPartsFrom,
} from '../main-offer/parts';
import {
  MainOfferDiscardDraftInput,
  MainOfferDiscardDraftOutput,
  MainOfferPublishInput,
  MainOfferPublishOutput,
  MainOfferSaveDirectionInput,
  MainOfferSaveDirectionOutput,
  MainOfferSaveDraftInput,
  MainOfferSaveDraftOutput,
  MainOfferScoreSaveInput,
  MainOfferScoreSaveOutput,
  MainOfferTryApplyInput,
  MainOfferTryApplyOutput,
  MainOfferTrySaveInput,
  MainOfferTrySaveOutput,
} from '../schemas/main-offer';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** "Social Outreach", or "Social Outreach or AI Sales Coach". */
function comesWithWords(): string {
  const names = addonsUsing(ADDON_CATALOG, 'main_offer');
  if (names.length <= 1) return names[0] ?? 'an add-on';
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/** Refuses unless an add-on that uses the main offer runs here. */
export async function requireMainOfferInUse(ctx: CommandContext): Promise<void> {
  const running = await loadActiveAddons(ctx.tx, ctx.scope.workspaceId!);
  if (coreFeatureRunning(ADDON_CATALOG, running, 'main_offer')) return;
  throw HfosError.rule(
    'main_offer_not_in_use',
    409,
    `Your main offer comes with ${comesWithWords()}, which isn’t on in this business. An owner or admin can turn it on in Settings → Add-ons; your offer is kept until then.`,
  );
}

/** The business's row, made if it's the first time, and held until the command ends. */
async function lockOffer(ctx: CommandContext) {
  const workspaceId = ctx.scope.workspaceId!;
  await ctx.tx.insert(mainOffers).values({ workspaceId }).onConflictDoNothing();
  const [row] = await ctx.tx
    .select()
    .from(mainOffers)
    .where(eq(mainOffers.workspaceId, workspaceId))
    .for('update');
  if (!row) throw HfosError.forbidden();
  return row;
}

function draftMoved(revision: number): HfosError {
  return new HfosError(
    'conflict',
    409,
    'Someone changed your offer’s draft in the meantime. Reload to see their changes, then make yours again.',
    { revision },
    'main_offer_draft_moved',
  );
}

export const mainOfferSaveDraft = defineCommand({
  name: 'main_offer.save_draft',
  description:
    'Save the main offer’s draft: who it helps, the outcome, timeframe, method, guarantee, price and proof. The live version keeps running until the draft is published.',
  risk: 1,
  input: MainOfferSaveDraftInput,
  output: MainOfferSaveDraftOutput,
  permission: 'main_offer.manage',
  scope: inWorkspace,
  emits: ['main_offer.draft_saved'],
  async handler(ctx, input) {
    await requireMainOfferInUse(ctx);
    const row = await lockOffer(ctx);
    if (row.revision !== input.revision) throw draftMoved(row.revision);
    const revision = row.revision + 1;
    await ctx.tx
      .update(mainOffers)
      .set({ draft: input.parts, revision, draftBy: userIdOf(ctx.actor), draftAt: new Date() })
      .where(eq(mainOffers.workspaceId, row.workspaceId));
    await ctx.emit({
      type: 'main_offer.draft_saved',
      entityType: 'main_offer',
      entityId: row.workspaceId,
      payload: { revision },
      broadcast: false,
    });
    return { revision };
  },
});

export const mainOfferDiscardDraft = defineCommand({
  name: 'main_offer.discard_draft',
  description: 'Throw away the main offer’s draft. The live version stays as it is.',
  risk: 1,
  input: MainOfferDiscardDraftInput,
  output: MainOfferDiscardDraftOutput,
  permission: 'main_offer.manage',
  scope: inWorkspace,
  emits: ['main_offer.draft_discarded'],
  async handler(ctx) {
    await requireMainOfferInUse(ctx);
    const row = await lockOffer(ctx);
    if (row.draft === null) return { discarded: false, revision: row.revision };
    const revision = row.revision + 1;
    await ctx.tx
      .update(mainOffers)
      .set({
        draft: null,
        score: null,
        scoredRevision: null,
        revision,
        draftBy: null,
        draftAt: null,
      })
      .where(eq(mainOffers.workspaceId, row.workspaceId));
    await ctx.emit({
      type: 'main_offer.draft_discarded',
      entityType: 'main_offer',
      entityId: row.workspaceId,
      payload: { revision },
      broadcast: false,
    });
    return { discarded: true, revision };
  },
});

export const mainOfferScoreSave = defineCommand({
  name: 'main_offer.score_save',
  description:
    'Worker: keep the AI’s score of the main offer’s draft, for the draft it read. A draft that changed since is left unscored.',
  risk: 0,
  input: MainOfferScoreSaveInput,
  output: MainOfferScoreSaveOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  emits: ['main_offer.scored'],
  actors: ['system'],
  async handler(ctx, input) {
    await requireMainOfferInUse(ctx);
    const row = await lockOffer(ctx);
    if (row.draft === null || row.revision !== input.revision) return { saved: false };
    await ctx.tx
      .update(mainOffers)
      .set({ score: input.score, scoredRevision: input.revision })
      .where(eq(mainOffers.workspaceId, row.workspaceId));
    await ctx.emit({
      type: 'main_offer.scored',
      entityType: 'main_offer',
      entityId: row.workspaceId,
      payload: { revision: input.revision, clears: clearsBar(input.score) },
      broadcast: false,
    });
    return { saved: true };
  },
});

export const mainOfferPublish = defineCommand({
  name: 'main_offer.publish',
  description:
    'Make the main offer’s scored draft the live version. Everything that uses the offer starts saying it; the version before is kept.',
  risk: 2,
  input: MainOfferPublishInput,
  output: MainOfferPublishOutput,
  permission: 'main_offer.manage',
  scope: inWorkspace,
  emits: ['main_offer.published'],
  async handler(ctx, input) {
    await requireMainOfferInUse(ctx);
    const row = await lockOffer(ctx);
    if (row.revision !== input.revision) throw draftMoved(row.revision);
    if (row.draft === null)
      throw HfosError.rule(
        'main_offer_no_draft',
        409,
        'There’s nothing new to publish. Change a part of your offer first, then publish it.',
      );
    const parts = MainOfferParts.parse(row.draft);
    const missing = missingParts(parts);
    if (missing.length)
      throw HfosError.validation(
        missing.map((m) => ({ path: m.path, message: `Fill this in: ${m.label}.` })),
        `Your offer needs ${missingWords(missing)} before it can go live.`,
      );
    const scored = row.score !== null && row.scoredRevision === row.revision;
    if (!scored)
      throw HfosError.rule(
        'main_offer_not_scored',
        409,
        'Score this version before it goes live: press Score my offer, then publish.',
      );
    const score = MainOfferScore.parse(row.score);
    const clears = clearsBar(score);
    if (!clears && !input.anyway) {
      const [lowest] = underBar(score);
      const label = SCORED_PART_LABELS[lowest!];
      throw HfosError.rule(
        'main_offer_below_bar',
        422,
        `${label} scored ${score.parts[lowest!].score} out of 10, under the ${MAIN_OFFER_BAR} every part needs. ${score.fix} Change it and score it again, or press Use it anyway and say why.`,
      );
    }
    const [top] = await ctx.tx
      .select({ n: max(mainOfferVersions.version) })
      .from(mainOfferVersions)
      .where(eq(mainOfferVersions.workspaceId, row.workspaceId));
    const version = (top?.n ?? 0) + 1;
    const anyway = clears ? null : (input.anyway ?? null);
    await ctx.tx.insert(mainOfferVersions).values({
      workspaceId: row.workspaceId,
      version,
      parts,
      line: parts.line!,
      score,
      anyway,
      publishedBy: userIdOf(ctx.actor),
    });
    await ctx.tx
      .update(mainOffers)
      .set({
        draft: null,
        score: null,
        scoredRevision: null,
        revision: row.revision + 1,
        draftBy: null,
        draftAt: null,
        liveVersion: version,
      })
      .where(eq(mainOffers.workspaceId, row.workspaceId));
    await ctx.emit({
      type: 'main_offer.published',
      entityType: 'main_offer',
      entityId: row.workspaceId,
      payload: { version },
      before: row.liveVersion === null ? null : { version: row.liveVersion },
      after: { version, line: parts.line, ...(anyway ? { anyway } : {}) },
    });
    return { version };
  },
});

export const mainOfferSaveDirection = defineCommand({
  name: 'main_offer.save_direction',
  description:
    'Save the owner’s direction for the whole main offer: what it really is, who it’s for and what to lead with. Every score and try after reads it, so the draft is scored again against it.',
  risk: 1,
  input: MainOfferSaveDirectionInput,
  output: MainOfferSaveDirectionOutput,
  permission: 'main_offer.manage',
  scope: inWorkspace,
  emits: ['main_offer.direction_saved'],
  async handler(ctx, input) {
    await requireMainOfferInUse(ctx);
    const row = await lockOffer(ctx);
    if (row.revision !== input.revision) throw draftMoved(row.revision);
    const direction = input.direction.trim() || null;
    if (direction === row.direction) return { revision: row.revision };
    // The revision moves on, so a score from before is stale and two editors can't undo each other.
    const revision = row.revision + 1;
    await ctx.tx
      .update(mainOffers)
      .set({ direction, revision })
      .where(eq(mainOffers.workspaceId, row.workspaceId));
    await ctx.emit({
      type: 'main_offer.direction_saved',
      entityType: 'main_offer',
      entityId: row.workspaceId,
      payload: { revision },
      before: { direction: row.direction },
      after: { direction },
      broadcast: false,
    });
    return { revision };
  },
});

export const mainOfferTrySave = defineCommand({
  name: 'main_offer.try_save',
  description:
    'Worker: keep a try the AI wrote of the whole main offer beside the draft, for the draft it read. A draft that changed since keeps no try.',
  risk: 0,
  input: MainOfferTrySaveInput,
  output: MainOfferTrySaveOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  emits: ['main_offer.try_made'],
  actors: ['system'],
  async handler(ctx, input) {
    await requireMainOfferInUse(ctx);
    // Held until the command ends, so two tries can't take the same number.
    const row = await lockOffer(ctx);
    if (row.draft === null || row.revision !== input.revision)
      return { saved: false, id: null, number: null };
    const round = row.liveVersion ?? 0;
    const [top] = await ctx.tx
      .select({ n: max(mainOfferTries.number) })
      .from(mainOfferTries)
      .where(and(eq(mainOfferTries.workspaceId, row.workspaceId), eq(mainOfferTries.round, round)));
    const number = (top?.n ?? 0) + 1;
    const [made] = await ctx.tx
      .insert(mainOfferTries)
      .values({
        workspaceId: row.workspaceId,
        round,
        number,
        fromRevision: row.revision,
        base: MainOfferParts.parse(row.draft),
        parts: input.parts,
        why: input.why,
        score: input.score,
        direction: row.direction,
        notes: input.notes,
        keep: SCORED_PARTS.filter((p) => input.keep.includes(p)),
        madeBy: userIdOf(ctx.actor),
      })
      .returning({ id: mainOfferTries.id });
    await ctx.emit({
      type: 'main_offer.try_made',
      entityType: 'main_offer',
      entityId: row.workspaceId,
      payload: { round, number, clears: clearsBar(input.score) },
      broadcast: false,
    });
    return { saved: true, id: made!.id, number };
  },
});

export const mainOfferTryApply = defineCommand({
  name: 'main_offer.try_apply',
  description:
    'Take the picked parts of one of the AI’s tries into the main offer’s draft; the rest of the draft stays as it is. The live version keeps running until the draft is published.',
  risk: 1,
  input: MainOfferTryApplyInput,
  output: MainOfferTryApplyOutput,
  permission: 'main_offer.manage',
  scope: inWorkspace,
  emits: ['main_offer.try_applied'],
  async handler(ctx, input) {
    await requireMainOfferInUse(ctx);
    const row = await lockOffer(ctx);
    if (row.revision !== input.revision) throw draftMoved(row.revision);
    if (row.draft === null)
      throw HfosError.rule(
        'main_offer_no_draft',
        409,
        'There’s no draft to take parts into. Change your offer to start one, then make a try.',
      );
    const [found] = await ctx.tx
      .select()
      .from(mainOfferTries)
      .where(
        and(eq(mainOfferTries.workspaceId, row.workspaceId), eq(mainOfferTries.id, input.tryId)),
      );
    if (!found)
      throw HfosError.notFound(
        'That try isn’t there anymore. Reload to see your tries, or make a new one.',
      );
    if (found.round !== (row.liveVersion ?? 0))
      throw HfosError.rule(
        'main_offer_try_gone',
        409,
        `That try is from before version ${row.liveVersion} went live. Make a new one from your draft.`,
      );
    const draft = MainOfferParts.parse(row.draft);
    const base = MainOfferParts.parse(found.base);
    const from = MainOfferParts.parse(found.parts);
    const take = SCORED_PARTS.filter((p) => input.take.includes(p));
    let next = withPartsFrom(draft, from, take);
    // The try's line and few words were written for all of its parts: they come too only when every part it changed
    // is taken into the draft it was written from.
    const changed = SCORED_PARTS.filter((p) => !samePart(from, base, p));
    const lineFromTry =
      changed.length > 0 && changed.every((p) => take.includes(p)) && sameOffer(draft, base);
    if (lineFromTry) next = { ...next, line: from.line, inAFewWords: from.inAFewWords };
    if (sameOffer(next, draft)) return { revision: row.revision, lineFromTry };
    const revision = row.revision + 1;
    await ctx.tx
      .update(mainOffers)
      .set({ draft: next, revision, draftBy: userIdOf(ctx.actor), draftAt: new Date() })
      .where(eq(mainOffers.workspaceId, row.workspaceId));
    await ctx.emit({
      type: 'main_offer.try_applied',
      entityType: 'main_offer',
      entityId: row.workspaceId,
      payload: { revision, number: found.number, take, lineFromTry },
      broadcast: false,
    });
    return { revision, lineFromTry };
  },
});
