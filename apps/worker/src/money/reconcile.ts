/**
 * The nightly true-up (M16, step 4): what the carrier says a business cost us, against what we charged them.
 *
 * Everything the wallet charges is priced from our own rate card at the moment of the event, because a
 * carrier's own price arrives minutes late or not at all, and a wallet that waited for it would let a business
 * spend all night for free. That makes every charge a good guess and none of them the truth. This is where the
 * truth arrives — two days late, which is exactly when it is cheap to act on.
 *
 * **It never edits anything.** A disagreement inserts one `adjustment` row per category per day, keyed
 * `reconcile:<category>:<day>`, so a pass re-run over a week it has already done writes nothing. The ledger
 * stays something you can hand to somebody, and a month's statement still adds up to the balance.
 *
 * **Only up, never down.** Where the carrier charged us more than we charged on, an adjustment makes it right.
 * Where we charged more, it is left alone: giving money back is somebody's decision, not a nightly job's, and
 * nobody should wake up to a job having quietly rewritten their statement in either direction.
 *
 * **Only the categories we know.** Twilio's daily records are a hierarchy — `sms` is `sms-inbound` plus
 * `sms-outbound` — so summing everything it returns would charge for a text twice. `CARRIER_CATEGORIES` is
 * therefore an allow-list of leaves, and anything not on it is **reported rather than charged**: the job's
 * result names it and its cost, so somebody adds it on purpose. That is how a carrier fee, a recording or a
 * number lookup stops being free — deliberately, with a line added to the rate card, and never by a job
 * guessing what an unfamiliar word on an invoice means.
 *
 * **Authoritative per business, with no allocation guesswork**, because each workspace has its own Twilio
 * subaccount: their records for that subaccount are that business's usage and nobody else's.
 */
