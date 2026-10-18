/**
 * A business's partner settings (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2): the share partners earn
 * unless they have their own, the terms they accept on their page, the smallest payout (decision 17) and the
 * calendar their links book. Kept in `workspaces.settings.partners`, changed only by `partners.save_settings`
 * (`partners.manage`), as the money settings are.
 *
 * Browser-safe.
 */
import { z } from 'zod';

/** A share in basis points: 1,000 is 10%. */
export const DEFAULT_PARTNER_RATE_BP = 1_000;
/** The smallest payout (decision 17): $25 unless the business sets a lower one, never below $1. */
export const SMALLEST_PAYOUT_CENTS = 2_500;
export const SMALLEST_PAYOUT_LEAST_CENTS = 100;
export const PARTNER_TERMS_MOST = 20_000;

export const PartnerSettings = z.object({
  /** What partners earn of what their clients pay, unless they have their own rate. */
  rateBp: z.int().min(1).max(10_000).default(DEFAULT_PARTNER_RATE_BP),
  /** What partners accept on their page; empty until the business writes some. */
  terms: z.string().trim().max(PARTNER_TERMS_MOST).default(''),
  /** Goes up whenever the terms change, so partners accept the new ones. */
  termsVersion: z.int().min(0).default(0),
  /** A partner owed less than this has it carried to the next month. */
  smallestPayoutCents: z
    .int()
    .min(SMALLEST_PAYOUT_LEAST_CENTS)
    .max(SMALLEST_PAYOUT_CENTS)
    .default(SMALLEST_PAYOUT_CENTS),
  /** The calendar partners' links book; null for the business's first public one. */
  calendarId: z.uuid().nullable().default(null),
});
export type PartnerSettings = z.output<typeof PartnerSettings>;

/** The business's partner settings from its settings document, every default filled in. */
export function partnerSettingsOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): PartnerSettings {
  const parsed = PartnerSettings.safeParse(settings?.['partners'] ?? {});
  return parsed.success ? parsed.data : PartnerSettings.parse({});
}
