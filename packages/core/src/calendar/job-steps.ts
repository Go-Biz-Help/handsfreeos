/**
 * Which visits show their job, and which steps it offers (owner, 2026-11-11: "these don’t fit every industry").
 *
 * A job's steps — On my way, Started, Waiting on parts, Job done — each text the customer, so they only make sense
 * when the team goes to the customer:
 *
 * - **Where the visit is decides.** At the customer's address it shows its job. At the business, online or by phone
 *   it doesn't: a salon chair or a Zoom call has nobody on the way.
 * - **No place set:** the kind of business decides: every home service and trade, plus `JOB_ON_SITE_INDUSTRIES`
 *   (home care, pet sitting, towing and the like).
 * - **Waiting on parts** is only for work that uses parts (`JOB_PARTS_INDUSTRIES`): trades, auto and repair.
 * - **A job already moved past Scheduled** keeps its steps, so it can still be finished after the place or the kind
 *   of business changes.
 *
 * Every booked visit still has a job (M18 step 4); this only decides what the screens offer. The phone, the web,
 * `job.set_status` and the Assistant all follow it. Browser-safe.
 */
import { industryLabel, isHomeServices, type IndustryId } from '../industries';
import type { JobStatus } from '../schemas/job';
import type { LocationKind } from './config';

/** The steps a person taps to move a visit's job along, in order. */
export const JOB_STEPS = ['on_the_way', 'in_progress', 'waiting_on_parts', 'done'] as const;
export type JobStep = (typeof JOB_STEPS)[number];

/**
 * Kinds of business outside home services & trades whose team goes to the customer too. Their visits, and every
 * trade's, still show the job with no place set.
 */
export const JOB_ON_SITE_INDUSTRIES: ReadonlySet<string> = new Set<IndustryId>([
  'property_management',
  'home_care',
  'pet_sitting',
  'auto_detailing',
  'towing',
  'auto_glass',
  'catering',
  'photography',
  'entertainment',
  'equipment_rental',
  'party_rentals',
  'dumpster_rental',
  'portable_toilets',
  'it_services',
  'courier',
  'security_services',
]);

/** Kinds of business whose work can wait on parts: trades, auto and repair. */
export const JOB_PARTS_INDUSTRIES: ReadonlySet<string> = new Set<IndustryId>([
  'home_services',
  'hvac',
  'plumbing',
  'electrical',
  'roofing',
  'handyman',
  'general_contracting',
  'remodeling',
  'irrigation',
  'flooring',
  'cabinets_countertops',
  'windows_doors',
  'siding_gutters',
  'garage_doors',
  'fencing_decks',
  'concrete_masonry',
  'foundation_waterproofing',
  'insulation',
  'solar',
  'pool_spa',
  'appliance_repair',
  'locksmith',
  'home_security',
  'restoration',
  'chimney',
  'septic',
  'water_treatment',
  'property_management',
  'auto_repair',
  'auto_body',
  'auto_glass',
  'boat_rv',
  'it_services',
]);

export interface JobFitInput {
  /** Where the visit is (`appointments.location.kind`); null or left out when no place was set. */
  readonly locationKind?: LocationKind | string | null;
  /** The business's kind (`workspaces.industry`). */
  readonly industry?: string | null;
  /** The job's status now. */
  readonly status?: JobStatus | string | null;
}

/**
 * Where a visit is, from its saved place (`appointments.location`, as an object or the phone's JSON text): null when
 * none was set.
 */
export function placeKindOf(location: unknown): string | null {
  let place = location;
  if (typeof place === 'string') {
    try {
      place = JSON.parse(place);
    } catch {
      return null;
    }
  }
  const kind = (place as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && kind ? kind : null;
}

const moving = (status: string | null | undefined) =>
  !!status && status !== 'scheduled' && status !== 'cancelled';

/** Whether a visit shows its job: the buttons on the phone, the Job section on the web. */
export function jobFits(i: JobFitInput): boolean {
  if (moving(i.status)) return true;
  if (i.locationKind === 'customer_address') return true;
  if (i.locationKind) return false;
  return isHomeServices(i.industry) || JOB_ON_SITE_INDUSTRIES.has(i.industry ?? '');
}

/** The steps a job offers, in order: Waiting on parts only where the work uses parts, or the job already waits. */
export function jobSteps(i: Pick<JobFitInput, 'industry' | 'status'>): readonly JobStep[] {
  return JOB_PARTS_INDUSTRIES.has(i.industry ?? '') || i.status === 'waiting_on_parts'
    ? JOB_STEPS
    : JOB_STEPS.filter((s) => s !== 'waiting_on_parts');
}

const PLACE_WORDS: Readonly<Record<string, string>> = {
  business: 'at the business',
  virtual: 'online',
  phone: 'by phone',
};

/**
 * Why a job can't move to a status, in words for the person, or null when it can. Going back to the status it has
 * already, or only changing the note, is always fine.
 */
export function jobStepRefusal(
  i: JobFitInput & { readonly title: string; readonly to: JobStatus | string },
): { rule: 'job_not_on_site' | 'job_no_parts'; message: string } | null {
  const from = i.status ?? 'scheduled';
  if (i.to === from) return null;
  if (!jobFits(i)) {
    const where = i.locationKind ? PLACE_WORDS[i.locationKind] : null;
    return {
      rule: 'job_not_on_site',
      message: where
        ? `“${i.title}” is ${where}, so it has no job steps like On my way. They’re for visits at the customer’s address. If the team is going to the customer, change where the visit is first.`
        : `“${i.title}” has no place set, so it has no job steps like On my way. If the team is going to the customer, set where the visit is to the customer’s address first.`,
    };
  }
  if (i.to === 'scheduled') return null;
  if (!(jobSteps({ industry: i.industry, status: from }) as readonly string[]).includes(i.to)) {
    const kind = i.industry ? industryLabel(i.industry) : null;
    return {
      rule: 'job_no_parts',
      message: `Waiting on parts is only for trades, auto and repair work${
        kind ? `, and this business is “${kind}”` : ''
      }. Mark it Started or Done instead, or change the kind of business in Settings → Workspace.`,
    };
  }
  return null;
}
