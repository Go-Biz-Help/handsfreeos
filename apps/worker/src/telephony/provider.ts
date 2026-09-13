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

export type RegistrationOutcome = 'submitted' | 'in_review' | 'approved' | 'rejected' | 'failed';

export interface RegistrationState {
  readonly providerSid: string;
  readonly providerStatus: string;
  readonly status: RegistrationOutcome;
  readonly rejectionReason: string | null;
}

export interface TelephonyProvider {
  readonly name: 'twilio' | 'fake';
  /** The master account: webhooks it signs verify with its own token. */
  readonly masterAccountSid: string;
  readonly masterAuthToken: string;
  createSubaccount(friendlyName: string): Promise<{ sid: string; authToken: string }>;
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
  searchNumbers(opts: {
    numberType: NumberType;
    areaCode?: string;
    contains?: string;
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
  releaseNumber(account: ProviderAccount, numberSid: string): Promise<void>;
  sendMessage(
    account: ProviderAccount,
    message: OutboundMessage,
  ): Promise<{ sid: string; status: string }>;
  fetchMedia(account: ProviderAccount, url: string): Promise<{ data: Buffer; contentType: string }>;
  deleteMedia(account: ProviderAccount, url: string): Promise<void>;
  /** A voicemail's audio. */
  fetchRecording(
    account: ProviderAccount,
    recordingSid: string,
  ): Promise<{ data: Buffer; contentType: string }>;
  /** Removes the provider's copy once ours is stored; one that is already gone is fine. */
  deleteRecording(account: ProviderAccount, recordingSid: string): Promise<void>;
  deleteTranscription(account: ProviderAccount, transcriptionSid: string): Promise<void>;
  submitRegistration(
    account: ProviderAccount,
    request: RegistrationRequest,
  ): Promise<RegistrationState>;
  fetchRegistration(
    account: ProviderAccount,
    registration: { kind: RegistrationKind; providerSid: string },
  ): Promise<RegistrationState>;
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
