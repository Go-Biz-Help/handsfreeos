'use client';
import {
  offerAiWords,
  type MainOfferNotes,
  type MainOfferParts,
  type MainOfferScore,
  type OfferAssistMode,
  type OfferAssistOutput,
  type OfferAssistPath,
  type OfferNicheOption,
  type ScoredPart,
} from '@hfos/core';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { MainOfferTry } from '@/lib/api/types';
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

/** The owner's direction for the whole offer; empty clears it. Moves the draft's revision on. */
export async function saveOfferDirection(workspaceId: string, revision: number, direction: string) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/main_offer.save_direction', {
      body: { workspaceId, revision, direction },
    }),
  );
}

/** Takes the picked parts of a try into the draft; says whether the try's line came too. */
export async function applyOfferTry(
  workspaceId: string,
  revision: number,
  tryId: string,
  take: ScoredPart[],
) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/main_offer.try_apply', {
      body: { workspaceId, revision, tryId, take },
    }),
  );
}

/** A try of the whole offer from the draft at this revision, the notes and the parts to keep, scored and kept. */
export function makeOfferTry(
  workspaceId: string,
  revision: number,
  notes: MainOfferNotes,
  keep: ScoredPart[],
): Promise<{ saved: boolean; try: MainOfferTry | null }> {
  return workerPost('/v1/main-offer/try', { workspaceId, revision, notes, keep });
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

/** Why the AI didn't help, in plain words (core's, so the phone says the same). */
export function offerAiError(e: unknown): string {
  return e instanceof ApiError ? offerAiWords(e) : errorMessage(e);
}
