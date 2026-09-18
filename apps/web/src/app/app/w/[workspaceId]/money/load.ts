/**
 * What every Money page needs before it can draw anything: who is looking, the business's own settings, and
 * the three headline figures.
 *
 * Members may see the documents for the jobs they are on (`money.read`) but not the summary, the accounts or
 * the plans (`money.manage`). Rather than hide the section from them, the manage-only queries come back null
 * and each page leaves those parts out.
 */
import {
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
  readonly canManage: boolean;
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
  const canManage = seesWholeBusiness(role);
  const [settings, summary] = await Promise.all([
    canManage
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
    canManage,
    settings: settings?.settings ?? defaultMoneySettings(),
    nextEstimateNumber: settings?.nextEstimateNumber ?? 'EST-1001',
    nextInvoiceNumber: settings?.nextInvoiceNumber ?? 'INV-1001',
    summary,
    now: Date.now(),
  };
}

/** The catalogue and the accounts the editor picks from. Both are empty for someone who may not manage money. */
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
