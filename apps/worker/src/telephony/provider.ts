/**
 * What the worker needs from a telephony provider. Twilio implements it for real; the fake keeps state in
 * memory and calls the worker's own webhooks, so local runs and tests exercise the same paths.
 */

export type NumberType = 'local' | 'toll_free';
export type RegistrationKind =
  | 'toll_free_verification'
  | 'a2p_customer_profile'
  | 'a2p_trust_product'
  | 'a2p_brand'
  | 'a2p_campaign';

/** A workspace's subaccount with its credentials opened (never logged, never stored in the clear). */
export interface ProviderAccount {
  /** app.telephony_accounts.id */
  readonly id: string;
  readonly sid: string;
  readonly authToken: string;
  readonly messagingServiceSid: string | null;
  /** The subaccount's own API key (it signs browser call tokens); null until calls are set up. */
  readonly apiKeySid: string | null;
  readonly apiKeySecret: string | null;
  /** The TwiML app browsers place calls through. */
  readonly twimlAppSid: string | null;
}

export interface Capabilities {
  readonly sms: boolean;
  readonly mms: boolean;
  readonly voice: boolean;
}

export interface AvailableNumber {
  readonly e164: string;
  readonly locality: string | null;
  readonly region: string | null;
  readonly capabilities: Capabilities;
}

export interface OwnedNumber {
  readonly sid: string;
  readonly capabilities: Capabilities;
}

export interface WebhookUrls {
  readonly smsUrl: string;
  readonly smsStatusUrl: string;
  readonly voiceUrl: string;
  readonly voiceStatusUrl: string;
  /** The TwiML app's voice URL: builds a call a teammate places from the browser. */
  readonly voiceOutboundUrl: string;
}

export interface OutboundMessage {
  readonly from: string;
  readonly messagingServiceSid: string | null;
  readonly to: string;
  readonly body: string;
  readonly mediaUrls: readonly string[];
  readonly statusCallbackUrl: string;
  /**
   * RCS first (0103): through the messaging service, whose sender pool holds the business's RCS sender. Twilio
   * checks whether the customer's phone can show RCS and, when it can't, sends an SMS or MMS from `from` — the
   * thread's own number, as `FallbackFrom` — so a business with several lines still answers from the right one.
   */
  readonly rcsFirst?: boolean;
  /**
   * A rich text's content template (0103). What goes out is the template — its card or carousel over RCS, its
   * text or media fallback otherwise — so `body` and `mediaUrls` are not sent alongside it.
   */
  readonly contentSid?: string | null;
}

/** Where Twilio says an RCS sender stands, in the four states this system acts on. */
export type RcsSenderState = 'online' | 'in_review' | 'offline' | 'failed';

/** An RCS sender as Twilio has it (0103): made and approved in the Twilio console, in the business's account. */
export interface RcsSenderInfo {
  /** Twilio's reference for it (XE…), which is what goes on a messaging service. */
  readonly sid: string;
  /** Its id without the `rcs:` in front. */
  readonly senderId: string;
  /** The name customers see at the top of the thread. */
  readonly displayName: string | null;
  /** Twilio's own word: ONLINE, TWILIO_REVIEW, OFFLINE … */
  readonly providerStatus: string;
  readonly state: RcsSenderState;
  /** Why it is offline or failed, when Twilio says. */
  readonly reason: string | null;
}

/**
 * A rich text as a Twilio content template (0103): the rich type (`twilio/card`, `twilio/carousel`) and the
 * fallbacks a phone without RCS gets (`twilio/text`, and `twilio/media` when there is a picture). Twilio sends
 * the richest one the channel it ends up on can show.
 */
export interface ContentTemplate {
  readonly friendlyName: string;
  readonly types: Readonly<Record<string, unknown>>;
}

export interface RegistrationRequest {
  readonly kind: RegistrationKind;
  /** The business profile people submitted (schemas/telephony BusinessProfile plus forNumber). */
  readonly submission: Readonly<Record<string, unknown>>;
  readonly phoneNumberSid: string | null;
  readonly phoneNumberE164: string;
  /**
   * Provider ids of the earlier steps this one builds on: approved ones, plus the customer profile and trust
   * product while still in review (Twilio lets the brand go ahead). The brand needs both; the campaign the brand.
   */
  readonly previous: Readonly<Partial<Record<RegistrationKind, string>>>;
  readonly messagingServiceSid: string | null;
  /** Where the carrier writes about the registration. */
  readonly notifyEmail: string;
  /**
   * The carrier's id for this step's earlier request, when people send it again after the carrier turned it
   * down: a toll-free request is edited (or replaced once Twilio no longer takes edits), a campaign is
   * replaced, a brand is resubmitted, and a Trust Hub bundle (which support corrects in the console) is
   * only looked at. Null for a first request.
   */
  readonly replaces: string | null;
}

