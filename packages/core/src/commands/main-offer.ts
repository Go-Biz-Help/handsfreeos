/**
 * The business's main offer (HANDSFREEOS_MAIN_OFFER_IMPLEMENTATION_PLAN.md, Part 1). A person edits a draft while the
 * live version keeps running; the worker saves the AI's score of the draft it read; publishing keeps the draft as the
 * next version, which never changes, and add-ons that use the offer hear `main_offer.published`.
 *
 * Every command refuses while no add-on that uses the main offer is on (`main_offer_not_in_use`): it's kept, hidden,
 * and comes back with one. Not the promotions under Knowledge (./offer.ts).
 */
import { eq, max } from 'drizzle-orm';
import { mainOfferVersions, mainOffers } from '@hfos/db/schema';
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
  SCORED_PART_LABELS,
  underBar,
} from '../main-offer/parts';
import {
  MainOfferDiscardDraftInput,
  MainOfferDiscardDraftOutput,
  MainOfferPublishInput,
  MainOfferPublishOutput,
  MainOfferSaveDraftInput,
  MainOfferSaveDraftOutput,
  MainOfferScoreSaveInput,
  MainOfferScoreSaveOutput,
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
