/**
 * What a duty is, in the catalog (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Duties"; spec §5, §8, §13–§16).
 * Browser-safe and pure. Every row of the specification is a DutyDef; its tracker (one of the 24 in §16) supplies
 * whatever the row doesn't say, so a row writes only what differs.
 */
import type { DueRule } from '../dates/due';
import type { KeyDateKey } from '../dates/key-dates';
import type { DealSide, DealStage } from '../states';

export const TRACKER_CODES = [
  'LEAD',
  'REP',
  'FIN',
  'SEARCH',
  'SHOW',
  'CMA',
  'OFFER',
  'CONTRACT',
  'INSPECT',
  'REPAIR',
  'APPRAISAL',
  'TITLE',
  'LISTING',
  'MARKET',
  'VENDOR',
  'OPEN',
  'CLOSE',
  'POSSESS',
  'DOC',
  'COMPLY',
  'HEALTH',
  'POST',
  'SAFETY',
  'MOVE',
] as const;
export type TrackerCode = (typeof TRACKER_CODES)[number];

/** How far HandsFreeOS may go on its own (spec §8). Deny wins: AX is never automatic. */
export const AUTOMATION_LEVELS = ['A0', 'A1', 'A2', 'A3', 'A4', 'AX'] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];
export const AUTOMATION_LEVEL_WORDS: Readonly<
  Record<AutomationLevel, { readonly label: string; readonly means: string }>
> = {
  A0: { label: 'Observe', means: 'HandsFreeOS keeps track; a person does the work.' },
  A1: {
    label: 'Prepare',
    means: 'HandsFreeOS researches, summarizes or drafts; a person uses it.',
  },
  A2: {
    label: 'Coordinate',
    means: 'HandsFreeOS proposes times, asks for status and chases proof, under approved wording.',
  },
  A3: {
    label: 'After approval',
    means: 'HandsFreeOS sends or changes something only after the named person says yes.',
  },
  A4: {
    label: 'Automatic',
    means: 'HandsFreeOS does routine, low-risk steps on its own, within the business’s rules.',
  },
  AX: {
    label: 'Never automatic',
    means: 'HandsFreeOS only points it out; a qualified person acts.',
  },
};

/** How much it matters when it slips: health and alerts lean on this (step 10). */
export const MATERIALITIES = ['standard', 'material', 'critical'] as const;
export type Materiality = (typeof MATERIALITIES)[number];

/**
 * Who on the team answers for it: the deal's agent (its main agent), its coordinator (the agent when there's none),
 * or the brokerage (owners and admins). One, always (spec §5).
 */
export const ACCOUNTABLE_ROLES = ['agent', 'coordinator', 'broker'] as const;
export type AccountableRole = (typeof ACCOUNTABLE_ROLES)[number];

/** Who does the work when it isn't the team: the client, or someone from outside. */
export const PERFORMERS = [
  'client',
  'lender',
  'title',
  'inspector',
  'appraiser',
  'vendor',
  'other_agent',
  'attorney',
  'hoa',
  'insurer',
] as const;
export type Performer = (typeof PERFORMERS)[number];

/** The kinds of document on a deal (step 9's `documents` table uses the same list). */
export const DOCUMENT_KINDS = {
  buyer_agreement: 'Buyer agreement',
  listing_agreement: 'Listing agreement',
  agency_disclosure: 'Agency disclosure',
  seller_disclosure: 'Seller’s disclosure',
  preapproval: 'Preapproval letter',
  cma: 'CMA',
  net_sheet: 'Seller net sheet',
  offer: 'Offer',
  counter: 'Counteroffer',
  contract: 'Purchase contract',
  amendment: 'Amendment',
  addendum: 'Addendum',
  emd_receipt: 'Earnest money receipt',
  inspection_report: 'Inspection report',
  repair_request: 'Repair request',
  repair_agreement: 'Repair agreement',
  invoice: 'Invoice',
  photo: 'Photo',
  permit: 'Permit',
  appraisal: 'Appraisal',
  loan_approval: 'Loan approval',
  clear_to_close: 'Clear to close',
  rate_lock: 'Rate lock',
  insurance_binder: 'Insurance binder',
  title_commitment: 'Title commitment',
  payoff_statement: 'Payoff statement',
  hoa_docs: 'HOA documents',
  survey: 'Survey',
  closing_disclosure: 'Closing Disclosure',
  settlement_statement: 'Settlement statement',
  walkthrough_checklist: 'Walkthrough checklist',
  home_warranty: 'Home warranty',
  deed: 'Deed',
  mls_listing: 'MLS listing',
  marketing: 'Marketing piece',
  termination: 'Termination',
  emd_release: 'Earnest money release',
  other: 'Other document',
} as const;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;

/** A value on the deal itself being filled in. */
export const DEAL_FIELDS = {
  expected_commission: 'Expected commission',
  final_commission: 'Final commission',
  property: 'The property',
  client: 'The client',
} as const;
export type DealField = keyof typeof DEAL_FIELDS;

