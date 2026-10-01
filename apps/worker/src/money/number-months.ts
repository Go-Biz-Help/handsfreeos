/**
 * A phone number's month on the wallet: once per calendar month, where the business is, for every number it held
 * that month. The rate card has always priced it (`number.local.month`, `number.tollfree.month`) and core has
 * always had the key (`numberMonthUsageKey`), but the sweep that charges it was never built, so numbers went out
 * free. This is that sweep.
 *
 * **Calendar months, not Twilio's.** Twilio charges each number on the day of the month it was bought. The usage
 * page says "a phone number, $2 a month", and a business reads its statement by the month, so each number is one
 * line per month in the business's own time zone. The nightly reconciliation leaves Twilio's `phonenumbers-*`
 * categories alone for that reason: our month and Twilio's fall on different days, and comparing them day by day
 * would charge twice.
 *
 * **Which numbers.** One we bought, moved in, or finished porting (`purchased_at`), that isn't failed or still on
 * its way to us, and that we held at some point this month: still held, or released this month. A number bought
 * and given back between two sweeps still pays for its month, as it does at Twilio.
 *
 * Daily, because a month starts on a day and a number bought today should show today or tomorrow. The key holds
 * the month, so running every day charges each month once.
 */
import { formatPhone } from '@hfos/core';
import { monthOf, numberMonthUsageKey, type UsageKey } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import type { TenantScope } from '../services';
import { chargeUsage, type WalletDeps } from './wallet';

interface HeldNumber {
  readonly id: string;
  readonly e164: string;
  readonly number_type: 'local' | 'toll_free';
  readonly provider_sid: string | null;
  readonly released_at: Date | string | null;
}

/** "October 2026", from `2026-10`. */
const monthWords = (month: string): string =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** What the statement says: "Phone number (512) 555-0134, October 2026". */
export function numberMonthSubject(
  numberType: 'local' | 'toll_free',
  e164: string,
  month: string,
): string {
  const what = numberType === 'toll_free' ? 'Toll-free number' : 'Phone number';
  return `${what} ${formatPhone(e164)}, ${monthWords(month)}`;
}

/** Charges this month for each number a business held this month. Returns how many it charged. */
export async function chargeNumberMonths(
  deps: WalletDeps,
  scope: TenantScope,
  now: number,
): Promise<number> {
  if (deps.mode === 'off') return 0;
  const { numbers, timeZone } = await asWorker(deps.db, scope, async (tx) => {
    const [ws] = await rows<{ timezone: string | null }>(
      tx,
      sql`select timezone from app.workspaces where id = ${scope.workspaceId}`,
    );
    const held = await rows<HeldNumber & Record<string, unknown>>(
      tx,
      sql`select id, e164, number_type::text as number_type, provider_sid, released_at
          from app.phone_numbers
          where workspace_id = ${scope.workspaceId} and purchased_at is not null
            and status not in ('porting', 'failed')
          order by created_at`,
    );
    return { numbers: held, timeZone: ws?.timezone || 'UTC' };
  });
  const month = monthOf(now, timeZone);
  let charged = 0;
  for (const n of numbers) {
    // Given back before this month began: its last month was charged then.
    if (n.released_at && monthOf(new Date(n.released_at), timeZone) < month) continue;
    const key: UsageKey =
      n.number_type === 'toll_free' ? 'number.tollfree.month' : 'number.local.month';
    const result = await chargeUsage(deps, scope, {
      parts: [{ key, quantity: 1 }],
      idempotencyKey: numberMonthUsageKey(n.id, month),
      subject: numberMonthSubject(n.number_type, n.e164, month),
      entityType: 'phone_number',
      entityId: n.id,
      providerRef: n.provider_sid,
      meta: { month },
    });
    if (result.recorded) charged++;
  }
  return charged;
}

/** Every business holding a number has this month charged. Returns how many numbers were charged. */
export async function chargeAllNumberMonths(deps: WalletDeps, now: number): Promise<number> {
  if (deps.mode === 'off') return 0;
  const held = await asWorker(deps.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.phone_numbers_held()`,
    ),
  );
  let charged = 0;
  for (const b of held) {
    const scope: TenantScope = { workspaceId: b.workspace_id, organizationId: b.organization_id };
    try {
      charged += await chargeNumberMonths(deps, scope, now);
    } catch (e) {
      deps.log.error(
        { err: e, workspaceId: scope.workspaceId },
        'could not charge a number’s month',
      );
    }
  }
  return charged;
}

/** The job: daily, for the whole server. */
export const NUMBER_MONTH_JOBS = { charge: 'wallet.number_months' } as const;
export const NUMBER_MONTHS_KEY = 'wallet:number-months';
const EVERY_MS = 24 * 60 * 60_000;

export const runNumberMonths: JobHandler = async (ctx) => {
  await chargeAllNumberMonths(ctx.wallet, ctx.now);
  return { rescheduleAt: new Date(ctx.now + EVERY_MS) };
};
