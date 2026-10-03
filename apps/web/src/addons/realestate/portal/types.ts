/**
 * Real Estate's answers in the client's portal (`realestate.portal.deals` / `.deal`, packages/core/src/addons/
 * realestate/ops/portal.ts), as the portal's pages read them. Customer operations aren't in the API's OpenAPI, so
 * their shapes are written out here, as `lib/api/public-money.ts` does for the money pages.
 */

export interface PortalKeyDate {
  readonly key: string;
  readonly label: string;
  readonly date: string;
  readonly time: string | null;
}

export interface PortalDealRow {
  readonly dealId: string;
  readonly name: string;
  readonly side: 'buyer' | 'listing';
  /** In the client's words: "Touring homes". */
  readonly stage: string;
  /** Which of `steps` it's on (0–4), -1 off the market. */
  readonly step: number;
  readonly steps: readonly string[];
  readonly agentName: string | null;
  readonly nextDate: PortalKeyDate | null;
  readonly openTasks: number;
  readonly closed: boolean;
}

export interface PortalTask {
  readonly id: string;
  /** A seller's questionnaire opens its own page (round three). */
  readonly kind: 'upload' | 'sign_off' | 'do' | 'questionnaire';
  readonly title: string;
  readonly detail: string | null;
  readonly signOffWords: string | null;
  readonly forPersonId: string | null;
  readonly dueOn: string | null;
  readonly status: 'open' | 'done' | 'canceled';
  readonly doneAt: string | null;
  /** "Waiting on Tuan", for a sign-off the others haven't done yet. */
  readonly waiting: string | null;
  /** They've done their part. */
  readonly mine: boolean;
}

export interface PortalHome {
  readonly id: string;
  readonly address: string;
  readonly link: string | null;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly status: string;
  /** What the MLS says of it, with its MLS's notice (round five); null when the feed hasn't brought it. */
  readonly mls: {
    readonly statusWords: string | null;
    readonly listPriceCents: number | null;
    readonly photos: readonly { readonly url: string; readonly caption: string | null }[];
    readonly description: string | null;
    readonly courtesy: string | null;
    readonly notice: string | null;
    readonly logoUrl: string | null;
  } | null;
  readonly addedByMe: boolean;
  readonly mine: 'saved' | 'passed' | null;
  readonly others: readonly { readonly name: string; readonly reaction: 'saved' | 'passed' }[];
}

export interface PortalStop {
  readonly id: string;
  readonly homeId: string;
  readonly address: string;
  readonly position: number;
  readonly status: string;
  readonly myFeedback: {
    readonly interest: string;
    readonly rating: number | null;
    readonly words: string | null;
  } | null;
}

export interface PortalTour {
  readonly id: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly stops: readonly PortalStop[];
}

export interface PortalOffer {
  readonly id: string;
  readonly address: string;
  readonly status: string;
  readonly summary: {
    readonly title: string;
    readonly note: string;
    readonly lines: readonly { readonly label: string; readonly value: string }[];
    readonly next: string;
  };
}

export interface PortalDeal {
  readonly deal: Omit<PortalDealRow, 'nextDate' | 'openTasks'>;
  readonly keyDates: readonly PortalKeyDate[];
  readonly tasks: readonly PortalTask[];
  readonly homes: readonly PortalHome[];
  readonly tours: readonly PortalTour[];
  readonly cmas: readonly {
    readonly id: string;
    readonly address: string;
    readonly lowCents: number;
    readonly likelyCents: number;
    readonly highCents: number;
    readonly summary: string | null;
    readonly sharedAt: string;
  }[];
  readonly offers: readonly PortalOffer[];
  /** Round four: their contingencies, when each ends and how each ended. */
  readonly contingencies: readonly PortalContingency[];
  readonly financing: readonly {
    readonly step: string;
    readonly label: string;
    readonly status: string;
    readonly date: string | null;
  }[];
}

/** A contingency as the client sees it: what it's for, when it ends, how it ended; never the agent's note. */
export interface PortalContingency {
  readonly id: string;
  readonly label: string;
  readonly meaning: string;
  readonly state: 'open' | 'satisfied' | 'waived' | 'expired';
  readonly endsOn: string | null;
  /** "Open · ends Oct 8", "Satisfied Oct 1". */
  readonly words: string;
}

// Round three: the seller's own listing (`realestate.portal.listing`, ops/seller-portal.ts).

/** One offer as the seller sees it side by side: its newest terms and what they'd take home (an estimate). */
export interface PortalCompareRow {
  readonly offerId: string;
  readonly number: number;
  readonly buyers: string | null;
  readonly agent: string | null;
  readonly brokerage: string | null;
  readonly status: string;
  readonly priceCents: number;
  /** "Cash", "Conventional · 20% down". */
  readonly paying: string;
  readonly emdCents: number | null;
  readonly sellerCreditCents: number;
  readonly buyerAgentFee: string | null;
  readonly inspection: string | null;
  readonly financing: string | null;
  readonly homeSale: boolean | null;
  readonly escalation: string | null;
  readonly closingDate: string | null;
  readonly possession: string | null;
  readonly respondBy: string | null;
  readonly net: {
    readonly lines: readonly {
      readonly key: string;
      readonly label: string;
      readonly cents: number;
    }[];
    readonly netCents: number;
  };
  readonly best: boolean;
}

export type PortalSellerChoice = 'accept' | 'counter' | 'decline' | 'talk';

export interface PortalListing {
  readonly dealId: string;
  readonly address: string | null;
  readonly street: string | null;
  readonly priceCents: number | null;
  readonly priceChanges: readonly {
    readonly id: string;
    readonly fromCents: number;
    readonly toCents: number;
    readonly words: string;
    readonly state: 'waiting' | 'applied' | 'withdrawn';
    readonly appliedAt: string | null;
    readonly proposedAt: string;
  }[];
  readonly mls: { readonly number: string; readonly liveOn: string } | null;
  readonly pagePath: string | null;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly description: { readonly words: string; readonly signedAt: string | null } | null;
  readonly openHouses: readonly {
    readonly id: string;
    readonly startsAt: string;
    readonly endsAt: string;
  }[];
  readonly questionnaire: {
    readonly state: 'none' | 'asked' | 'draft' | 'submitted';
    readonly taskId: string | null;
    readonly answers: {
      readonly facts: Readonly<Record<string, unknown>>;
      readonly updates: string | null;
      readonly loves: string | null;
    };
    readonly savedAt: string | null;
    readonly submittedAt: string | null;
  };
  readonly comparison: {
    readonly id: string;
    readonly sharedAt: string;
    readonly address: string;
    readonly rows: readonly PortalCompareRow[];
    readonly note: string;
    readonly myChoices: readonly {
      readonly offerId: string;
      readonly choice: PortalSellerChoice;
      readonly words: string | null;
      readonly at: string;
    }[];
  } | null;
}
