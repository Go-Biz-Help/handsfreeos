/**
 * Real Estate Agent's settings for a business (Settings → Real Estate; HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md,
 * step 12), checked by core on every save (`addon.save_settings`, `realestate.manage`). Browser-safe and small: the
 * manifest carries it.
 */
import { z } from 'zod';

/** The business's settings for the add-on (Settings → Real Estate), checked on every save. */
export const RealestateSettingsSchema = z.object({
  /**
   * Who hears about critical alerts besides the deal's own team: owners, or people who see every deal. None
   * named: the owners.
   */
  alertPersonUserIds: z.array(z.uuid()).max(10).default([]),
  /** Days the business is closed besides weekends and federal holidays, each with a word. */
  closedDays: z
    .record(z.iso.date(), z.string().trim().max(60))
    .refine((d) => Object.keys(d).length <= 60, { error: 'Up to 60 closed days.' })
    .default({}),
  /** Client updates the Assistant drafts at each milestone (step 13). */
  milestoneDrafts: z
    .object({
      under_contract: z.boolean(),
      inspection_done: z.boolean(),
      clear_to_close: z.boolean(),
      closed: z.boolean(),
    })
    .default({ under_contract: true, inspection_done: true, clear_to_close: true, closed: true }),
});
export type RealestateSettings = z.infer<typeof RealestateSettingsSchema>;
