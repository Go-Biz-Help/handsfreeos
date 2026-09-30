/**
 * Where a deal and a duty stand (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Deals" and "Duties"; spec §6, §10,
 * §11). Browser-safe and pure: the commands, the screens and the Assistant all read these.
 *
 * - **A deal** moves forward to any later stage of its side. It moves back only through a named event (an offer
 *   lost, a contract terminated, a listing back on the market), which keeps its history; a listing can also end as
 *   withdrawn, expired or cancelled, and come back from any of them.
 * - **A duty** is draft, waiting for approval, not started, in progress, waiting on someone, blocked, completed,
 *   waived or cancelled. Overdue is worked out from its due time, never stored.
 */

// ---------- deals ----------

export const DEAL_SIDES = ['buyer', 'listing'] as const;
export type DealSide = (typeof DEAL_SIDES)[number];

export const BUYER_STAGES = [
  'lead',
  'onboarding',
  'representation',
  'financing',
  'searching',
  'touring',
  'offer',
  'negotiation',
  'under_contract',
  'inspections',
  'appraisal',
  'financing_title',
  'closing',
  'possession',
  'past_client',
] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];

export const LISTING_STAGES = [
  'seller_lead',
  'consultation',
  'signed',
  'pre_listing',
  'coming_soon',
  'active',
  'showings',
  'offers',
  'negotiation',
  'under_contract',
  'inspection',
  'appraisal',
  'financing_title',
  'closing',
  'sold',
  'past_client',
] as const;
/** Where a listing ends without selling: stages of their own, each able to come back on the market. */
export const LISTING_EXITS = ['withdrawn', 'expired', 'cancelled'] as const;
export type ListingStage = (typeof LISTING_STAGES)[number] | (typeof LISTING_EXITS)[number];

export type DealStage = BuyerStage | ListingStage;

export const STAGE_LABELS: Readonly<Record<DealStage, string>> = {
  lead: 'Lead',
  onboarding: 'Onboarding',
  representation: 'Representation',
  financing: 'Financing',
  searching: 'Searching',
  touring: 'Touring',
  offer: 'Offer',
  negotiation: 'Negotiation',
  under_contract: 'Under contract',
  inspections: 'Inspections',
  appraisal: 'Appraisal',
  financing_title: 'Financing and title',
  closing: 'Closing',
  possession: 'Possession',
  past_client: 'Past client',
  seller_lead: 'Seller lead',
  consultation: 'Consultation',
  signed: 'Signed',
  pre_listing: 'Pre-listing',
  coming_soon: 'Coming soon',
  active: 'Active',
  showings: 'Showings',
  offers: 'Offers',
  inspection: 'Inspection',
  sold: 'Sold',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** A side's stages in order (a listing's ends last). */
export function stagesOf(side: DealSide): readonly DealStage[] {
  return side === 'buyer' ? BUYER_STAGES : [...LISTING_STAGES, ...LISTING_EXITS];
}

/** The stage a new deal starts in. */
export const FIRST_STAGE: Readonly<Record<DealSide, DealStage>> = {
  buyer: 'lead',
  listing: 'seller_lead',
};

export const isStageOf = (side: DealSide, stage: string): stage is DealStage =>
  (stagesOf(side) as readonly string[]).includes(stage);

/** Under contract or later, up to closing: what a contract's dates are about. */
export function underContract(side: DealSide, stage: DealStage): boolean {
  const order = (side === 'buyer' ? BUYER_STAGES : LISTING_STAGES) as readonly string[];
  const at = order.indexOf(stage);
  return at >= order.indexOf('under_contract') && at <= order.indexOf('closing');
}

/** The named moves back, and where each goes. */
export const BACK_EVENTS = {
  buyer: {
    // The offer was turned down or withdrawn: back to looking (B-13, B-14).
    offer_lost: { from: ['offer', 'negotiation'], to: 'touring' },
    // The contract fell through: back to searching (B-26), history kept.
    terminated: {
      from: ['under_contract', 'inspections', 'appraisal', 'financing_title', 'closing'],
      to: 'searching',
    },
  },
  listing: {
    // The contract fell through: back on the market.
    terminated: {
      from: ['under_contract', 'inspection', 'appraisal', 'financing_title', 'closing'],
      to: 'active',
    },
    back_on_market: { from: ['withdrawn', 'expired', 'cancelled'], to: 'active' },
    withdrawn: {
      from: ['signed', 'pre_listing', 'coming_soon', 'active', 'showings', 'offers', 'negotiation'],
      to: 'withdrawn',
    },
    expired: {
      from: ['signed', 'pre_listing', 'coming_soon', 'active', 'showings', 'offers', 'negotiation'],
      to: 'expired',
    },
    cancelled: {
      from: [
        'seller_lead',
        'consultation',
        'signed',
        'pre_listing',
        'coming_soon',
        'active',
        'showings',
        'offers',
        'negotiation',
      ],
      to: 'cancelled',
    },
  },
} as const satisfies Record<
  DealSide,
  Record<string, { readonly from: readonly DealStage[]; readonly to: DealStage }>
