/**
 * The AI's hearing and voice (Deepgram) on the wallet, at 1.5× what it costs us.
 *
 * Three places use it: talking out loud (http/speech.ts), the AI teammate on a live call (voice-agent/session.ts),
 * and call and voicemail transcripts (telephony/cell.ts). Each writes what it used to `app.speech_usage` in exact
 * quantities — minutes of audio, thousands of characters — because one sentence costs a small fraction of a cent
 * and the ledger holds whole cents. A ledger row per sentence would round every one of them away.
 *
 * `chargeSpeech` is the sweep that turns the tally into money. For each business and each price line it claims the
 * unbilled rows as one batch, charges the batch through `chargeUsage` (the one funnel, priced by the card and
 * rounded once), and marks the rows charged. A batch waits until it's worth at least a quarter, or a day, so a
 * statement isn't a list of pennies and the rounding is a rounding error rather than a markup.
 *
 * **Claim, then charge, then mark.** The batch id is the idempotency key, so a sweep that dies after charging and
 * before marking charges the same batch again on the next run and lands on the row it already wrote.
 *
 * **Never in the way.** Writing a use never throws: a lost fraction of a cent is a smaller wrong than a reply
 * that doesn't get said.
 */
import { randomUUID } from 'node:crypto';
import { priceOf, speechUsageKey, type UsageKey } from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { JobHandler } from '../jobs';
import type { TenantScope } from '../services';
import { chargeUsage, rateCard, type WalletDeps } from './wallet';

export type SpeechKey = Extract<
  UsageKey,
  'speech.live.minute' | 'speech.recording.minute' | 'speech.voice.kchar'
>;
export const SPEECH_KEYS: readonly SpeechKey[] = [
  'speech.live.minute',
  'speech.recording.minute',
  'speech.voice.kchar',
];

export type SpeechSource = 'talk' | 'call' | 'transcript';

export interface SpeechUse {
  readonly key: SpeechKey;
  /** In the line's own unit: minutes, or thousands of characters. */
  readonly quantity: number;
  readonly source: SpeechSource;
  /** The call's or the recording's sid, when there is one. */
  readonly ref?: string | null;
}

/** Seconds of audio as the minutes the card counts. */
export const speechMinutes = (seconds: number): number =>
  Math.max(0, Number.isFinite(seconds) ? seconds : 0) / 60;

/** Words said as the thousands of characters the card counts: Deepgram bills every character it's sent. */
export const speechKchars = (text: string): number => text.length / 1000;

/** The smallest quantity the tally holds (numeric(18, 6)); anything less is nothing. */
const SMALLEST = 0.000001;

/** Writes what was used. Never throws. */
export async function noteSpeech(
  deps: { readonly db: Db; readonly log: Logger },
  scope: TenantScope,
  uses: readonly SpeechUse[],
): Promise<void> {
  const real = uses.filter((u) => Number.isFinite(u.quantity) && u.quantity >= SMALLEST);
  if (!real.length) return;
  try {
    await asWorker(deps.db, scope, async (tx) => {
      for (const u of real)
        await tx.execute(
          sql`insert into app.speech_usage (workspace_id, organization_id, rate_key, quantity, source, ref)
              values (${scope.workspaceId}, ${scope.organizationId}, ${u.key},
                ${Math.min(100_000, u.quantity).toFixed(6)}::numeric, ${u.source},
                ${u.ref?.trim().slice(0, 200) || null})`,
        );
    });
  } catch (e) {
    deps.log.error(
      { err: e, workspaceId: scope.workspaceId, uses: real },
      'could not note speech usage; it goes unbilled',
    );
  }
}

/** When a running total is billed: once it's worth this much, or once its oldest use is this old. */
export interface SpeechBilling {
  readonly minCents: number;
  readonly maxWaitMs: number;
}

export const SPEECH_BILLING: SpeechBilling = { minCents: 25, maxWaitMs: 24 * 60 * 60_000 };

/** What each line says on the statement. The quantity sits beside it. */
export const SPEECH_SUBJECTS: Readonly<Record<SpeechKey, string>> = {
  'speech.live.minute': 'AI voice: listening on calls',
  'speech.recording.minute': 'AI voice: turning speech into words',
  'speech.voice.kchar': 'AI voice: speaking',
};

const isSpeechKey = (v: string): v is SpeechKey => (SPEECH_KEYS as readonly string[]).includes(v);

/**
 * Bills every business's running totals that are due. Returns how many batches it charged. Does nothing with the
 * wallet off: the tally keeps, and is billed once it's on.
 */