import {
  MARKUP_DEFAULT_BP,
  reconcileUsageKey,
  roundHalfUp,
  type UsageKey,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { JobContext, JobHandler } from '../jobs';
import { tenantOf, type TenantScope } from '../services';
import { loadAccount } from '../telephony/accounts';
import type { DailyUsage } from '../telephony/provider';
import { chargeUsage } from './wallet';

export const RECONCILE_JOBS = {
  /** Global, nightly: arms one pass per business that has a carrier account. */
  plan: 'wallet.reconcile_plan',
  /** One business, one day. */
  run: 'wallet.reconcile',
} as const;

export const RECONCILE_PLAN_KEY = 'wallet:reconcile-plan';
export const reconcileJobKey = (workspaceId: string, day: string): string =>
  `wallet-reconcile:${workspaceId}:${day}`;

const DAY_MS = 86_400_000;
const PLAN_CHUNK = 500;
/**
 * How far back a pass reaches. **Two** days, not one: Twilio's daily records keep settling for a day or so
 * after a day ends, and one adjustment per category per day means there is no second bite. Reconciling a day
 * that has stopped moving is worth the extra day of lag.
 */
const LAG_DAYS = 2;
/** Four in the morning UTC, by which time the day two days back has long since settled. */
const RUN_AT_HOUR_UTC = 4;
/**
 * A difference smaller than this is not worth a row. Carriers round differently from us and any busy day will
 * disagree by a penny or two; writing that down nightly would bury the days that actually matter.
 */
const NOISE_CENTS = 5;

/**
 * Twilio's category names, and the rate keys we should already have charged for each. A category with no keys
 * is one we price at nothing today — a carrier fee, a recording — so the whole of its cost is a shortfall and
 * the adjustment is the first money we have ever taken for it.
 *
 * Parent categories (`sms`, `calls`, `mms`, `phonenumbers`, `totalprice`) are deliberately absent: they are the
 * sums of the leaves below them, and charging both would charge twice.
 */
export const CARRIER_CATEGORIES: Readonly<Record<string, readonly UsageKey[]>> = {
  'sms-outbound': ['sms.outbound.segment'],
  'sms-inbound': ['sms.inbound.segment'],
  'mms-outbound': ['mms.outbound.message'],
  'mms-inbound': ['mms.inbound.message'],
  'calls-outbound': ['voice.outbound.minute'],
  // Every inbound call, to local and toll-free numbers alike. Its parts (`calls-inbound-local` and the rest) are
  // in COUNTED_ELSEWHERE: comparing them too would charge an inbound call's shortfall twice.
  'calls-inbound': ['voice.inbound.local.minute', 'voice.inbound.tollfree.minute'],
  // Priced at nothing today, on purpose: transcription is bundled into the plan (2.2) and recording is folded
  // into the minute. If either ever costs more than it is worth, this is where it shows up first.
  recordings: [],
  'recordings-encrypted': [],
  transcriptions: [],
  // A browser leg. Not on the card, and named here so its cost is charged rather than quietly absorbed.
  'calls-client': [],
  // Asking the phone company about a number before an AI call with no yes (AI calls, part 5), charged when asked.
  // Caller name lookups for any other reason still show up here as a shortfall.
  calleridlookups: ['lookup.caller_name'],
  'enhanced-line-type-lookups': ['lookup.line_type'],
};

/**
 * Twilio's categories that are already inside another line, so comparing them on their own would charge for
 * them twice. The parts of `calls-inbound`, which Twilio reports beside it. And the carriers' per-message fees:
 * the card's price for a text or picture already includes the carrier's pass-through (`sms.outbound.segment`
 * is Twilio's $0.0079 plus about $0.003 of it), so a fee line charged again here would be the same money twice.
 * Known, so not reported as unknown.
 */
export const COUNTED_ELSEWHERE: ReadonlySet<string> = new Set([
  'calls-inbound-local',
  'calls-inbound-tollfree',
  'calls-inbound-mobile',
  'carrier-fees',
  'sms-messages-carrierfees',
  'mms-messages-carrierfees',
]);

/**
 * Twilio's categories for things we charge on our own schedule and never compare day by day, because Twilio dates
 * them by its own clock. Texting registration fees, which the business pays by card and not from the balance
 * (telephony/texting-fees.ts): a review when the reviewer gets to it, a campaign's month on its anniversary. Phone numbers (money/number-months.ts): Twilio charges each on the
 * day of the month it was bought, and we charge by the calendar month. A day-by-day comparison would see our
 * charge on one day and Twilio's on another and charge the business twice, so these are known and left alone
 * rather than reported as unknown.
 */
export const CHARGED_WHEN_THEY_HAPPEN: ReadonlySet<string> = new Set([
  'a2p-registration-fees',
  'phonenumbers-local',
  'phonenumbers-tollfree',
]);

/** The day a pass covers, in UTC, because that is how the carrier dates its records. */
export const dayToReconcile = (now: number): string =>
  new Date(now - LAG_DAYS * DAY_MS).toISOString().slice(0, 10);

/** Tonight's run, or tomorrow night's if tonight's has been and gone. */
export function nextReconcileAt(now: number): Date {
  const at = new Date(now);
  at.setUTCHours(RUN_AT_HOUR_UTC, 0, 0, 0);
  return at.getTime() <= now ? new Date(at.getTime() + DAY_MS) : at;
}

/** Nightly, for the whole server: one reconciliation waiting per business with a carrier account. */
export const planReconcile: JobHandler = async (ctx) => {
  const day = dayToReconcile(ctx.now);
  const from = new Date(ctx.now).toISOString();
  await asWorker(ctx.db, {}, async (tx) => {
    // Through a function: the worker's own policy on telephony_accounts shows only the business in scope, and
    // here there is none, so reading the table directly found nobody and no business was ever checked.
    const list = await rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.telephony_accounts_open()`,
    );
    for (let i = 0; i < list.length; i += PLAN_CHUNK)
      for (const b of list.slice(i, i + PLAN_CHUNK))
        // Spread over the hour by workspace id, so five hundred businesses do not all ask Twilio at once.
        await tx.execute(
          sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
              values (${b.organization_id}, ${b.workspace_id}, ${RECONCILE_JOBS.run},
                ${reconcileJobKey(b.workspace_id, day)},
                ${from}::timestamptz
                  + (abs(hashtext(${b.workspace_id}::text)::bigint) % 3600000::bigint)
                    * interval '1 millisecond',
                ${JSON.stringify({ day })}::jsonb)
              on conflict do nothing`,
        );
  });
  return { rescheduleAt: nextReconcileAt(ctx.now) };
};

