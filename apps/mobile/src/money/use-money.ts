import {
  addDays,
  COLLECTED_DAYS,
  estimateState,
  invoiceState,
  localDateOf,
  localInstant,
  moneyTabsFor,
  seesWholeBusiness,
  type EstimateState,
  type InvoiceState,
  type MoneyRole,
  type MoneySummaryFacts,
  type MoneyTab,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import type { OutboxRow } from '@/changes/outbox';
import { SENT_SHOWN_MS } from '@/changes/rules';
import { useBusiness } from '@/components/shell/business-context';

import { withOwnChanges } from './outbox';
import {
  COLLECTED_SQL,
  ESTIMATE_LINES_SQL,
  ESTIMATE_SQL,
  ESTIMATES_SQL,
  INVOICE_LINES_SQL,
  INVOICE_PAYMENTS_SQL,
  INVOICE_REFUNDS_SQL,
  INVOICE_SQL,
  INVOICES_SQL,
  MONEY_OUTBOX_SQL,
  MY_ROLE_SQL,
  PAYMENTS_SQL,
  SUBSCRIPTIONS_SQL,
  SUMMARY_SQL,
} from './queries';

/**
 * Money from the phone's copy: the documents this person may see, their states worked out the way the server works
 * them out (core's `invoiceState` and `estimateState`), and this phone's own changes over them.
 *
 * The copy is already filtered to what the person may see, so nothing here hides a figure — but the three headline
 * figures, Payments and Plans are about the whole business, so they only appear for someone `seesWholeBusiness`
 * says sees it.
 */

export interface InvoiceRow {
  readonly id: string;
  readonly number: string | null;
  readonly status: string;
  readonly purpose: string;
  readonly origin: string;
  readonly title: string | null;
  readonly person_id: string | null;
  readonly person_name: string;
  readonly person_email: string | null;
  readonly person_phone: string | null;
  readonly total_cents: number | null;
  readonly amount_paid_cents: number | null;
  readonly amount_refunded_cents: number | null;
  readonly balance_cents: number | null;
  readonly settling: number | null;
  readonly due_on: string | null;
  readonly terms: string | null;
  readonly sent_at: string | null;
  readonly first_viewed_at: string | null;
  readonly paid_at: string | null;
  readonly voided_at: string | null;
  readonly created_at: string | null;
  readonly subtotal_cents: number | null;
  readonly discount_cents: number | null;
  readonly discount_percent_bp: number | null;
  readonly taxable_base_cents: number | null;
  readonly tax_cents: number | null;
  readonly tax_rate_bp: number | null;
  readonly tax_label: string | null;
  readonly notes: string | null;
  readonly attendee_id: string | null;
  readonly estimate_id: string | null;
  readonly subscription_id: string | null;
}

/** An invoice as the phone's screens read it: the row plus the state the server would call it. */
export interface PhoneInvoice extends InvoiceRow {
  readonly state: InvoiceState;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly refundedCents: number;
  readonly balanceCents: number;
  /** A change on this phone that hasn't reached HandsFreeOS yet. */
  readonly pending: {
    readonly id: string;
    readonly state: OutboxRow['state'];
    readonly name: string;
  } | null;
}

export interface EstimateRow {
  readonly id: string;
  readonly number: string | null;
  readonly status: string;
  readonly title: string | null;
  readonly person_id: string | null;
  readonly person_name: string;
  readonly person_email: string | null;
  readonly person_phone: string | null;
  readonly total_cents: number | null;
  readonly subtotal_cents: number | null;
  readonly discount_cents: number | null;
  readonly discount_percent_bp: number | null;
  readonly taxable_base_cents: number | null;
  readonly tax_cents: number | null;
  readonly tax_rate_bp: number | null;
  readonly tax_label: string | null;
  readonly deposit_cents: number | null;
  readonly expires_on: string | null;
  readonly sent_at: string | null;
  readonly first_viewed_at: string | null;
  readonly accepted_at: string | null;
  readonly declined_at: string | null;
  readonly voided_at: string | null;
  readonly created_at: string | null;
  readonly notes: string | null;
}

export interface PhoneEstimate extends EstimateRow {
  readonly state: EstimateState;
}

export interface LineRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly quantity: number;
  readonly unit_label: string;
  readonly unit_price_cents: number;
  readonly taxable: number;
  readonly discount_cents: number;
  readonly amount_cents: number;
}

