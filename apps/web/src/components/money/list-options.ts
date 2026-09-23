/**
 * What each Money list can be filtered by, and the query body a filter turns into.
 *
 * Deliberately not a client module: the pages are Server Components, and a value imported across the
 * `'use client'` boundary arrives as a reference rather than the array or function itself.
 */
import { PAYMENT_METHOD_LABELS } from '@hfos/core';
import type {
  EstimateListBody,
  InvoiceListBody,
  PaymentConnectionRow,
  PaymentListBody,
  SubscriptionListBody,
} from '@/lib/api/types';

/** What a list is filtered by. Everything lives in the address bar, so a filtered list is a link. */
export interface MoneyFilters {
  readonly q: string;
  readonly status: string;
  readonly method: string;
  /** The payment account it went through (0102): a connection's id, 'none' for no account, '' for any. */
  readonly account: string;
}

export interface FilterChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * Reads the filters a Money list page was asked for. Anything unrecognised falls back to "everything", so a
 * hand-edited address never 500s.
 */
export function readFilters(
  sp: Record<string, string | string[] | undefined>,
  allowed: { status?: readonly string[]; method?: readonly string[]; account?: boolean },
): MoneyFilters {
  const one = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
  const status = one(sp.status);
  const method = one(sp.method);
  const account = one(sp.account).toLowerCase();
  return {
    q: one(sp.q).slice(0, 120),
    status: allowed.status?.includes(status) ? status : '',
    method: allowed.method?.includes(method) ? method : '',
    account:
      allowed.account && (account === 'none' || /^[0-9a-f-]{36}$/.test(account)) ? account : '',
  };
}

/** What the business calls an account, as the editors say it: "Stripe · Main shop". */
export function accountLabel(
  c: Pick<PaymentConnectionRow, 'provider' | 'label' | 'displayName' | 'environment'>,
): string {
  const provider =
    c.provider === 'stripe' ? 'Stripe' : c.provider === 'square' ? 'Square' : c.provider;
  const name = c.label ?? c.displayName;
  return `${name ? `${provider} · ${name}` : provider}${c.environment === 'live' ? '' : ' (test)'}`;
}

/** One account at the provider: a reconnect is a new row for the same account, and the lists fold them together. */
const sameAccount = (c: PaymentConnectionRow): string =>
  c.externalAccountId ? `${c.provider}:${c.environment}:${c.externalAccountId}` : c.id;

/**
 * The accounts a list can be split by (0102), the connected ones first. Only offered to a business with more
 * than one — one account has nothing to split — or while a split is already asked for, so it can be taken off.
 */
export function accountChoices(
  connections: readonly PaymentConnectionRow[],
  current: string,
): FilterChoice[] | undefined {
  const seen = new Map<string, PaymentConnectionRow>();
  const order = (c: PaymentConnectionRow) => (c.status === 'disconnected' ? 1 : 0);
  for (const c of [...connections].sort((a, b) => order(a) - order(b))) {
    const key = sameAccount(c);
    if (!seen.has(key)) seen.set(key, c);
  }
  if (seen.size < 2 && !current) return undefined;
  const accounts = [...seen.values()].map((c) => ({
    value: c.id,
    label: `${accountLabel(c)}${c.status === 'disconnected' ? ' · disconnected' : ''}`,
  }));
  // A link to an account's row from before it was reconnected still picks that account.
  if (current && current !== 'none' && !accounts.some((a) => a.value === current)) {
    const picked = connections.find((c) => c.id === current);
    accounts.push({ value: current, label: picked ? accountLabel(picked) : 'Another account' });
  }
  return [
    { value: '', label: 'Every account' },
    ...accounts,
    { value: 'none', label: 'No account' },
  ];
}

/**
 * Each connection's name, for the lists' "Paid into" column: every row, disconnected ones too, since what they
 * took stays on the books. Null for a business with one account, where the column would say the same every time.
 */
export function accountNames(
  connections: readonly PaymentConnectionRow[],
): Record<string, string> | null {
  if (new Set(connections.map(sameAccount)).size < 2) return null;
  return Object.fromEntries(connections.map((c) => [c.id, accountLabel(c)]));
}

/** The filter as the list queries take it: '' asks nothing, 'none' asks for no account. */
const accountOf = (account: string): string | null | undefined =>
  account === '' ? undefined : account === 'none' ? null : account;

export const INVOICE_STATUS_CHOICES: readonly FilterChoice[] = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Waiting to be paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'draft', label: 'Drafts' },
  { value: 'void', label: 'Voided' },
];

export const ESTIMATE_STATUS_CHOICES: readonly FilterChoice[] = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Out and unanswered' },
  { value: 'accepted', label: 'Approved' },
  { value: 'declined', label: 'Declined' },
  { value: 'expired', label: 'Expired' },
  { value: 'draft', label: 'Drafts' },
  { value: 'void', label: 'Voided' },
];

export const PAYMENT_STATUS_CHOICES: readonly FilterChoice[] = [
  { value: '', label: 'Every payment' },
  { value: 'succeeded', label: 'Collected' },
  { value: 'processing', label: 'On its way' },
  { value: 'failed', label: 'Failed' },
];

export const PAYMENT_METHOD_CHOICES: readonly FilterChoice[] = [
  { value: '', label: 'Any way' },
  { value: 'card', label: PAYMENT_METHOD_LABELS.card },
  { value: 'ach', label: PAYMENT_METHOD_LABELS.ach },
  { value: 'cash', label: PAYMENT_METHOD_LABELS.cash },
  { value: 'check', label: PAYMENT_METHOD_LABELS.check },
  { value: 'other', label: PAYMENT_METHOD_LABELS.other },
];

export const PLAN_STATUS_CHOICES: readonly FilterChoice[] = [
  { value: '', label: 'Every plan' },
  { value: 'active', label: 'Billing' },
  { value: 'past_due', label: 'Payment failed' },
  { value: 'paused', label: 'Paused' },
  { value: 'cancelled', label: 'Cancelled' },
];

/** `readFilters` only ever lets a real status through, so the narrowing below is a fact, not a hope. */
export function invoiceListBody(workspaceId: string, filters: MoneyFilters): InvoiceListBody {
  return {
    workspaceId,
    search: filters.q || undefined,
    openOnly: filters.status === 'open',
    status:
      filters.status && filters.status !== 'open'
        ? ([filters.status] as NonNullable<InvoiceListBody['status']>)
        : undefined,
    connectionId: accountOf(filters.account),
    limit: 25,
  };
}

export function estimateListBody(workspaceId: string, filters: MoneyFilters): EstimateListBody {
  return {
    workspaceId,
    search: filters.q || undefined,
    openOnly: filters.status === 'open',
    status:
      filters.status && filters.status !== 'open'
        ? ([filters.status] as NonNullable<EstimateListBody['status']>)
        : undefined,
    limit: 25,
  };
}

export function paymentListBody(workspaceId: string, filters: MoneyFilters): PaymentListBody {
  return {
    workspaceId,
    status: filters.status
      ? ([filters.status] as NonNullable<PaymentListBody['status']>)
      : undefined,
    method: filters.method
      ? ([filters.method] as NonNullable<PaymentListBody['method']>)
      : undefined,
    connectionId: accountOf(filters.account),
    limit: 25,
  };
}

export function subscriptionListBody(
  workspaceId: string,
  filters: MoneyFilters,
): SubscriptionListBody {
  return {
    workspaceId,
    status: filters.status
      ? ([filters.status] as NonNullable<SubscriptionListBody['status']>)
      : undefined,
    connectionId: accountOf(filters.account),
    limit: 100,
  };
}
