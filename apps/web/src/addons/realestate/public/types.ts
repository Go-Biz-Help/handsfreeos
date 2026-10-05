/**
 * Real Estate's public answers (`realestate.public.listing` / `.open_house`, packages/core/src/addons/realestate/
 * ops/public.ts and open-houses.ts), as its signed-out pages read them. Public operations aren't in the API's
 * OpenAPI, so their shapes are written out here, as the portal's are.
 */

/** A photo the worker signed for showing: its link works for an hour. */
export interface PublicPhoto {
  readonly publicFileId: string;
  readonly caption?: string | null;
  readonly url?: string;
}

export interface PublicListing {
  readonly slug: string;
  readonly street: string;
  readonly cityLine: string | null;
  readonly status: 'for_sale' | 'under_contract' | 'sold';
  readonly priceCents: number | null;
  readonly facts: readonly { readonly label: string; readonly words: string }[];
  readonly description: string | null;
  readonly photos: readonly PublicPhoto[];
  readonly openHouses: readonly {
    readonly id: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly signInOpen: boolean;
  }[];
  readonly agentName: string | null;
  readonly mlsNumber: string;
}

export interface PublicOpenHouse {
  readonly street: string;
  readonly cityLine: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly hostName: string | null;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly open: boolean;
  readonly cancelled: boolean;
  readonly photo: PublicPhoto | null;
}

/** The times a buyer's agent can ask for (round five, `realestate.public.showing_times`). */
export interface PublicShowingTimes {
  readonly street: string;
  readonly open: boolean;
  readonly closedWords: string | null;
  readonly times: readonly string[];
  readonly minutes: number;
  readonly timeZone: string;
  readonly confirm: 'seller' | 'auto';
}

/** A showing's feedback link (`realestate.public.showing_feedback_form`). */
export interface PublicShowingFeedbackForm {
  readonly street: string;
  readonly startsAt: string;
  readonly agentName: string;
  readonly answered: boolean;
}