/** One business, one day: ask the carrier what it charged us, and write down where we were wrong. */
export const runReconcile: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const day = String((ctx.job.payload as { day?: string } | null)?.day ?? dayToReconcile(ctx.now));
  const account = await asWorker(ctx.db, scope, (tx) =>
    loadAccount(tx, scope.workspaceId, ctx.sealer),
  );
  if (!account) return;
  const theirs = await ctx.telephony.usageDaily(account, { start: day, end: day });
  const ours = await ourCostOn(ctx.db, scope, day);
  const found = await reconcileDay(ctx, scope, day, theirs, ours);
  if (found.unknown.length)
    ctx.log.warn(
      { workspaceId: scope.workspaceId, day, categories: found.unknown },
      'the carrier billed for categories the rate card has never heard of; price them on purpose',
    );
};

/** What our own ledger says each carrier category cost us on that day. */
async function ourCostOn(db: Db, scope: TenantScope, day: string): Promise<Map<string, number>> {
  const list = await asWorker(db, scope, (tx) =>
    rows<{ rate_key: string; cost_cents: number | string }>(
      tx,
      sql`select rate_key, sum(coalesce(cost_cents, 0)) as cost_cents
          from app.usage_ledger
          where workspace_id = ${scope.workspaceId} and kind = 'spend' and rate_key is not null
            and occurred_at >= ${day}::date and occurred_at < (${day}::date + 1)
          group by rate_key`,
    ),
  );
  const byKey = new Map(list.map((r) => [r.rate_key, Number(r.cost_cents)]));
  // A carrier category may cover more than one of our keys (inbound calls are local and toll-free to us, one
  // category to Twilio), so its cost is what all of its keys cost together.
  const byCategory = new Map<string, number>();
  for (const [category, keys] of Object.entries(CARRIER_CATEGORIES))
    byCategory.set(
      category,
      keys.reduce((n, key) => n + (byKey.get(key) ?? 0), 0),
    );
  return byCategory;
}

export interface Reconciled {
  readonly rows: number;
  readonly cents: number;
  /** Categories the carrier billed for that nothing here knows how to price. Reported, never guessed at. */
  readonly unknown: readonly string[];
}

/** One adjustment per category we under-charged for, at the card's own markup. */
export async function reconcileDay(
  ctx: Pick<JobContext, 'wallet'>,
  scope: TenantScope,
  day: string,
  theirs: readonly DailyUsage[],
  ours: Map<string, number>,
): Promise<Reconciled> {
  let rows = 0;
  let cents = 0;
  const unknown: string[] = [];
  for (const line of theirs) {
    const theirCostCents = roundHalfUp(line.costMicros / 10_000);
    if (theirCostCents <= 0) continue;
    if (CHARGED_WHEN_THEY_HAPPEN.has(line.category) || COUNTED_ELSEWHERE.has(line.category))
      continue;
    if (!(line.category in CARRIER_CATEGORIES)) {
      unknown.push(line.category);
      continue;
    }
    const shortfall = theirCostCents - (ours.get(line.category) ?? 0);
    if (shortfall <= 0) continue;
    const amount = roundHalfUp((shortfall * MARKUP_DEFAULT_BP) / 10_000);
    if (amount < NOISE_CENTS) continue;
    const charged = await chargeUsage(ctx.wallet, scope, {
      kind: 'adjustment',
      parts: [],
      amountCents: amount,
      costCents: shortfall,
      costSource: 'reconciled',
      idempotencyKey: reconcileUsageKey(line.category, day),
      subject: subjectFor(
        line.category,
        day,
        (CARRIER_CATEGORIES[line.category] ?? []).length === 0,
      ),
      // Dated to the day it covers rather than the night it ran, so a statement reads in the right order.
      occurredAt: new Date(`${day}T23:59:00Z`),
      meta: {
        carrier_category: line.category,
        carrier_cost_cents: theirCostCents,
        our_cost_cents: ours.get(line.category) ?? 0,
        carrier_count: line.count,
        day,
      },
    });
    if (charged.recorded) {
      rows += 1;
      cents += charged.amountCents;
    }
  }
  return { rows, cents, unknown };
}

/** What the adjustment says on a statement. A category we priced at nothing is named as such, not hidden. */
function subjectFor(category: string, day: string, unpriced: boolean): string {
  const when = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return unpriced
    ? `Carrier charge for ${category} on ${when}`
    : `Correction for ${category} on ${when}`;
}

export const RECONCILE_JOB_HANDLERS = {
  [RECONCILE_JOBS.plan]: planReconcile,
  [RECONCILE_JOBS.run]: runReconcile,
};
