import type { Metadata } from 'next';
import { MoneyFilterBar } from '@/components/money/filters';
import { HeadlineStrip } from '@/components/money/headline-strip';
import {
  accountChoices,
  accountNames,
  PLAN_STATUS_CHOICES,
  readFilters,
  subscriptionListBody,
} from '@/components/money/list-options';
import { StartPlanDialog } from '@/components/money/plan-start';
import { PlansList } from '@/components/money/plans-list';
import { MoneyActions, MoneySubnav } from '@/components/money/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { unwrapPage } from '@/lib/api/server';
import { allowed, COLLECTED_DAYS, loadAccounts, loadMoneyShell } from '../load';

export const metadata: Metadata = { title: 'Plans' };

const STATUSES = PLAN_STATUS_CHOICES.map((s) => s.value);

/**
 * The maintenance plans a business sells and who is on them. Each row opens the plan's own page, where it is
 * paused, resumed, cancelled or pointed at another account. Someone who bills (0103) sees and starts plans for
 * the customers they're on; changing the plans themselves stays with whoever manages money.
 */
export default async function PlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const filters = readFilters(await searchParams, { status: STATUSES, account: true });
  const shell = await loadMoneyShell(workspaceId);
  const [plans, subscriptions, connections, services] = await Promise.all([
    shell.api.POST('/v1/queries/plan.list', { body: { workspaceId } }).then((r) => unwrapPage(r)),
    allowed(
      shell.api
        .POST('/v1/queries/subscription.list', {
          body: subscriptionListBody(workspaceId, filters),
        })
        .then((r) => unwrapPage(r)),
    ),
    loadAccounts(shell.api, workspaceId, shell.canBill),
    // For each plan's visits: the service it covers (Maintenance due).
    shell.api
      .POST('/v1/queries/service.list', { body: { workspaceId } })
      .then((r) => r.data?.items ?? [])
      .catch(() => []),
  ]);

  return (
    <>
      <PageHeader
        title="Money"
        description="What you have quoted, what you are owed and what has come in."
        actions={shell.canBill ? <MoneyActions workspaceId={workspaceId} /> : undefined}
      />
      {shell.summary ? (
        <HeadlineStrip summary={shell.summary} days={COLLECTED_DAYS} timeZone={shell.timeZone} />
      ) : null}
      <MoneySubnav workspaceId={workspaceId} tab="plans">
        {shell.canBill ? (
          <>
            <MoneyFilterBar
              filters={filters}
              statuses={PLAN_STATUS_CHOICES}
              accounts={accountChoices(connections, filters.account)}
              count={subscriptions?.subscriptions.length ?? 0}
            />
            <StartPlanDialog
              workspaceId={workspaceId}
              plans={plans.plans}
              connections={connections}
            />
          </>
        ) : null}
      </MoneySubnav>
      <PlansList
        workspaceId={workspaceId}
        plans={plans.plans}
        subscriptions={subscriptions?.subscriptions ?? []}
        monthlyRecurringCents={shell.summary?.monthlyRecurringCents ?? 0}
        timeZone={shell.timeZone}
        services={services.map((s) => ({ id: s.id, name: s.name }))}
        canManage={shell.canManage}
        accountNames={accountNames(connections)}
        filtered={!!(filters.status || filters.account)}
      />
    </>
  );
}