/** A call the worker places from a business number: a verification call, or the ring to someone's own cell. */
export interface PlaceCallRequest {
  readonly from: string;
  readonly to: string;
  /** Where the provider asks what to do once the phone answers (TwiML). */
  readonly answerUrl: string;
  /** Where the call reports ringing, answered and how it ended. */
  readonly statusCallbackUrl: string;
  /** How long the phone rings before the provider gives up. */
  readonly timeoutSeconds: number;
  /** AI outbound calls: record the whole call, both sides, reporting to this address when it's saved. */
  readonly record?: { readonly statusCallbackUrl: string } | null;
  /**
   * AI outbound calls: tell a person from a voicemail box before the answer URL is asked (`AnsweredBy`).
   * `answer` decides on the first words; `beep` waits for a voicemail's beep, to leave a message after it.
   */
  readonly machineDetection?: 'answer' | 'beep' | null;
}

/** Where a call recording's words are. Sentences carry the recording's channel: 1 the business's side, 2 the customer's. */
export type TranscriptionState =
  | { readonly status: 'pending' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'completed';
      readonly sentences: readonly { readonly channel: number; readonly text: string }[];
    };

export type RegistrationOutcome = 'submitted' | 'in_review' | 'approved' | 'rejected' | 'failed';

export interface RegistrationState {
  readonly providerSid: string;
  readonly providerStatus: string;
  readonly status: RegistrationOutcome;
  readonly rejectionReason: string | null;
}

/**
 * Moving a number a business already owns (M17). Two kinds, and the difference is what the business
 * actually experiences:
 *
 * - `full` — texts **and** calls come to us. Two to four weeks, and the losing carrier can refuse.
 * - `hosted_messaging` — we take over texting only. Days, and their desk phone keeps ringing as it does.
 */
export type NumberPortKind = 'full' | 'hosted_messaging';

export type PortOutcome =
  'submitted' | 'carrier_review' | 'scheduled' | 'complete' | 'rejected' | 'failed';

/** The same shape `RegistrationState` has, plus the date a business plans its week around. */
export interface PortState {
  readonly providerSid: string;
  readonly providerStatus: string;
  readonly status: PortOutcome;
  readonly rejectionReason: string | null;
  /** When the carrier says the number actually moves. Null until they commit to one. */
  readonly scheduledFor: string | null;
}

export interface PortRequest {
  readonly e164: string;
  readonly kind: NumberPortKind;
  /**
   * What the losing carrier asks for: the account number on the bill, the PIN or passcode, the service
   * address, and who is authorising it. **Their credentials, not ours to spread** — never logged, never put
   * on a phone.
   */
  readonly submission: Record<string, unknown>;
  /** Storage paths of the papers already uploaded (the signed LOA, a recent bill). */
  readonly documentPaths: readonly string[];
}

/**
 * What a carrier lookup says about a number today (20261010000900). The carrier's name is what tells a
 * HighLevel number that can move account to account inside Twilio from one that needs a carrier port.
 */
export interface NumberLookup {
  /** `Twilio - SMS/MMS-SVR` for a Twilio number; the other carrier's name otherwise; null when unknown. */
  readonly carrierName: string | null;
  /** The lookup's own word: mobile, landline, nonFixedVoip, tollFree … */
  readonly lineType: string | null;
}

/**
 * A Twilio account somebody else owns — a business's own, never one of our subaccounts — opened with what they
 * gave us: the Account SID with its auth token, or an API key's SID with its secret. **Never logged.**
 */
export interface ExternalTwilioCreds {
  readonly accountSid: string;
  /** Who the request signs in as: the Account SID, or the API key's SID (SK…). */
  readonly username: string;
  readonly secret: string;
}

export interface ExternalAccount {
  readonly sid: string;
  readonly friendlyName: string | null;
  /** active, suspended or closed, as Twilio spells it. */
  readonly status: string;
  /** The parent, when this account is itself a subaccount. */
  readonly ownerAccountSid: string | null;
}

/** One number in a connected account, as the business picks it to bring in. */
export interface ExternalNumber {
  readonly sid: string;
  /** The account it sits in: the connected one, or one of its subaccounts (an agency's has one per client). */
  readonly accountSid: string;
  readonly accountName: string | null;
  readonly e164: string;
  readonly friendlyName: string | null;
  readonly capabilities: Capabilities;
  /** Where its texts and calls go today, which is how a number HighLevel is using shows up. */
  readonly smsUrl: string | null;
  readonly voiceUrl: string | null;
}

