import type { paths } from '@hfos/api-client';
import {
  MainOfferGetOutput,
  MainOfferPublishOutput,
  MainOfferSaveDirectionOutput,
  MainOfferSaveDraftOutput,
  MainOfferTriesOutput,
  offerAiWords,
  type MainOfferNotes,
  type MainOfferParts,
  type MainOfferScore,
  type MainOfferTryOut,
  type ScoredPart,
} from '@hfos/core';

import { api, ApiError, errorMessage, unwrap } from '@/lib/api';
import { workerPost } from '@/lib/worker';

/**
 * Settings → Main offer's calls from the phone (HANDSFREEOS_MAIN_OFFER_PHONE_IMPLEMENTATION_PLAN.md), as the web's
 * lib/main-offer/actions.ts makes them: the offer and this round's tries, a part edited, the direction, going live,
 * and the AI's score and tries from the worker. All of them need signal: none goes into the queue of changes, because
 * each is for the draft as the server has it now (its revision).
 */

/** What a command takes, from the API's own description of it. */
type In<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

export type MainOffer = ReturnType<typeof MainOfferGetOutput.parse>;
export type MainOfferTry = ReturnType<typeof MainOfferTryOut.parse>;

export function mainOfferCalls(workspaceId: string) {
  return {
    /** Read through core's schema, so every default is filled in and core's functions take it as it is. */
    get: async (): Promise<MainOffer> =>
      MainOfferGetOutput.parse(
        unwrap(await api.POST('/v1/queries/main_offer.get', { body: { workspaceId } })),
      ),
    /** This round's tries, the newest first. */
    tries: async (): Promise<MainOfferTry[]> =>
      MainOfferTriesOutput.parse(
        unwrap(await api.POST('/v1/queries/main_offer.tries', { body: { workspaceId } })),
      ).tries,
    /** Keeps the draft as it is now; the revision it's at after. */
    saveDraft: async (revision: number, parts: MainOfferParts): Promise<number> =>
      MainOfferSaveDraftOutput.parse(
        unwrap(
          await api.POST('/v1/commands/main_offer.save_draft', {
            body: {
              workspaceId,
              revision,
              parts: parts as unknown as In<'/v1/commands/main_offer.save_draft'>['parts'],
            },
          }),
        ),
      ).revision,
    /** Keeps the owner's direction (blank clears it); the revision it's at after. */
    saveDirection: async (revision: number, direction: string): Promise<number> =>
      MainOfferSaveDirectionOutput.parse(
        unwrap(
          await api.POST('/v1/commands/main_offer.save_direction', {
            body: { workspaceId, revision, direction },
          }),
        ),
      ).revision,
    /** Puts the draft live; under the bar, only with why. The version it became. */
    publish: async (revision: number, anyway?: string): Promise<number> =>
      MainOfferPublishOutput.parse(
        unwrap(
          await api.POST('/v1/commands/main_offer.publish', {
            body: { workspaceId, revision, ...(anyway ? { anyway } : {}) },
          }),
        ),
      ).version,
    /** The AI's score of the draft as it's kept at this revision, kept with it. */
    score: (revision: number): Promise<{ saved: boolean; score: MainOfferScore }> =>
      workerPost('/v1/main-offer/score', { workspaceId, revision }),
    /** A try of the whole offer from the draft at this revision, the notes and the parts to keep, scored and kept. */
    makeTry: (
      revision: number,
      notes: MainOfferNotes,
      keep: readonly ScoredPart[],
    ): Promise<{ saved: boolean; try: MainOfferTry | null }> =>
      workerPost('/v1/main-offer/try', { workspaceId, revision, notes, keep }),
  };
}

export type MainOfferCalls = ReturnType<typeof mainOfferCalls>;

/** Why the AI didn't help, in plain words: core's, as the web says it. */
export function offerAiError(e: unknown): string {
  return e instanceof ApiError ? offerAiWords(e) : errorMessage(e);
}

/** Whether someone else changed the draft meanwhile: the screen asks for the offer again. */
export const draftMoved = (e: unknown): boolean =>
  e instanceof ApiError && e.rule === 'main_offer_draft_moved';
