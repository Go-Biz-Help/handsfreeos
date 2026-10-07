/**
 * What quick setup's screens are given (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7), read the same way on
 * the server and in the browser: `ai_setup.get` through core's own schema, so every default is filled in and core's
 * functions take it as it is.
 */
import {
  AiSetupGetOutput,
  type AiSetupFinding,
  type AiSetupFinishOutput,
  type AiSetupSaveOutput,
} from '@hfos/core';
import type { CellPhone } from '@/lib/api/types';

export type AiSetupGot = ReturnType<typeof AiSetupGetOutput.parse>;
export type AiSetupSaved = ReturnType<typeof AiSetupSaveOutput.parse>;
export type AiSetupFinished = ReturnType<typeof AiSetupFinishOutput.parse>;

export const aiSetupGotOf = (raw: unknown): AiSetupGot => AiSetupGetOutput.parse(raw);

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

/** What the question screens read of it, so the onboarding setup can show them too. */
export type AiSetupScreenData = Pick<
  AiSetupData,
  'workspaceId' | 'cell' | 'businessNumber' | 'appOnPhone'
>;