export interface PaymentRow {
  readonly id: string;
  readonly invoice_id: string | null;
  readonly invoice_number: string | null;
  readonly person_name: string | null;
  readonly amount_cents: number;
  readonly refunded_cents: number;
  readonly method: string;
  readonly provider: string | null;
  readonly status: string;
  readonly received_at: string | null;
  readonly card_brand: string | null;
  readonly card_last4: string | null;
  readonly created_at: string | null;
}

export interface SubscriptionRow {
  readonly id: string;
  readonly plan_name: string;
  readonly price_cents: number;
  readonly interval: string;
  readonly interval_count: number;
  readonly status: string;
  readonly person_name: string;
  readonly next_billing_on: string | null;
  readonly card_brand: string | null;
  readonly card_last4: string | null;
}

/** Now, moved on every minute: "3 days overdue" and "Due today" read it. */
export function useMoneyNow(everyMs = 60_000): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * What this person may see. The synced `workspace_access` row is the truth (it is what the sync rules themselves
 * read); the role the phone kept from `account.me` stands in until the first copy has it.
 */
export function useMoneyRole(): { role: MoneyRole; whole: boolean; tabs: readonly MoneyTab[] } {
  const { business, me } = useBusiness();
  const { data } = useQuery<{ role: string | null }>(MY_ROLE_SQL, [business.id, me.user.id]);
  const role = (data[0]?.role ?? business.role) as MoneyRole;
  return React.useMemo(
    () => ({ role, whole: seesWholeBusiness(role), tabs: moneyTabsFor(role) }),
    [role],
  );
}

/** Money's changes on this phone, not through or sent just now. */
export function useMoneyOutbox(): readonly OutboxRow[] {
  const { business } = useBusiness();
  const since = React.useMemo(() => new Date(Date.now() - SENT_SHOWN_MS).toISOString(), []);
  const { data } = useQuery<OutboxRow>(MONEY_OUTBOX_SQL, [business.id, since]);
  return data;
}

/** The business's time zone: a due day ends where the business is, not where the phone is. */
export function useMoneyZone(): string {
  const { business } = useBusiness();
  const { data } = useQuery<{ timezone: string | null }>(
    'SELECT timezone FROM workspaces WHERE id = ?',
    [business.id],
  );
  return data[0]?.timezone || business.timezone;
}

/** Turns one synced row into the invoice the screens read, with its state worked out as the server works it out. */
export function invoiceOf(
  row: InvoiceRow,
  outbox: readonly OutboxRow[],
  timeZone: string,
  now: number,
): PhoneInvoice {
  const base = withOwnChanges(row, outbox);
  const totalCents = base.total_cents ?? 0;
  const paidCents = base.amount_paid_cents ?? 0;
  const refundedCents = base.amount_refunded_cents ?? 0;
  const balanceCents = base.balance_cents ?? Math.max(totalCents - paidCents, 0);
  return {
    ...base,
    totalCents,
    paidCents,
    refundedCents,
    balanceCents,
    state: invoiceState(
      {
        status: base.status as never,
        dueDate: base.due_on,
        timeZone,
        balanceCents,
        viewedAt: base.first_viewed_at,
        hasProcessingPayment: Number(base.settling ?? 0) > 0,
        totalCents,
        paidCents,
        refundedCents,
      },
      now,
    ),
  };
}

/** Every invoice on this phone for the business, newest first. */
export function useInvoices(): {
  readonly items: readonly PhoneInvoice[];
  readonly loading: boolean;
} {
  const { business } = useBusiness();
  const timeZone = useMoneyZone();
  const now = useMoneyNow();
  const { data, isLoading } = useQuery<InvoiceRow>(INVOICES_SQL, [business.id]);
  const outbox = useMoneyOutbox();
  return React.useMemo(
    () => ({
      items: data.map((row) => invoiceOf(row, outbox, timeZone, now)),
      loading: isLoading,
    }),
    [data, outbox, timeZone, now, isLoading],
  );
}

