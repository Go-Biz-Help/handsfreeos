'use client';
import type {
  MainOfferParts,
  MainOfferScore,
  OfferAssistMode,
  OfferAssistOutput,
  OfferAssistPath,
  OfferNicheOption,
} from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';

/** The main offer's commands and AI help (docs/main-offer.md). Each throws an ApiError the caller shows. */

export async function saveOfferDraft(workspaceId: string, revision: number, parts: MainOfferParts) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/main_offer.save_draft', {
      body: { workspaceId, revision, parts },
    }),
  );
}

export async function discardOfferDraft(workspaceId: string) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/main_offer.discard_draft', { body: { workspaceId } }),
  );
}

export async function publishOffer(workspaceId: string, revision: number, anyway?: string) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/main_offer.publish', {
      body: { workspaceId, revision, ...(anyway ? { anyway } : {}) },
    }),
  );
}

/** Three niches to start with, from the best customer or, with none, from a problem the business can reach. */
export function findNiche(
  workspaceId: string,
  parts: MainOfferParts,
): Promise<{ options: OfferNicheOption[] }> {
  return workerPost('/v1/main-offer/niche', { workspaceId, parts });
}

/** Improve, or Write it for me, on one box: three to pick from (for the method, three sets of steps). */
export function assistOffer(
  workspaceId: string,
  path: OfferAssistPath,
  mode: OfferAssistMode,
  parts: MainOfferParts,
): Promise<OfferAssistOutput> {
  return workerPost('/v1/main-offer/assist', { workspaceId, path, mode, parts });
}

/** The AI's score of the draft as it's kept at this revision, kept with it. */
export function scoreOffer(
  workspaceId: string,
  revision: number,
): Promise<{ saved: boolean; score: MainOfferScore }> {
  return workerPost('/v1/main-offer/score', { workspaceId, revision });
}

/** Why the AI didn't help, in plain words. */
export function offerAiError(e: unknown): string {
  if (!(e instanceof ApiError)) return errorMessage(e);
  const why = e.rule ?? e.code;
  if (e.status === 0) return 'The AI isn’t reachable right now. Try again in a minute.';
  if (e.status === 403) return 'Only owners and admins can build the main offer.';
  if (why === 'budget_reached')
    return 'That’s today’s AI limit for this business. It resets at midnight.';
  if (why === 'ai_not_configured')
    return 'The AI isn’t set up for HandsFreeOS yet, so this can’t run. HandsFreeOS support can switch it on.';
  return e.message;
}
