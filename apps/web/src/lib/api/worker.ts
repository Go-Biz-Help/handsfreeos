'use client';
import type { PreflightCheck } from '@hfos/core';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';
import { ApiError } from './errors';
import { mintCorrelationId } from './own-requests';

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

/**
 * Goes and looks at what a carrier's reviewer would look at, before the registration is sent (owners and
 * admins; the worker checks). The worker does it rather than the browser because these are a business's
 * own addresses and fetching them from here would be blocked, unauthenticated and unsafe by turns.
 */
export function registrationPreflight(input: {
  workspaceId: string;
  website?: string;
  policyUrl?: string | null;
  optInPath: 'hosted' | 'own_site' | 'in_person';
  optInUrl?: string | null;
}): Promise<{ checks: PreflightCheck[] }> {
  return workerPost('/v1/telephony/registration-preflight', input);
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
