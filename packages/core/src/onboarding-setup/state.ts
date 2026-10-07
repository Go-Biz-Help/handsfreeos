/**
 * What the onboarding setup starts from: what the business has today, as `onboarding_setup.get` reads it
 * (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5). It is the AI quick setup's state, since the AI
 * part's screens and plan work from it, with what the setup's own stops need beside it: the address, the business
 * number, payments, customers, booking, the team and the price list. The picks, the plan and the summary are all
 * worked out from it and the answers, the same way on the web, on the phone and in the commands. Browser-safe.
 */
import { z } from 'zod';
import { aiSetupStateOf, AiSetupStateOut, type AiSetupState } from '../ai-setup/state';
import { WeeklyHours } from '../calendar/config';
import { BusinessLookSchema } from '../look/look';
import { OnboardingAnswersSchema } from '../onboarding/settings';
import { phoneNextStep } from '../schemas/telephony';
import { BusinessAddress } from './address';

const id = z.uuid();

export const OnboardingSetupStateOut = AiSetupStateOut.extend({
  /** Getting started's quick questions, when they were answered before (today's screens, or an agency). */
  quick: OnboardingAnswersSchema.nullable(),
  /** "Your business"'s address; null until it's given. */
  address: BusinessAddress.nullable(),
  /** The Google review link the thank-you text sends (Settings → Workspace); null when there's none. */
  reviewLink: z.string().nullable(),
  /** The business number and the carriers' review, as Getting started reads them. */
  numberSetup: z.object({
    next: phoneNextStep,
    /** The number as people read it, "(512) 555-0148". */
    display: z.string().nullable(),
    /** When the details went to the carriers, while they're reviewing them. */
    since: z.iso.datetime().nullable(),
    rejectionReason: z.string().nullable(),
  }),
  payments: z.object({
    active: z.boolean(),
    /** Connected, and the provider still checking it. */
    checking: z.boolean(),
    needsInfo: z.boolean(),
    broken: z.boolean(),
    provider: z.enum(['stripe', 'square']).nullable(),
  }),
  customers: z.object({
    /** People and companies, as Home counts them. */
    count: z.int(),
    /** A spreadsheet importing, or a move from another CRM counting or moving. */
    running: z.enum(['import', 'migration']).nullable(),
    /** A move from another CRM has counts to check, or something to look at. */
    migrationNeedsYou: z.boolean(),
    /** "Add them as you go" was picked. */
    asYouGo: z.boolean(),
  }),
  booking: z.object({
    /** A calendar customers can book is on, and so is the booking site: customers can book. */
    on: z.boolean(),
    /** The booking site, whose name is its address (`/book/<slug>`); null before it has one. */
    site: z.object({ slug: z.string(), name: z.string(), enabled: z.boolean() }).nullable(),
  }),
  team: z.object({
    members: z.int(),
    /** Invitations still waiting, by email. */
    invited: z.array(z.string()),
  }),
  /** Calendars → Services, with their lengths and prices, beside the AI part's names. */
  bookable: z.array(
    z.object({ id, name: z.string(), minutes: z.int(), priceCents: z.int().nullable() }),
  ),
  /** The price list (Settings → Payments → Price list), what isn't archived. */
  priceList: z.array(
    z.object({
      id,
      name: z.string(),
      priceCents: z.int(),
      serviceId: id.nullable(),
    }),
  ),
  /** The hours the person setting up has saved for themselves; null while they have the default. */
  myHours: WeeklyHours.nullable(),
  /** Phones this person gets notifications on: the phone app is in. */
  phones: z.int(),
  /** The business's logo and colour, and where the logo's being looked for or made ready (look/look.ts). */
  look: BusinessLookSchema,
});
export type OnboardingSetupStateOut = z.infer<typeof OnboardingSetupStateOut>;

export interface OnboardingSetupState
  extends AiSetupState, Omit<OnboardingSetupStateOut, keyof AiSetupStateOut> {}

/** The state as the functions here take it, with the AI teammate's settings read (every default filled in). */
export function onboardingSetupStateOf(
  out: OnboardingSetupStateOut | OnboardingSetupState,
): OnboardingSetupState {
  return { ...out, ...aiSetupStateOf(out) };
}
