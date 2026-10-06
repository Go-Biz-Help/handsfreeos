/**
 * What quick setup's screens are given (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7), read the same way on
 * the server and in the browser: `ai_setup.get` through core's own schema, so every default is filled in and core's
 * functions take it as it is.
 */
import { AiSetupGetOutput, type AiSetupFinishOutput, type AiSetupSaveOutput } from '@hfos/core';
import type { CellPhone, KnowledgeSuggestion } from '@/lib/api/types';

export type AiSetupGot = ReturnType<typeof AiSetupGetOutput.parse>;
export type AiSetupSaved = ReturnType<typeof AiSetupSaveOutput.parse>;
export type AiSetupFinished = ReturnType<typeof AiSetupFinishOutput.parse>;

export const aiSetupGotOf = (raw: unknown): AiSetupGot => AiSetupGetOutput.parse(raw);

/** One thing the website scan found, as "What Ava learned" lists it. */
export interface AiSetupFinding {
  readonly id: string;
  readonly kind: KnowledgeSuggestion['kind'];
  readonly title: string;
  readonly body: string;
}

/**
 * The scan's findings nobody has kept or turned down yet, in the order it found them. The list comes newest first;
 * turned around, what arrives while the scan runs joins at the end, so nothing moves while the person ticks.
 */
export const findingsOf = (items: readonly KnowledgeSuggestion[]): AiSetupFinding[] =>
  items
    .filter((s) => s.status === 'pending' && s.reason === 'scan')
    .map((s) => ({ id: s.id, kind: s.kind, title: s.proposed.title, body: s.proposed.body }))
    .reverse();

/** Everything the screens start from. */
export interface AiSetupData {
  readonly workspaceId: string;
  readonly got: AiSetupGot;
  /** What the newest website scan found that's still waiting. */
  readonly findings: readonly AiSetupFinding[];
  /** "Stay in the loop": the person's own cell, and the business number that calls it to confirm it. */
  readonly cell: CellPhone | null;
  readonly businessNumber: string | null;
  /** The person has the phone app on a phone. */
  readonly appOnPhone: boolean;
  /** The business's own domain when one is serving: the chat's code loads from it. */
  readonly brandedOrigin: string | null;
}
