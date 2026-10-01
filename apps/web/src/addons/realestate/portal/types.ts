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
  readonly kind: 'upload' | 'sign_off' | 'do';
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
  readonly financing: readonly {
    readonly step: string;
    readonly label: string;
    readonly status: string;
    readonly date: string | null;
  }[];
}
