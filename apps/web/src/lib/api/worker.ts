'use client';
import type { PolicyUpdateInput, PolicyUpdateOutput, PreflightCheck } from '@hfos/core';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';
import { ApiError } from './errors';
import { mintCorrelationId } from './own-requests';
import type { VideoTicket } from './public-booking';

/**
 * Calls the worker's own HTTP routes (number search now; voice tokens and mailbox sign-in later) with the
 * signed-in user's access token. Errors come back in the API's shape, so callers handle them the same way.
 */
export async function workerPost<T>(path: string, body: unknown): Promise<T> {
  const token = (await supabaseBrowser().auth.getSession()).data.session?.access_token;
  if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  let res: Response;
  try {
    res = await fetch(`${publicEnv.workerUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-correlation-id': mintCorrelationId(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'internal',
      'The phone service is not reachable right now. Try again in a minute.',
    );
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (
      json as {
        error?: { code?: string; message?: string; rule?: string; details?: unknown };
      } | null
    )?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'internal',
      err?.message ?? 'Something went wrong. Please try again.',
      err?.rule,
      err?.details,
    );
  }
  return json as T;
}

export interface AvailableNumber {
  readonly e164: string;
  readonly display: string;
  readonly locality: string | null;
  readonly region: string | null;
  readonly capabilities: { readonly sms: boolean; readonly mms: boolean; readonly voice: boolean };
}

/**
 * Numbers the carrier has free right now (owners and admins only; the worker checks). Filters narrow one
 * search together, so a city and a digit pattern ask for both. A city needs its state, and only local
 * numbers have one.
 */
export function searchNumbers(input: {
  workspaceId: string;
  numberType: 'local' | 'toll_free';
  areaCode?: string;
  /** Digits the number carries: `454`, or `*` for any one digit to pin the spot. */
  contains?: string;
  city?: string;
  state?: string;
  /** Widens the city to everything within this many miles of it. Only with a city; at most 500. */
  withinMiles?: number;
}): Promise<{ numbers: AvailableNumber[] }> {
  return workerPost('/v1/telephony/available-numbers', input);
}

/** An RCS sender in the business's own Twilio account (0103), as Settings offers it before connecting. */
export interface FoundRcsSender {
  readonly sid: string;
  /** What Settings connects it by: `lonestar_hvac_agent`. */
  readonly senderId: string;
  readonly displayName: string | null;
  readonly state: 'online' | 'in_review' | 'offline' | 'failed';
  /** Twilio's own word for it (ONLINE, TWILIO_REVIEW …). */
  readonly providerStatus: string;
}

/**
 * The RCS senders made in the business's own Twilio account (owners and admins; the worker checks), and the
 * account's id, so the person knows which account in the Twilio console to make one in. `accountSid` is null
 * before the business has a number: its Twilio account is made with the first one.
 */
export function findRcsSenders(
  workspaceId: string,
): Promise<{ accountSid: string | null; senders: FoundRcsSender[] }> {
  return workerPost('/v1/telephony/rcs-senders', { workspaceId });
}

export interface VoiceToken {
  readonly token: string;
  /** The identity this browser rings as. */
  readonly identity: string;
  readonly expiresAt: string;
  /** The business number customers see. */
  readonly callerId: string;
  /** "fake" when the worker runs the fake carrier: the browser uses a stand-in device. */
  readonly provider: 'twilio' | 'fake';
}

/** A one-hour token for this browser to ring and place calls (anyone who uses the inbox). */
export function voiceToken(workspaceId: string): Promise<VoiceToken> {
  return workerPost('/v1/telephony/voice-token', { workspaceId });
}

/** Which of a customer's own pages a link opens: an estimate (`/e/…`), an invoice (`/i/…`) or a plan (`/p/…`). */
export type MoneyLinkKind = 'estimate' | 'invoice' | 'plan';

/**
 * A customer's own link, exactly as they were sent it, for the business to copy (owners and admins; the worker
 * checks). The worker mints it because it holds the key the API may not.
 */
export function moneyLink(input: {
  workspaceId: string;
  kind: MoneyLinkKind;
  id: string;
}): Promise<{ url: string }> {
  return workerPost('/v1/money/link', input);
}

/** What `POST /v1/wallet/card` answers: a page to go to, the card it came back with, or neither. */
export type WalletCardAnswer =
  | { readonly stage: 'started'; readonly hostedUrl: string }
  | { readonly stage: 'cancelled' }
  | {
      readonly stage: 'saved';
      readonly card: {
        readonly workspaceId: string;
        readonly hasCard: boolean;
        readonly cardBrand: string | null;
        readonly cardLast4: string | null;
        readonly cardExpiryMonth: number | null;
        readonly cardExpiryYear: number | null;
      };
    };

/**
 * Putting a card on the business's own balance (owners and admins; the worker checks). Called twice: once with
 * no session, for the provider's page to send the browser to, and once with the session they came back on, to
 * save what it ended with. The worker does it because it holds the key that bills for HandsFreeOS, which the
 * API is refused on purpose.
 */
export function walletCard(input: {
  workspaceId: string;
  sessionRef?: string;
}): Promise<WalletCardAnswer> {
  return workerPost('/v1/wallet/card', input);
}

/** What `POST /v1/partners/payout-card` answers: a page to go to, the card it came back with, or neither. */
export type PartnerPayoutCardAnswer =
  | { readonly stage: 'started'; readonly hostedUrl: string }
  | { readonly stage: 'cancelled' }
  | {
      readonly stage: 'saved';
      readonly card: {
        readonly brand: string;
        readonly last4: string;
        readonly expiryMonth: number | null;
        readonly expiryYear: number | null;
      } | null;
    };

/**
 * The card a business pays its partners with (whoever manages money; the worker checks), the same two calls as the
 * wallet's: once for Stripe's page, once with the session they came back on. The worker keeps the key that bills for
 * HandsFreeOS, which the API is refused on purpose.
 */
export function partnerPayoutCard(input: {
  workspaceId: string;
  sessionRef?: string;
}): Promise<PartnerPayoutCardAnswer> {
  return workerPost('/v1/partners/payout-card', input);
}

/**
 * Getting paid as an affiliate (20261027014400): Stripe's own form for their bank (`start`, which makes their account
 * the first time), whether it's done once they're back (`check`), and their Stripe page once it is (`stripe`). The
 * worker does it because it holds HandsFreeOS's own Stripe key, which the API is refused on purpose.
 */
export function affiliatePayouts(action: 'start' | 'stripe'): Promise<{ url: string }>;
export function affiliatePayouts(action: 'check'): Promise<{ ready: boolean }>;
export function affiliatePayouts(
  action: 'start' | 'check' | 'stripe',
): Promise<{ url: string } | { ready: boolean }> {
  return workerPost('/v1/affiliate/payouts', { action });
}

/**
 * Goes and looks at what a carrier's reviewer would look at, before the registration is sent (owners and
 * admins; the worker checks). The worker does it rather than the browser because these are a business's
 * own addresses and fetching them from here would be blocked, unauthenticated and unsafe by turns.
 */
export function registrationPreflight(input: {
  workspaceId: string;
  website?: string;
  policyUrl?: string | null;
  termsUrl?: string | null;
  optInPath: 'hosted' | 'own_site' | 'in_person';
  optInUrl?: string | null;
  optInProofUrl?: string | null;
  /** The ways the business is known, looked for on the website and beside the box. */
  names?: string[];
}): Promise<{ checks: PreflightCheck[] }> {
  return workerPost('/v1/telephony/registration-preflight', input);
}

/**
 * The business's own privacy policy or terms, given back whole with the texting section in place (owners and
 * admins; the worker checks). The worker reads the page, which the browser can't, and asks the AI where the
 * section goes; the business's own words and the section's are kept as they are.
 */
export function policyUpdate(
  input: PolicyUpdateInput & { workspaceId: string },
): Promise<PolicyUpdateOutput> {
  return workerPost('/v1/telephony/policy-update', input);
}

/** Who hosts a number today, by the carrier lookup (owners and admins; the worker checks). */
export interface NumberHost {
  readonly e164: string;
  readonly display: string;
  readonly numberType: 'local' | 'toll_free';
  /** `Twilio - SMS/MMS-SVR` for a Twilio number — HighLevel's LC Phone numbers are Twilio numbers. */
  readonly carrierName: string | null;
  readonly lineType: string | null;
  /** In Twilio, so it can move account to account instead of by a carrier port. */
  readonly hostedInTwilio: boolean;
  /** Already one of this business's numbers, or another business's here. */
  readonly alreadyHere: 'yours' | 'elsewhere' | null;
}

/** Looks up who hosts a number, before a business asks for it to be sent here (20261010000900). */
export function lookupNumberHost(workspaceId: string, e164: string): Promise<NumberHost> {
  return workerPost('/v1/telephony/number-host', { workspaceId, e164 });
}

/** A connected Twilio account as the screen shows it. Never its secret. */
export interface TwilioConnectionInfo {
  readonly id: string;
  readonly accountSid: string;
  readonly friendlyName: string | null;
  readonly usesApiKey: boolean;
  readonly status: 'active' | 'broken' | 'disconnected';
  readonly lastError: string | null;
  readonly checkedAt: string | null;
  readonly createdAt: string;
}

/** One number in a connected Twilio account, and where it stands for this organization. */
export interface TwilioAccountNumber {
  readonly sid: string;
  /** The (sub)account it sits in. An agency's account has one per client. */
  readonly accountSid: string;
  readonly accountName: string | null;
  readonly e164: string;
  readonly display: string;
  readonly friendlyName: string | null;
  readonly numberType: 'local' | 'toll_free';
  readonly capabilities: { readonly sms: boolean; readonly mms: boolean; readonly voice: boolean };
  /** Who its webhooks point at today: HighLevel shows up here. */
  readonly usedBy: 'highlevel' | 'handsfreeos' | 'other' | 'nothing';
  /** Already a number here: in one of this organization's businesses (named), or somebody else's (null name). */
  readonly heldBy: {
    readonly workspaceId: string | null;
    readonly workspaceName: string | null;
  } | null;
  /** On its way to one of this organization's businesses. */
  readonly comingTo: { readonly workspaceId: string; readonly workspaceName: string } | null;
}

export interface TwilioAccountListing {
  readonly connection: TwilioConnectionInfo;
  readonly numbers: readonly TwilioAccountNumber[];
  /** More numbers than one listing shows. */
  readonly truncated: boolean;
}

/**
 * Connects a business's own Twilio account (the organization's owners and admins): the Account SID with its
 * auth token, or with an API key and its secret. Answers with what is in it.
 */
export function connectTwilio(input: {
  workspaceId: string;
  accountSid: string;
  authToken?: string;
  apiKeySid?: string;
  apiKeySecret?: string;
}): Promise<TwilioAccountListing> {
  return workerPost('/v1/telephony/twilio/connect', input);
}

/** A connected account's numbers, listed again. */
export function listTwilioNumbers(
  workspaceId: string,
  connectionId: string,
): Promise<TwilioAccountListing> {
  return workerPost('/v1/telephony/twilio/numbers', { workspaceId, connectionId });
}

/** Lets a connected account go; what it was opened with is wiped. Numbers on their way keep coming. */
export function disconnectTwilio(
  workspaceId: string,
  connectionId: string,
): Promise<{ connectionId: string }> {
  return workerPost('/v1/telephony/twilio/disconnect', { workspaceId, connectionId });
}

/** Phone & texting on or off for a business, and its own Twilio Account SID while it is on. */
export interface PhoneAccountState {
  readonly state: 'off' | 'turning_on' | 'on';
  /** This business's own sub-account: what HighLevel or Twilio asks for to move a number here. Null while off. */
  readonly accountSid: string | null;
  /** HandsFreeOS's parent Twilio account, which HighLevel asks for beside the sub-account's. */
  readonly parentAccountSid: string;
  /** Why it was left on when someone tried to turn it off, in words. */
  readonly lastError: string | null;
}

/** Where phone & texting stands for a business (owners and admins; the worker checks). */
export function phoneAccountState(workspaceId: string): Promise<PhoneAccountState> {
  return workerPost('/v1/telephony/account', { workspaceId });
}

/** A number sitting in the business's own Twilio account that is not set up here yet. */
export interface OwnAccountNumber {
  readonly sid: string;
  readonly e164: string;
  readonly display: string;
  readonly friendlyName: string | null;
  readonly numberType: 'local' | 'toll_free';
  readonly capabilities: { readonly sms: boolean; readonly mms: boolean; readonly voice: boolean };
  /** Who its webhooks point at today: one moved over from HighLevel still points there. */
  readonly usedBy: 'highlevel' | 'handsfreeos' | 'other' | 'nothing';
  /**
   * `new`: nothing here knows it. `coming`: an import is already watching for it (`importId`), and looking now
   * finishes it. `elsewhere`: another business on HandsFreeOS still has it, so it can't be set up here.
   */
  readonly state: 'new' | 'coming' | 'elsewhere';
  readonly importId: string | null;
}

export interface OwnAccountListing {
  /** The business's own sub-account, or null while phone & texting is off. */
  readonly accountSid: string | null;
  readonly numbers: readonly OwnAccountNumber[];
  /** Numbers in the account that are already this business's. */
  readonly alreadyHere: number;
  readonly truncated: boolean;
}

/**
 * The numbers in the business's own Twilio account that are not set up here: one moved there straight through
 * Twilio's or HighLevel's support, without anybody starting a transfer here first.
 */
export function listOwnNumbers(workspaceId: string): Promise<OwnAccountListing> {
  return workerPost('/v1/telephony/own-numbers', { workspaceId });
}

/** The team's Join on a HandsFreeOS video call (docs/video-calls.md): straight in, on a ticket the worker signed. */
export interface TeamJoin {
  readonly workspaceId: string;
  readonly call: {
    readonly id: string;
    readonly state: 'open' | 'live' | 'ended';
    readonly appointmentId: string | null;
    readonly hostUserId: string | null;
  };
  /** Their identity in the room. */
  readonly personId: string;
  readonly name: string;
  readonly ticket: VideoTicket;
}

/**
 * Joining as someone from the team. A call they can't see (another business's, or an appointment that isn't theirs
 * to see) is refused, and the page asks to be let in instead, like anyone else on the link.
 */
export function joinVideoCall(callId: string): Promise<TeamJoin> {
  return workerPost('/v1/video-calls/join', { callId });
}

/** Video call on a customer's page or in a conversation, and Switch to video (docs/video-calls.md, part 5). */
export interface StartedVideoCall {
  readonly callId: string;
  readonly personId: string;
  readonly conversationId: string | null;
  readonly channel: 'sms' | 'email' | 'chat' | 'portal' | 'messenger' | 'instagram';
  /** The customer, for "Dana’s link is on its way". */
  readonly name: string;
}

/**
 * A call with a customer: their own link goes to them as you (on the business's own domain once one works, which
 * is why the worker builds it), and the call is made for you to join.
 */
export function startVideoCall(input: {
  workspaceId: string;
  personId?: string;
  conversationId?: string;
  channel?: 'sms' | 'email';
  acknowledgeQuietHours?: boolean;
}): Promise<StartedVideoCall> {
  return workerPost('/v1/video-calls/start', input);
}
