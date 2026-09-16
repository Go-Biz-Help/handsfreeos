/**
 * The facts the detectors read, as the loaders fill them in (times are ISO strings), and the shared rules for a
 * lead's value (V) and probability (P). Browser-safe.
 */
import type { WeeklyHours } from '../calendar/config';
import { typicalJobValueCents, type AttentionSettings } from './settings';

/** The business the item belongs to. */
export interface BusinessFacts {
  /** `workspaces.timezone`. */
  readonly timeZone: string;
  /** When it's open: `openHoursOf(workspaces.settings)`. */
  readonly openHours: WeeklyHours;
  /** The median won lead's value over the last 365 days, in cents; null when nothing was won. */
  readonly medianWonCents: number | null;
}

/** Where a lead sits in its pipeline, among the open stages. */
export interface StageFacts {
  readonly id: string;
  readonly name: string;
  /** 0 for the first open stage, by position. */
  readonly index: number;
  /** How many open stages the pipeline has. */
  readonly openStages: number;
}

/** A lead, as the lead detectors read it. */
export interface LeadFacts {
  readonly id: string;
  readonly personId: string | null;
  readonly status: 'open' | 'won' | 'lost';
  readonly archived: boolean;
  readonly valueCents: number;
  readonly createdAt: string;
  /** A person entered it by hand (`leads.created_by` is set): nobody is waiting on a first reply. */
  readonly createdByPerson: boolean;
  /** It came from a spreadsheet: its customer's `import_id` is set, or its source says "Import". Imports never count as new. */
  readonly imported: boolean;
  readonly assigneeUserId: string | null;
  readonly stage: StageFacts;
  readonly stageEnteredAt: string;
  readonly nextAction: string | null;
  readonly nextActionAt: string | null;
  /** `leads.first_response_at`: the business's first reach-out once the lead existed. */
  readonly firstResponseAt: string | null;
  /** `leads.last_contact_at`: the latest real contact, either way. */
  readonly lastContactAt: string | null;
  /** `leads.qualification.status`, or null when it has no qualifying answers. */
  readonly qualification: 'qualified' | 'not_a_fit' | 'incomplete' | null;
  /**
   * When an estimate on this lead went out, while it is still out: sent, unanswered and still good (M9). The
   * estimate's own card is the more exact fact and carries the better action, so while one is out this lead
   * raises neither "Gone quiet" nor "No next action" — two cards for "chase Tom about the quote" is noise.
   * An overdue invoice is different: money owed after the work is its own thing, and keeps its card.
   */
  readonly estimateOutAt: string | null;
}

/** An estimate of this lead's is out and unanswered, so the estimate's card speaks for it. */
export function leadHasEstimateOut(lead: LeadFacts): boolean {
  return lead.estimateOutAt !== null;
}

/** The lead behind an appointment, approval, conversation or task: only for its value. */
export interface LinkedLeadFacts {
  readonly id: string;
  readonly valueCents: number;
  readonly status: 'open' | 'won' | 'lost';
}

/** V, and whether it counts in "$ affected". */
export interface ValueFacts {
  readonly value: number;
  readonly valueIsEstimate: boolean;
  readonly moneyKey: string | null;
}

/** The lead's own value; with none (or no lead, or a lost one), the typical job value as an estimate. */
export function leadValue(
  lead: LinkedLeadFacts | null,
  business: BusinessFacts,
  settings: AttentionSettings,
): ValueFacts {
  if (lead && lead.valueCents > 0 && lead.status !== 'lost')
    return { value: lead.valueCents, valueIsEstimate: false, moneyKey: `lead:${lead.id}` };
  return {
    value: typicalJobValueCents(settings, business.medianWonCents),
    valueIsEstimate: true,
    moneyKey: null,
  };
}

/** Open and not archived: the only leads the lead detectors look at. */
export function leadIsOpen(lead: LeadFacts): boolean {
  return lead.status === 'open' && !lead.archived;
}

/** A new lead that came in on its own and that nobody has reached out to yet. Imports never count. */
export function neverContacted(lead: LeadFacts): boolean {
  return lead.firstResponseAt === null && !lead.imported && !lead.createdByPerson;
}

export interface ProbabilityFacts {
  readonly stage: StageFacts;
  readonly qualified: boolean;
  readonly readyToBook: boolean;
  readonly repeatCustomer: boolean;
  readonly notAFit: boolean;
}

/**
 * P for a lead: 0.3 at the first open stage rising to 0.7 at the last, plus 0.15 when qualified, 0.15 when ready
 * to book and 0.1 for a repeat customer; "not a fit" multiplies it by 0.4. Between 0.05 and 0.95.
 */
export function leadProbability(f: ProbabilityFacts): number {
  const share =
    f.stage.openStages > 1 ? Math.min(1, Math.max(0, f.stage.index / (f.stage.openStages - 1))) : 0;
  let p = 0.3 + 0.4 * share;
  if (f.qualified) p += 0.15;
  if (f.readyToBook) p += 0.15;
  if (f.repeatCustomer) p += 0.1;
  if (f.notAFit) p *= 0.4;
  return Math.round(Math.min(0.95, Math.max(0.05, p)) * 100) / 100;
}