/** One invoice, its lines, its payments and its refunds. */
export function useInvoice(invoiceId: string): {
  readonly invoice: PhoneInvoice | null;
  readonly lines: readonly LineRow[];
  readonly payments: readonly PaymentRow[];
  readonly refunds: readonly {
    readonly id: string;
    readonly amount_cents: number;
    readonly status: string;
    readonly refunded_at: string | null;
  }[];
  readonly loading: boolean;
} {
  const { business } = useBusiness();
  const timeZone = useMoneyZone();
  const now = useMoneyNow();
  const { data, isLoading } = useQuery<InvoiceRow>(INVOICE_SQL, [business.id, invoiceId]);
  const lines = useQuery<LineRow>(INVOICE_LINES_SQL, [business.id, invoiceId]);
  const payments = useQuery<PaymentRow>(INVOICE_PAYMENTS_SQL, [business.id, invoiceId]);
  const refunds = useQuery<{
    id: string;
    amount_cents: number;
    status: string;
    refunded_at: string | null;
  }>(INVOICE_REFUNDS_SQL, [business.id, invoiceId]);
  const outbox = useMoneyOutbox();
  const row = data[0];
  return React.useMemo(
    () => ({
      invoice: row ? invoiceOf(row, outbox, timeZone, now) : null,
      lines: lines.data,
      payments: payments.data,
      refunds: refunds.data,
      loading: isLoading,
    }),
    [row, lines.data, payments.data, refunds.data, outbox, timeZone, now, isLoading],
  );
}

const estimateOf = (row: EstimateRow, timeZone: string, now: number): PhoneEstimate => ({
  ...row,
  state: estimateState(
    {
      status: row.status as never,
      expiresAt: row.expires_on
        ? new Date(localInstant(addDays(row.expires_on, 1), '00:00', timeZone)).toISOString()
        : null,
      viewedAt: row.first_viewed_at,
    },
    now,
  ),
});

export function useEstimates(): {
  readonly items: readonly PhoneEstimate[];
  readonly loading: boolean;
} {
  const { business } = useBusiness();
  const timeZone = useMoneyZone();
  const now = useMoneyNow();
  const { data, isLoading } = useQuery<EstimateRow>(ESTIMATES_SQL, [business.id]);
  return React.useMemo(
    () => ({ items: data.map((r) => estimateOf(r, timeZone, now)), loading: isLoading }),
    [data, timeZone, now, isLoading],
  );
}

export function useEstimate(estimateId: string): {
  readonly estimate: PhoneEstimate | null;
  readonly lines: readonly LineRow[];
  readonly loading: boolean;
} {
  const { business } = useBusiness();
  const timeZone = useMoneyZone();
  const now = useMoneyNow();
  const { data, isLoading } = useQuery<EstimateRow>(ESTIMATE_SQL, [business.id, estimateId]);
  const lines = useQuery<LineRow>(ESTIMATE_LINES_SQL, [business.id, estimateId]);
  const row = data[0];
  return React.useMemo(
    () => ({
      estimate: row ? estimateOf(row, timeZone, now) : null,
      lines: lines.data,
      loading: isLoading,
    }),
    [row, lines.data, timeZone, now, isLoading],
  );
}

export function usePayments(): readonly PaymentRow[] {
  const { business } = useBusiness();
  const { data } = useQuery<PaymentRow>(PAYMENTS_SQL, [business.id]);
  return data;
}

export function useSubscriptions(): readonly SubscriptionRow[] {
  const { business } = useBusiness();
  const { data } = useQuery<SubscriptionRow>(SUBSCRIPTIONS_SQL, [business.id]);
  return data;
}

/**
 * The three headline figures, worked out on the phone. The API's `money.summary` needs signal and is the whole
 * business's, so a truck with no bars would show nothing; this reads the same copy the list reads.
 */
export function useMoneySummary(timeZone: string, days = COLLECTED_DAYS): MoneySummaryFacts | null {
  const { business } = useBusiness();
  const { whole } = useMoneyRole();
  const now = useMoneyNow();
  const today = localDateOf(now, timeZone);
  const from = new Date(localInstant(addDays(today, -days), '00:00', timeZone)).toISOString();
  const summary = useQuery<{
    outstanding_cents: number;
    outstanding_count: number;
    settling_cents: number;
    overdue_cents: number;
    overdue_count: number;
  }>(SUMMARY_SQL, [today, today, business.id]);
  const collected = useQuery<{ collected_cents: number; refunded_cents: number }>(COLLECTED_SQL, [
    business.id,
    from,
    business.id,
    from,
  ]);
  return React.useMemo(() => {
    if (!whole) return null;
    const s = summary.data[0];
    const c = collected.data[0];
    if (!s) return null;
    return {
      outstandingCents: s.outstanding_cents,
      outstandingCount: s.outstanding_count,
      settlingCents: s.settling_cents,
      overdueCents: s.overdue_cents,
      overdueCount: s.overdue_count,
      collectedCents: c?.collected_cents ?? 0,
      refundedCents: c?.refunded_cents ?? 0,
      now,
    };
  }, [whole, summary.data, collected.data, now]);
}