export interface TelephonyProvider {
  readonly name: 'twilio' | 'fake';
  /** The master account: webhooks it signs verify with its own token. */
  readonly masterAccountSid: string;
  readonly masterAuthToken: string;
  createSubaccount(friendlyName: string): Promise<{ sid: string; authToken: string }>;
  /**
   * Closes a business's subaccount for good, with the master account: every number in it is released and it
   * stops billing. For a business being deleted. One already closed, or never known, is fine.
   */
  closeSubaccount(accountSid: string): Promise<void>;
  createMessagingService(
    account: ProviderAccount,
    opts: { friendlyName: string; inboundUrl: string; statusCallbackUrl: string },
  ): Promise<string>;
  /** A standard API key in the subaccount; the provider shows its secret once. */
  createApiKey(
    account: ProviderAccount,
    friendlyName: string,
  ): Promise<{ sid: string; secret: string }>;
  /** The TwiML app browser calls go through. */
  createTwimlApp(
    account: ProviderAccount,
    opts: { friendlyName: string; voiceUrl: string; statusCallbackUrl: string },
  ): Promise<string>;
  /**
   * The carrier's free numbers. Every filter narrows the same search, so a city and a digit pattern together
   * ask for both. A city needs its state with it: there is a Huntsville in Alabama, Texas and Arkansas.
   * Toll-free numbers have no geography, so city and state belong to local searches only.
   */
  searchNumbers(opts: {
    numberType: NumberType;
    areaCode?: string;
    /** Digits the number carries, `*` standing in for any one digit: `454`, or `256***454*` to pin the spot. */
    contains?: string;
    city?: string;
    /** Two letters, like `AL`. */
    state?: string;
    /**
     * Widens a city to everything within this many miles of it, which is what a business usually means by its
     * own town: a Huntsville search on its own misses Madison. Only with a city, and at most 500 (Twilio's cap).
     */
    withinMiles?: number;
    limit: number;
  }): Promise<AvailableNumber[]>;
  findOwnedNumber(account: ProviderAccount, e164: string): Promise<OwnedNumber | null>;
  buyNumber(
    account: ProviderAccount,
    opts: { e164: string; urls: WebhookUrls },
  ): Promise<OwnedNumber>;
  addNumberToService(
    account: ProviderAccount,
    serviceSid: string,
    numberSid: string,
  ): Promise<void>;
  /**
   * Point a number we already hold at our webhooks (M17).
   *
   * A bought number gets these at the moment it is bought, in the same call. **A ported one arrives bare** —
   * the carrier hands it over and nothing is listening — so this is the step between "the carrier moved it"
   * and "a customer can text it". Separate from `buyNumber` because there is nothing to buy.
   *
   * **A number transferred in from another Twilio account arrives dressed** (20261010000900): still pointed at
   * wherever its old owner had it — HighLevel, usually — possibly through a TwiML app or with fallback
   * addresses that would catch a text the moment ours hiccupped. So this also clears the apps and fallbacks, and
   * our webhooks are the only thing left on it.
   */
  configureNumber(account: ProviderAccount, numberSid: string, urls: WebhookUrls): Promise<void>;
  /**
   * Who hosts a number today, by the carrier lookup (20261010000900). Asked with the master account, because
   * it is a question about somebody else's number. One the lookup cannot place comes back with nulls.
   */
  lookupNumber(e164: string): Promise<NumberLookup>;
  /**
   * Signs in to a business's own Twilio account with what they gave us, and says what it is. A 401 or 403 is
   * the answer "those are not the right credentials".
   */
  inspectAccount(creds: ExternalTwilioCreds): Promise<ExternalAccount>;
  /**
   * The numbers in a business's own Twilio account and in its subaccounts, up to `limit`. Read-only: nothing
   * about any number changes by being listed.
   */
  listAccountNumbers(
    creds: ExternalTwilioCreds,
    opts: { readonly limit: number },
  ): Promise<ExternalNumber[]>;
  releaseNumber(account: ProviderAccount, numberSid: string): Promise<void>;
  sendMessage(
    account: ProviderAccount,
    message: OutboundMessage,
  ): Promise<{ sid: string; status: string }>;
  /** The RCS senders in a business's own account (0103), for Settings to offer and the worker to find. */
  listRcsSenders(account: ProviderAccount): Promise<RcsSenderInfo[]>;
  /** One RCS sender by its reference; null when Twilio no longer has it. */
  fetchRcsSender(account: ProviderAccount, sid: string): Promise<RcsSenderInfo | null>;
  /**
   * Puts an RCS sender in a messaging service's sender pool, which is what makes every text sent through the
   * service go RCS first. One already there is fine.
   */
  addRcsSenderToService(
    account: ProviderAccount,
    serviceSid: string,
    senderSid: string,
  ): Promise<void>;
  /** Takes it out of the pool again: texts go as SMS and MMS only. One already gone is fine. */
  removeRcsSenderFromService(
    account: ProviderAccount,
    serviceSid: string,
    senderSid: string,
  ): Promise<void>;
  /** Makes a rich text's content template (0103) and hands back its reference (HX…). */
  createContent(account: ProviderAccount, template: ContentTemplate): Promise<{ sid: string }>;
  /** Removes a template once its message has been delivered, or has failed. One already gone is fine. */
  deleteContent(account: ProviderAccount, contentSid: string): Promise<void>;
  fetchMedia(account: ProviderAccount, url: string): Promise<{ data: Buffer; contentType: string }>;
  deleteMedia(account: ProviderAccount, url: string): Promise<void>;
  /** A voicemail's audio. */
  fetchRecording(
    account: ProviderAccount,
    recordingSid: string,
  ): Promise<{ data: Buffer; contentType: string }>;
  /** Removes the provider's copy once ours is stored; one that is already gone is fine. */
  deleteRecording(account: ProviderAccount, recordingSid: string): Promise<void>;
  /** A voicemail's transcription, or a call recording's (transcribeRecording); one already gone is fine. */
  deleteTranscription(account: ProviderAccount, transcriptionSid: string): Promise<void>;
  /** Places a call from a business number; the provider then asks `answerUrl` what to say. */
  placeCall(account: ProviderAccount, request: PlaceCallRequest): Promise<{ sid: string }>;
  /**
   * Hangs up a call the worker placed, ringing or answered (a call through someone's cell they cancelled). One that
   * already ended, or that the provider no longer knows, is fine.
   */
  endCall(account: ProviderAccount, callSid: string): Promise<void>;
  /**
   * Gives a live call new instructions (M18 step 5): the AI teammate hands a caller to the team by ringing them
   * on the same call. Whatever the call was doing (a live stream to the teammate) stops. One that already ended
   * is fine.
   */
  redirectCall(account: ProviderAccount, callSid: string, twiml: string): Promise<void>;
  /**
   * Asks for a whole call recording's words (a voicemail gets its own when it is recorded). The worker reads them
   * with fetchTranscription until they're ready.
   */
  transcribeRecording(
    account: ProviderAccount,
    recordingSid: string,
  ): Promise<{ transcriptionSid: string }>;
  fetchTranscription(
    account: ProviderAccount,
    transcriptionSid: string,
  ): Promise<TranscriptionState>;
  submitRegistration(
    account: ProviderAccount,
    request: RegistrationRequest,
  ): Promise<RegistrationState>;
  fetchRegistration(
    account: ProviderAccount,
    registration: { kind: RegistrationKind; providerSid: string },
  ): Promise<RegistrationState>;
  /** Ask the carrier to move a number to us. Same shape as `submitRegistration`, same reasons. */
  submitPort(account: ProviderAccount, request: PortRequest): Promise<PortState>;
  fetchPort(account: ProviderAccount, providerSid: string): Promise<PortState>;
  /** Put one signed paper on a port the carrier already has. */
  uploadPortDocument(
    account: ProviderAccount,
    input: {
      readonly portSid: string;
      readonly name: string;
      readonly contentType: string;
      readonly data: Uint8Array;
    },
  ): Promise<{ readonly sid: string }>;
  /** Call it off, while the carrier will still let us. */
  cancelPort(account: ProviderAccount, providerSid: string): Promise<void>;
  /**
   * What the carrier says this business actually used, and charged **us**, day by day (M16, step 4).
   *
   * This is the one number in the whole wallet that is not ours: everything else is priced from our own rate
   * card at the moment of the event, because a carrier's price arrives minutes late or not at all and a wallet
   * that waited would let a business spend all night for free. This is how that guess gets trued up.
   *
   * Authoritative per business with no allocation guesswork, because **each workspace has its own subaccount**
   * — so the carrier's own daily records for that subaccount are that business's usage and nobody else's.
   */
  usageDaily(
    account: ProviderAccount,
    range: { readonly start: string; readonly end: string },
  ): Promise<readonly DailyUsage[]>;
}

/** One line of a carrier's daily records: what one category cost on one day. */
export interface DailyUsage {
  /** The local date, `YYYY-MM-DD`, in the carrier's own reckoning. */
  readonly day: string;
  /**
   * The carrier's own category name (`sms-outbound`, `calls-inbound`, `pv`, …), kept as they spell it so an
   * adjustment can be traced back to a line on their invoice.
   */
  readonly category: string;
  /** How many of whatever the category counts. */
  readonly count: number;
  /** What they charged us, in micro-dollars — their prices have four decimal places and cents cannot hold them. */
  readonly costMicros: number;
}

/**
 * A provider refusal. `permanent` errors (a number that is gone, an unsubscribed recipient, a rejected
 * field) are recorded on the record; the others are retried with the outbox backoff.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly permanent: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const isPermanentProviderError = (e: unknown): e is ProviderError =>
  e instanceof ProviderError && e.permanent;
