/**
 * Where usage is noticed (M16, step 3). One function per kind of event, each turning what a carrier told us
 * into the parts `chargeUsage` prices — and nothing else. The funnel does the money; these say what happened.
 *
 * Two rules run through all of them:
 *
 * **Never wait for a provider's own price.** Twilio leaves `price` out of most message callbacks and fills it
 * in minutes after a call, so a wallet that waited for it would let a business spend all night for free. Every
 * charge here is written from the rate card at the moment of the event (`cost_source: 'rate_card'`), and a
 * nightly reconciliation against the carrier's own daily records inserts an adjustment for the difference.
 *
 * **Charge what the carrier charges, not what we would like to have happened.** An undelivered text is billed
 * to us, so it is billed on. A call that rang somebody's own cell is two legs, so it is two charges. Getting
 * this wrong is not a rounding error — it is the difference between a 1.5× margin and a loss.
 */
import {
  callLegUsageKey,
  callUsageKey,
  mmsUsageKey,
  smsUsageKey,
  videoCallUsageKey,
} from '@hfos/core/server';
import {
  aiRateKeys,
  roundedSeconds,
  type RateCard,
  type UsageKey,
  type UsagePart,
} from '@hfos/core/server';
import { formatPhone } from '@hfos/core';
import type { TenantScope } from '../services';
import { chargeUsage, rateCard, type Charged, type WalletDeps } from './wallet';

/** What a phone number is, which decides what a call to it costs us. */
export type NumberKind = 'local' | 'tollfree';

/** The statuses Twilio bills us for. `undelivered` is on the list because the carrier still took the message. */
const BILLED_TEXT_STATUSES = new Set(['sent', 'delivered', 'undelivered']);

export interface TextUsage {
  readonly messageSid: string;
  readonly direction: 'inbound' | 'outbound';
  /** Outbound only: the delivery status the callback carried. Inbound is billed once, on arrival. */
  readonly status?: string | null;
  /** From `smsSegments()`, which already counts them for the message row. At least one. */
  readonly segments: number;
  /** Pictures and files. A message with any is billed as MMS, which is priced per message rather than per segment. */
  readonly mediaCount: number;
  readonly counterpart: string;
  readonly messageId?: string | null;
  readonly occurredAt?: Date;
}

/**
 * One text. The key is the message's own sid, so `sent`, `delivered` and a webhook retry of both land on one
 * row — the ledger's unique index does the rest.
 *
 * A message with a picture on it is one MMS and not also N segments: Twilio bills the picture, and the words
 * ride along with it.
 */
export async function chargeText(
  deps: WalletDeps,
  scope: TenantScope,
  usage: TextUsage,
): Promise<Charged> {
  const outbound = usage.direction === 'outbound';
  if (outbound && !BILLED_TEXT_STATUSES.has((usage.status ?? '').toLowerCase())) return NOT_CHARGED;
  const picture = usage.mediaCount > 0;
  const key: UsageKey = picture
    ? outbound
      ? 'mms.outbound.message'
      : 'mms.inbound.message'
    : outbound
      ? 'sms.outbound.segment'
      : 'sms.inbound.segment';
  return chargeUsage(deps, scope, {
    parts: [{ key, quantity: picture ? 1 : Math.max(1, Math.round(usage.segments)) }],
    idempotencyKey: picture ? mmsUsageKey(usage.messageSid) : smsUsageKey(usage.messageSid),
    subject: textSubject(outbound, picture, usage.counterpart),
    entityType: 'message',
    entityId: usage.messageId ?? null,
    providerRef: usage.messageSid,
    ...(usage.occurredAt ? { occurredAt: usage.occurredAt } : {}),
  });
}

function textSubject(outbound: boolean, picture: boolean, counterpart: string): string {
  const who = counterpart.startsWith('+') ? formatPhone(counterpart) : counterpart;
  const what = picture ? 'Picture message' : 'Text';
  return outbound ? `${what} to ${who}` : `${what} from ${who}`;
}

export interface CallUsage {
  readonly callSid: string;
  readonly direction: 'inbound' | 'outbound';
  readonly seconds: number | null;
  /** Which of our numbers it came in on: a toll-free minute costs us two and a half times a local one. */
  readonly numberKind: NumberKind;
  readonly counterpart: string;
  readonly callId?: string | null;
  readonly occurredAt?: Date;
}

/**
 * One call, at its end. The carrier bills per whole minute, so a 20-second call is a minute — `roundedSeconds`
 * reads that off the card rather than assuming it, because the day a carrier bills per second the card is
 * where that changes.
 */
export async function chargeCall(
  deps: WalletDeps,
  scope: TenantScope,
  usage: CallUsage,
): Promise<Charged> {
  const key = callRateKey(usage.direction, usage.numberKind);
  const card = await rateCard(deps, scope);
  const minutes = minutesOf(card, key, usage.seconds);
  if (minutes <= 0) return NOT_CHARGED;
  const who = usage.counterpart.startsWith('+')
    ? formatPhone(usage.counterpart)
    : usage.counterpart;
  return chargeUsage(deps, scope, {
    parts: [{ key, quantity: minutes }],
    idempotencyKey: callUsageKey(usage.callSid),
    subject: `${usage.direction === 'inbound' ? 'Call from' : 'Call to'} ${who}`,
    entityType: 'call',
    entityId: usage.callId ?? null,
    providerRef: usage.callSid,
    ...(usage.occurredAt ? { occurredAt: usage.occurredAt } : {}),
  });
}

export interface CallLegUsage {
  readonly parentCallSid: string;
  /** The number this leg dialled: what tells two legs of one call apart. */
  readonly toE164: string;
  readonly seconds: number | null;
  readonly callId?: string | null;
  readonly occurredAt?: Date;
}