>;
export type BackEvent<S extends DealSide = DealSide> = keyof (typeof BACK_EVENTS)[S];

/**
 * How a stage change reads: forward (to any later stage of the side's own run), an event's (only through it), the
 * same stage, or not a move there is.
 */
export function stageMove(
  side: DealSide,
  from: DealStage,
  to: DealStage,
): 'forward' | 'same' | 'needs_event' | 'invalid' {
  if (!isStageOf(side, from) || !isStageOf(side, to)) return 'invalid';
  if (from === to) return 'same';
  const run = (side === 'buyer' ? BUYER_STAGES : LISTING_STAGES) as readonly string[];
  const a = run.indexOf(from);
  const b = run.indexOf(to);
  if (a >= 0 && b > a) return 'forward';
  return 'needs_event';
}

/** Where an event takes a deal from its stage, or null when it can't happen there. */
export function stageAfterEvent(side: DealSide, event: string, from: DealStage): DealStage | null {
  const events = BACK_EVENTS[side] as Readonly<
    Record<string, { readonly from: readonly DealStage[]; readonly to: DealStage }>
  >;
  const e = events[event];
  return e && e.from.includes(from) ? e.to : null;
}

/** The stages from one to another, both included, in the side's order: what a jump passes through. */
export function stagesBetween(side: DealSide, from: DealStage, to: DealStage): DealStage[] {
  const run = (side === 'buyer' ? BUYER_STAGES : LISTING_STAGES) as readonly DealStage[];
  const a = run.indexOf(from);
  const b = run.indexOf(to);
  if (a < 0 || b < 0 || b < a) return [to];
  return run.slice(a, b + 1);
}

// ---------- duties ----------

export const DUTY_STATUSES = [
  'draft',
  'pending_approval',
  'not_started',
  'in_progress',
  'waiting_external',
  'blocked',
  'completed',
  'waived',
  'cancelled',
] as const;
export type DutyStatus = (typeof DUTY_STATUSES)[number];

export const DUTY_STATUS_LABELS: Readonly<Record<DutyStatus, string>> = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  not_started: 'Not started',
  in_progress: 'In progress',
  waiting_external: 'Waiting on someone',
  blocked: 'Blocked',
  completed: 'Done',
  waived: 'Waived',
  cancelled: 'Cancelled',
};

/** Finished one way or another. */
export const DONE_DUTY_STATUSES = [
  'completed',
  'waived',
  'cancelled',
] as const satisfies readonly DutyStatus[];
/** Somebody's to do: active and not finished. */
export const OPEN_DUTY_STATUSES = [
  'not_started',
  'in_progress',
  'waiting_external',
  'blocked',
] as const satisfies readonly DutyStatus[];

export const isOpenDuty = (s: DutyStatus) => (OPEN_DUTY_STATUSES as readonly string[]).includes(s);
export const isDoneDuty = (s: DutyStatus) => (DONE_DUTY_STATUSES as readonly string[]).includes(s);

/** Overdue: open, and its due time has passed. Never stored. */
export function isOverdue(
  duty: { readonly status: DutyStatus; readonly dueAt: string | null },
  now: number,
): boolean {
  return isOpenDuty(duty.status) && duty.dueAt !== null && Date.parse(duty.dueAt) <= now;
}

/**
 * The moves a person or the add-on may make. Completing, waiving and cancelling each have their own rules (proof, an
 * exception, a reason: step 9); reopening a finished one puts it back to work.
 */
const MOVES: Readonly<Record<DutyStatus, readonly DutyStatus[]>> = {
  draft: ['pending_approval', 'not_started', 'cancelled'],
  pending_approval: ['not_started', 'draft', 'cancelled'],
  not_started: ['in_progress', 'waiting_external', 'blocked', 'completed', 'waived', 'cancelled'],
  in_progress: ['not_started', 'waiting_external', 'blocked', 'completed', 'waived', 'cancelled'],
  waiting_external: ['in_progress', 'not_started', 'blocked', 'completed', 'waived', 'cancelled'],
  blocked: ['in_progress', 'not_started', 'waiting_external', 'completed', 'waived', 'cancelled'],
  completed: ['in_progress'],
  waived: ['not_started'],
  cancelled: ['not_started'],
};

export const canMoveDuty = (from: DutyStatus, to: DutyStatus): boolean => MOVES[from].includes(to);
