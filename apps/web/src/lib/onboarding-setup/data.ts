/**
 * What the onboarding setup's screens are given (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7), read
 * the same way on the server and in the browser: `onboarding_setup.get` through core's own schema, so every default
 * is filled in and core's functions take it as it is.
 */
import {
  OnboardingSetupGetOutput,
  type AiSetupFinding,
  type OnboardingSetupFinishOutput,
  type OnboardingSetupSaveOutput,
  type OnboardingSetupScreen,
} from '@hfos/core';
import type { ComponentProps } from 'react';
import type { TextingPage } from '@/components/settings/texting-page';
import type { CellPhone } from '@/lib/api/types';

export type OnboardingSetupGot = ReturnType<typeof OnboardingSetupGetOutput.parse>;
export type OnboardingSetupSaved = ReturnType<typeof OnboardingSetupSaveOutput.parse>;
export type OnboardingSetupFinished = ReturnType<typeof OnboardingSetupFinishOutput.parse>;

export const onboardingSetupGotOf = (raw: unknown): OnboardingSetupGot =>
  OnboardingSetupGetOutput.parse(raw);

/**
 * The setup's own page, on a screen: where a stop that leaves for a sign-in or a payment comes back to. `ownerPart`:
 * the owner is finishing their part of what their agency set up (`?part=owner`), walking only their own screens.
 */
export const onboardingSetupHref = (
  workspaceId: string,
  screen?: OnboardingSetupScreen,
  ownerPart = false,
) => `/onboarding/${workspaceId}${screen ? `?at=${screen}${ownerPart ? '&part=owner' : ''}` : ''}`;

/** "Where are your customers now?": GoHighLevel's connection and its move, and what this person may start. */
export interface OnboardingCustomersData {
  /** GoHighLevel, connected and ready to move from. */
  readonly connection: { readonly id: string; readonly sourceLabel: string } | null;
  /** The newest move not finished or stopped: still counting (`running`), or waiting for a look. */
  readonly move: { readonly id: string; readonly running: boolean; readonly words: string } | null;
  readonly canImport: boolean;
  readonly canMigrate: boolean;
}

/** Everything the screens start from. */
export interface OnboardingSetupData {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly got: OnboardingSetupGot;
  /** What the newest website scan found that's still waiting, for "What Ava learned". */
  readonly findings: readonly AiSetupFinding[];
  /** "Stay in the loop": the person's own cell, and the business number that calls it to confirm it. */
  readonly cell: CellPhone | null;
  readonly businessNumber: string | null;
  /** The person has the phone app on a phone. */
  readonly appOnPhone: boolean;
  /** The business's own domain when one is serving: the booking page and the chat's code load from it. */
  readonly brandedOrigin: string | null;
  /** The screen the setup opens on; what follows is there only when the page was drawn for its screen. */
  readonly at: OnboardingSetupScreen;
  /**
   * Opened part way through without a screen in its address (Home's Carry on, or a bookmark), so it says it carries
   * on where they left off. Moving on, loading the page again and coming back from a sign-in all name the screen.
   */
  readonly resumed: boolean;
  /**
   * The owner opened what their agency set up for them without a screen in its address (the invitation's link, or
   * Home's card): it opens on what the agency did, to check, with "Change something" and "Finish my part".
   */
  readonly checking: boolean;
  /** "Finish my part": the owner walks only the screens that are theirs to do (`?part=owner`). */
  readonly ownerPart: boolean;
  /** The number stop: Settings → Texting & calls as it is, or null when this person can't manage the channels. */
  readonly texting?: ComponentProps<typeof TextingPage> | null;
  /** The customers stop. */
  readonly customers?: OnboardingCustomersData;
}