/**
 * The second half of a forwarded call. A customer ringing the business and being put through to somebody's own
 * cell is **two** billable legs — the one that came in and the one we dialled out — and the outbound leg is
 * charged at the outbound rate whichever way the original call was going.
 */
export async function chargeCallLeg(
  deps: WalletDeps,
  scope: TenantScope,
  usage: CallLegUsage,
): Promise<Charged> {
  const card = await rateCard(deps, scope);
  const minutes = minutesOf(card, 'voice.outbound.minute', usage.seconds);
  if (minutes <= 0) return NOT_CHARGED;
  return chargeUsage(deps, scope, {
    parts: [{ key: 'voice.outbound.minute', quantity: minutes }],
    idempotencyKey: callLegUsageKey(usage.parentCallSid, usage.toE164),
    subject: `Call put through to ${formatPhone(usage.toE164)}`,
    entityType: 'call',
    entityId: usage.callId ?? null,
    providerRef: usage.parentCallSid,
    ...(usage.occurredAt ? { occurredAt: usage.occurredAt } : {}),
  });
}

export const callRateKey = (direction: 'inbound' | 'outbound', kind: NumberKind): UsageKey =>
  direction === 'outbound'
    ? 'voice.outbound.minute'
    : kind === 'tollfree'
      ? 'voice.inbound.tollfree.minute'
      : 'voice.inbound.local.minute';

/** Seconds to billable minutes, rounded the way the card says the carrier rounds. */
export function minutesOf(card: RateCard, key: UsageKey, seconds: number | null): number {
  const rounding = card.rates[key]?.roundUpTo ?? 'minute';
  return roundedSeconds(Math.max(0, seconds ?? 0), rounding) / 60;
}

export interface AiTokens {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/**
 * One AI request, as four parts rounded together. The buckets are priced apart — a cache read is a tenth of an
 * input token and a cache write a quarter more than one — so a card with only input and output would be wrong
 * by roughly twice, and rounding the four apart would lose a penny four times over.
 */
export async function chargeAi(
  deps: WalletDeps,
  scope: TenantScope,
  input: {
    readonly tokens: AiTokens;
    readonly idempotencyKey: string;
    readonly subject: string;
    readonly entityType?: 'ai_usage' | 'assistant_run';
    readonly entityId?: string | null;
    /** A model with no line on the card is billed at `ai.unknown.mtok`, which is dear on purpose. */
    readonly known: boolean;
    readonly model?: string | null;
    readonly occurredAt?: Date;
  },
): Promise<Charged> {
  const t = input.tokens;
  // Claude Opus (Ask HandsFreeOS) has lines of its own; private.ai_spend_today picks them by the same rule.
  const keys = aiRateKeys(input.model);
  const parts: UsagePart[] = input.known
    ? [
        { key: keys.input, quantity: mtok(t.inputTokens) },
        { key: keys.output, quantity: mtok(t.outputTokens) },
        { key: keys.cacheRead, quantity: mtok(t.cacheReadTokens) },
        { key: keys.cacheWrite, quantity: mtok(t.cacheWriteTokens) },
      ]
    : [
        {
          key: 'ai.unknown.mtok',
          quantity: mtok(
            (t.inputTokens ?? 0) +
              (t.outputTokens ?? 0) +
              (t.cacheReadTokens ?? 0) +
              (t.cacheWriteTokens ?? 0),
          ),
        },
      ];
  return chargeUsage(deps, scope, {
    parts,
    idempotencyKey: input.idempotencyKey,
    subject: input.subject,
    entityType: input.entityType ?? 'ai_usage',
    entityId: input.entityId ?? null,
    ...(input.model ? { meta: { model: input.model } } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

export interface VideoCallUsage {
  /** LiveKit's id for the room as it ran this stretch of the call: one charge per stretch. */
  readonly roomSid: string;
  /** Everyone's seconds in the call this stretch, added up. The AI's listener never counts. */
  readonly personSeconds: number;
  /** How many people the call has had, for the statement. */
  readonly people: number;
  readonly title: string;
  readonly callId: string;
  readonly occurredAt?: Date;
}

/**
 * One stretch of a HandsFreeOS video call, once its room closes: every person's minutes together, to the second.
 * LiveKit bills a participant minute per person, so two people for ten minutes is twenty.
 */
export async function chargeVideoCall(
  deps: WalletDeps,
  scope: TenantScope,
  usage: VideoCallUsage,
): Promise<Charged> {
  const minutes = Math.max(0, Number.isFinite(usage.personSeconds) ? usage.personSeconds : 0) / 60;
  if (minutes <= 0) return NOT_CHARGED;
  return chargeUsage(deps, scope, {
    parts: [{ key: 'video.minute', quantity: Math.round(minutes * 10_000) / 10_000 }],
    idempotencyKey: videoCallUsageKey(usage.roomSid),
    subject: `Video call: ${usage.title}`,
    providerRef: usage.roomSid,
    meta: { videoCallId: usage.callId, people: usage.people, seconds: usage.personSeconds },
    ...(usage.occurredAt ? { occurredAt: usage.occurredAt } : {}),
  });
}

/** Tokens to millions of tokens, which is what the card is priced in. */
const mtok = (tokens: number | undefined): number =>
  Math.max(0, Number.isFinite(tokens) ? (tokens ?? 0) : 0) / 1_000_000;

const NOT_CHARGED: Charged = {
  recorded: false,
  amountCents: 0,
  costCents: 0,
  balanceAfterCents: null,
  crossed: null,
};