/** One thing that shows a duty was done. */
export type ProofItem =
  /** A document of one of these kinds on the deal; `signed`: marked signed (and so locked, step 3). */
  | {
      readonly kind: 'document';
      readonly documents: readonly DocumentKind[];
      readonly signed?: boolean;
    }
  /** Any file on the deal. */
  | { readonly kind: 'file' }
  /** A note of what was done. */
  | { readonly kind: 'note' }
  /** A person saying so, in these words ("I was at the inspection"). */
  | { readonly kind: 'attestation'; readonly words: string }
  /** An appointment about the deal. */
  | { readonly kind: 'appointment' }
  /** A message to or from someone on the deal. */
  | { readonly kind: 'message' }
  /** Key dates entered and confirmed. */
  | { readonly kind: 'dates'; readonly keys: readonly KeyDateKey[] }
  /** A value on the deal filled in. */
  | { readonly kind: 'deal_field'; readonly field: DealField };

/** What finishes a duty: all of the items, or any one. None: marking it done is enough. */
export interface ProofRule {
  readonly mode: 'all' | 'any';
  readonly items: readonly ProofItem[];
}

/** Named moments on a deal that create duties. */
export const DEAL_EVENTS = [
  'offer_received',
  'offer_lost',
  'inspection_report',
  'repair_request',
  'repairs_agreed',
  'low_appraisal',
  'amendment',
  'terminated',
  'closed',
  /** Closed, or ended any other way. */
  'deal_ended',
  /** An offer lost or a contract terminated. */
  'deal_failed',
  /** A listing withdrawn, expired or cancelled. */
  'listing_ended',
  'search_changed',
] as const;
export type DealEvent = (typeof DEAL_EVENTS)[number];

/** Facts about a deal or its home that some duties depend on. */
export const DEAL_FACTS = {
  financed: 'Paid for with a loan',
  first_time_buyer: 'First-time buyer',
  hoa: 'Has an HOA or condo association',
  survey: 'Needs a survey',
  well: 'Well water',
  septic: 'Septic system',
  solar: 'Solar panels',
  pool: 'Pool',
  propane: 'Propane',
  private_road: 'Private road',
  specialists_needed: 'Specialists needed after inspection',
  multiple_offers: 'More than one offer',
  open_house: 'Open houses planned',
  backup_offer: 'A backup offer',
  seller_has_mortgage: 'Seller has a mortgage to pay off',
  home_warranty: 'Home warranty in the contract',
  relocation: 'Relocating',
  wants_move_help: 'Wants help moving',
  linked_sale: 'Tied to the client’s other deal',
} as const;
export type DealFact = keyof typeof DEAL_FACTS;

/** What creates a duty. */
export type DutyTrigger =
  /** Entering the stage, or passing through it. */
  | { readonly on: 'stage'; readonly stage: DealStage }
  /** A key date confirmed. */
  | { readonly on: 'dates'; readonly key: KeyDateKey }
  /** A named moment. */
  | { readonly on: 'event'; readonly event: DealEvent };

/** A trigger, or one per side for a row on both. */
export type DutyTriggers =
  DutyTrigger | { readonly buyer?: DutyTrigger; readonly listing?: DutyTrigger };

export type DutyId = `${'B' | 'S' | 'X'}-${string}`;

export interface DutyDef {
  readonly id: DutyId;
  readonly side: DealSide | 'both';
  readonly title: string;
  /** The specification's phase, for reading ("Onboarding", "Both / closing"). */
  readonly phase: string;
  /** What HandsFreeOS does about it, from the specification. */
  readonly behavior: string;
  /** The specification's own words for who owns it, and how much HandsFreeOS takes on. */
  readonly spec: { readonly owner: string; readonly mode: string; readonly share: string };
  readonly tracker: TrackerCode;
  readonly trigger: DutyTriggers;
  /** Created only when every one of these holds. */
  readonly when?: readonly DealFact[];
  /** Created only when at least one of these holds. */
  readonly whenAny?: readonly DealFact[];
  /** The first time through its stage only, or only later times (a second offer). */
  readonly round?: 'first' | 'later';
  readonly due: DueRule;
  readonly proof?: ProofRule | null;
  readonly accountable?: AccountableRole;
  readonly performedBy?: readonly Performer[];
  readonly automation: AutomationLevel;
  readonly materiality?: Materiality;
  /** Days before it's due to remind. */
  readonly reminders?: readonly number[];
  /** How the product behaves rather than a duty on each deal (X-13, X-14, X-44, X-45; Chris, 2026-09-30). */
  readonly perDeal?: false;
}

/** A tracker template (spec §16): its words, and what each of its duties gets unless it says otherwise. */
export interface TrackerDef {
  readonly code: TrackerCode;
  readonly name: string;
  readonly trigger: string;
  readonly dueLogic: string;
  readonly evidence: string;
  readonly dependencies: string;
  readonly escalation: string;
  readonly defaults: {
    readonly proof: ProofRule | null;
    readonly materiality: Materiality;
    readonly accountable: AccountableRole;
    readonly reminders: readonly number[];
  };
}

/** A duty with its tracker's defaults filled in: what a published list keeps for each item (step 12). */
export interface ResolvedDuty extends Omit<
  DutyDef,
  'proof' | 'accountable' | 'materiality' | 'reminders'
> {
  readonly proof: ProofRule | null;
  readonly accountable: AccountableRole;
  readonly materiality: Materiality;
  readonly reminders: readonly number[];
}
