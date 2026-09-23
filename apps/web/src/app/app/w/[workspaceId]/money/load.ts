/**
 * What every Money page needs before it can draw anything: who is looking, the business's own settings, and
 * the three headline figures.
 *
 * What someone may do here is what the business lets them (0103). Seeing bills (`money.read`) shows the documents
 * for the jobs they are on; billing (`money.bill`) lets them write, send and void those, record a payment by hand
 * and start plans, into the accounts they may use; managing money (`money.manage`) is every bill, the summary,
 * refunds and the settings. Rather than hide the section, a query they may not run comes back null and each page
 * leaves those parts out.
 */
import {
  canBill,
  COLLECTED_DAYS,
  defaultMoneySettings,
  seesWholeBusiness,
  type MoneySettings,
} from '@hfos/core';
import type { ApiClient } from '@hfos/api-client';
import { ApiError, apiServer, unwrapPage } from '@/lib/api/server';
import type { MoneySummaryOut, PaymentConnectionRow, ProductRow } from '@/lib/api/types';

export interface MoneyShell {
  readonly api: ApiClient;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly timeZone: string;
  readonly role: 'owner' | 'admin' | 'member';
  /** What the business lets them do (0103). */
  readonly permissions: readonly string[];
  /** Every bill in the business, the summary, refunds and settings. */
  readonly canManage: boolean;
  /** Write, send and void bills and start plans for the customers they're on (everything, for a manager). */
  readonly canBill: boolean;
  readonly settings: MoneySettings;
  readonly nextEstimateNumber: string;
  readonly nextInvoiceNumber: string;
  readonly summary: MoneySummaryOut | null;
  readonly now: number;
}

export { COLLECTED_DAYS };

/** A query a member is not allowed to run comes back null instead of blowing the page up. */
export async function allowed<T>(run: Promise<T>): Promise<T | null> {
  try {
    return await run;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.code === 'forbidden')) return null;
    throw e;
  }
}

export async function loadMoneyShell(workspaceId: string): Promise<MoneyShell> {
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const role = got.workspace.role;
  const permissions = got.workspace.permissions;
  const canManage = seesWholeBusiness(permissions);
  const billing = canBill(permissions);
  const [settings, summary] = await Promise.all([
    // The numbers the next documents take, and how the business bills, are for anyone who writes them.
    billing
      ? allowed(
          api
            .POST('/v1/queries/money.settings', { body: { workspaceId } })
            .then((r) => unwrapPage(r)),
        )
      : Promise.resolve(null),
    canManage
      ? allowed(
          api
            .POST('/v1/queries/money.summary', {
              body: { workspaceId, days: COLLECTED_DAYS },
            })
            .then((r) => unwrapPage(r)),
        )
      : Promise.resolve(null),
  ]);
  return {
    api,
    workspaceId,
    workspaceName: got.workspace.name,
    timeZone: got.workspace.timezone,
    role,
    permissions,
    canManage,
    canBill: billing,
    settings: settings?.settings ?? defaultMoneySettings(),
    nextEstimateNumber: settings?.nextEstimateNumber ?? 'EST-1001',
    nextInvoiceNumber: settings?.nextInvoiceNumber ?? 'INV-1001',
    summary,
    now: Date.now(),
  };
}

/**
 * Every account the business has had, disconnected ones too — what they took stays on the books — for splitting
 * the lists by account (0102). Someone who bills sees the accounts they may use; empty for anyone else.
 */
export async function loadAccounts(
  api: ApiClient,
  workspaceId: string,
  canBill: boolean,
): Promise<PaymentConnectionRow[]> {
  if (!canBill) return [];
  const got = await allowed(
    api
      .POST('/v1/queries/payment_connection.list', {
        body: { workspaceId, includeDisconnected: true },
      })
      .then((r) => unwrapPage(r)),
  );
  return got?.connections ?? [];
}

/** The catalogue and the accounts the editor picks from: the accounts are the ones they may use. */
export async function loadEditorCatalogs(
  api: ApiClient,
  workspaceId: string,
): Promise<{ products: ProductRow[]; connections: PaymentConnectionRow[] }> {
  const [products, connections] = await Promise.all([
    allowed(
      api.POST('/v1/queries/product.list', { body: { workspaceId } }).then((r) => unwrapPage(r)),
    ),
    allowed(
      api
        .POST('/v1/queries/payment_connection.list', { body: { workspaceId } })
        .then((r) => unwrapPage(r)),
    ),
  ]);
  return {
    products: products?.products ?? [],
    connections: (connections?.connections ?? []).filter((c) => c.status !== 'disconnected'),
  };
}