export async function chargeSpeech(
  deps: WalletDeps,
  now: number = Date.now(),
  billing: SpeechBilling = SPEECH_BILLING,
): Promise<number> {
  if (deps.mode === 'off') return 0;
  const pending = await asWorker(deps.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.speech_usage_pending()`,
    ),
  );
  let charged = 0;
  for (const p of pending) {
    const scope: TenantScope = { workspaceId: p.workspace_id, organizationId: p.organization_id };
    try {
      charged += await chargeBusiness(deps, scope, now, billing);
    } catch (e) {
      deps.log.error({ err: e, workspaceId: scope.workspaceId }, 'could not bill speech usage');
    }
  }
  return charged;
}

interface Batch {
  readonly batchId: string;
  readonly key: SpeechKey;
  readonly quantity: number;
  readonly from: Date;
  readonly to: Date;
}

async function chargeBusiness(
  deps: WalletDeps,
  scope: TenantScope,
  now: number,
  billing: SpeechBilling,
): Promise<number> {
  const card = await rateCard(deps, scope);
  const batches = await asWorker(deps.db, scope, async (tx) => {
    // A batch claimed before and never marked charged (the sweep stopped half way): charged again as it was.
    const left = await rows<{
      batch_id: string;
      rate_key: string;
      quantity: string;
      from_at: string;
      to_at: string;
    }>(
      tx,
      sql`select batch_id, rate_key, sum(quantity)::text as quantity,
            (extract(epoch from min(created_at)) * 1000)::bigint::text as from_at,
            (extract(epoch from max(created_at)) * 1000)::bigint::text as to_at
          from app.speech_usage
          where workspace_id = ${scope.workspaceId} and batch_id is not null and charged_at is null
          group by batch_id, rate_key`,
    );
    const out: Batch[] = left.flatMap((r) =>
      isSpeechKey(r.rate_key)
        ? [
            {
              batchId: r.batch_id,
              key: r.rate_key,
              quantity: Number(r.quantity),
              from: new Date(Number(r.from_at)),
              to: new Date(Number(r.to_at)),
            },
          ]
        : [],
    );
    const open = await rows<{ rate_key: string; quantity: string; oldest: string }>(
      tx,
      sql`select rate_key, sum(quantity)::text as quantity,
            (extract(epoch from min(created_at)) * 1000)::bigint::text as oldest
          from app.speech_usage
          where workspace_id = ${scope.workspaceId} and batch_id is null
          group by rate_key`,
    );
    for (const o of open) {
      if (!isSpeechKey(o.rate_key)) continue;
      const worth = priceOf(card, o.rate_key, Number(o.quantity)).amountCents;
      if (worth < billing.minCents && now - Number(o.oldest) < billing.maxWaitMs) continue;
      // What's claimed is what's charged: a use written a moment ago is in the batch or in the next one, never
      // counted in the total and missed by the claim.
      const batchId = randomUUID();
      const [claimed] = await rows<{
        quantity: string | null;
        from_at: string | null;
        to_at: string | null;
      }>(
        tx,
        sql`with claimed as (
              update app.speech_usage set batch_id = ${batchId}
              where workspace_id = ${scope.workspaceId} and rate_key = ${o.rate_key} and batch_id is null
              returning quantity, created_at)
            select sum(quantity)::text as quantity,
              (extract(epoch from min(created_at)) * 1000)::bigint::text as from_at,
              (extract(epoch from max(created_at)) * 1000)::bigint::text as to_at
            from claimed`,
      );
      if (!claimed?.quantity || !claimed.from_at || !claimed.to_at) continue;
      out.push({
        batchId,
        key: o.rate_key,
        quantity: Number(claimed.quantity),
        from: new Date(Number(claimed.from_at)),
        to: new Date(Number(claimed.to_at)),
      });
    }
    return out;
  });

  let charged = 0;
  for (const b of batches) {
    const result = await chargeUsage(deps, scope, {
      parts: [{ key: b.key, quantity: b.quantity }],
      idempotencyKey: speechUsageKey(b.batchId, b.key),
      subject: SPEECH_SUBJECTS[b.key],
      occurredAt: b.to,
      meta: { from: b.from.toISOString(), to: b.to.toISOString() },
    });
    // Nothing back and no price means the charge couldn't be written: the batch stays claimed and is charged
    // again next time, on the same key.
    if (!result.recorded && result.amountCents === 0) continue;
    await asWorker(deps.db, scope, (tx) =>
      tx.execute(
        sql`update app.speech_usage set charged_at = now()
            where workspace_id = ${scope.workspaceId} and batch_id = ${b.batchId}`,
      ),
    );
    charged++;
  }
  return charged;
}

/** The job: every quarter of an hour, for the whole server. */
export const SPEECH_JOBS = { charge: 'speech.charge' } as const;
export const SPEECH_CHARGE_KEY = 'speech-charge';
const EVERY_MS = 15 * 60_000;

export const nextSpeechChargeAt = (now: number): Date => new Date(now + EVERY_MS);

export const runSpeechCharge: JobHandler = async (ctx) => {
  await chargeSpeech(ctx.wallet, ctx.now);
  return { rescheduleAt: nextSpeechChargeAt(ctx.now) };
};
