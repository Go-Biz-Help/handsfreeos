/**
 * The admin side's Getting started counts (plan §9), from `private.admin_onboarding_counts`: one row per measure,
 * shaped for the page. Every step is listed, the most skipped first, so a step nobody skips still shows.
 */
import type { z } from 'zod';
import type { OnboardingCountsOutput } from '../schemas/onboarding';
import { BUSINESS_STEPS, isBusinessStep, PERSONAL_STEPS } from './steps';

export type OnboardingCountRow = {
  readonly measure: string;
  readonly step: string | null;
  /** Postgres's `bigint` arrives as text. */
  readonly count: number | string;
};

type Counts = z.infer<typeof OnboardingCountsOutput>;

export function shapeOnboardingCounts(rows: readonly OnboardingCountRow[], since: Date): Counts {
  const one = (measure: string, step: string | null = null) =>
    Number(rows.find((r) => r.measure === measure && r.step === step)?.count ?? 0);
  const order = [...BUSINESS_STEPS, ...PERSONAL_STEPS];
  const steps = order
    .map((key) => ({
      key,
      for: isBusinessStep(key) ? ('business' as const) : ('person' as const),
      skipped: one('skipped', key),
      broughtBack: one('brought_back', key),
    }))
    .sort((a, b) => b.skipped - a.skipped || order.indexOf(a.key) - order.indexOf(b.key));
  return {
    since: since.toISOString(),
    started: one('started'),
    asYouGo: one('as_you_go'),
    finished: {
      businesses: one('finished'),
      nothingSkipped: one('finished_clean'),
      teammates: one('finished_team'),
    },
    hidden: one('hidden'),
    turnedOff: one('turned_off'),
    steps,
  };
}
