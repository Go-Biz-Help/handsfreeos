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
  PaymentListBody,
  SubscriptionListBody,
} from '@/lib/api/types';

/** What a list is filtered by. Everything lives in the address bar, so a filtered list is a link. */
export interface MoneyFilters {
  readonly q: string;
  readonly status: string;
  readonly method: string;
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
  allowed: { status?: readonly string[]; method?: readonly string[] },
): MoneyFilters {
  const one = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
  const status = one(sp.status);
  const method = one(sp.method);
  return {
    q: one(sp.q).slice(0, 120),
    status: allowed.status?.includes(status) ? status : '',
    method: allowed.method?.includes(method) ? method : '',
  };
}

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
    limit: 100,
  };
}
