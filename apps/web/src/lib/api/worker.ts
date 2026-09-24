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
