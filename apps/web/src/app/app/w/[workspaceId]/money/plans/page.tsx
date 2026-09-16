import type { Metadata } from 'next';
import { MoneyFilterBar } from '@/components/money/filters';
import { HeadlineStrip } from '@/components/money/headline-strip';
import {
  PLAN_STATUS_CHOICES,
  readFilters,
  subscriptionListBody,
} from '@/components/money/list-options';
import { PlansList } from '@/components/money/plans-list';
import { MoneyActions, MoneySubnav } from '@/components/money/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { unwrapPage } from '@/lib/api/server';
import { allowed, COLLECTED_DAYS, loadMoneyShell } from '../load';

export const metadata: Metadata = { title: 'Plans' };

const STATUSES = PLAN_STATUS_CHOICES.map((s) => s.value);

/**
 * The maintenance plans a business sells and who is on them. Starting, pausing and cancelling a plan live on
 * the customer's own record (Milestone 9, step 13); this is the list that shows what is billing.
 */
export default async function PlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const filters = readFilters(await searchParams, { status: STATUSES });
  const shell = await loadMoneyShell(workspaceId);
  const [plans, subscriptions] = await Promise.all([
    shell.api.POST('/v1/queries/plan.list', { body: { workspaceId } }).then((r) => unwrapPage(r)),
    allowed(
      shell.api
        .POST('/v1/queries/subscription.list', {
          body: subscriptionListBody(workspaceId, filters),
        })
        .then((r) => unwrapPage(r)),
    ),
  ]);

  return (
    <>
      <PageHeader
        title="Money"
        description="What you have quoted, what you are owed and what has come in."
        actions={shell.canManage ? <MoneyActions workspaceId={workspaceId} /> : undefined}
      />
      {shell.summary ? (
        <HeadlineStrip summary={shell.summary} days={COLLECTED_DAYS} timeZone={shell.timeZone} />
      ) : null}
      <MoneySubnav workspaceId={workspaceId} tab="plans">
        {shell.canManage ? (
          <MoneyFilterBar
            filters={filters}
            statuses={PLAN_STATUS_CHOICES}
            count={subscriptions?.subscriptions.length ?? 0}
          />
        ) : null}
      </MoneySubnav>
      <PlansList
        workspaceId={workspaceId}
        plans={plans.plans}
        subscriptions={subscriptions?.subscriptions ?? []}
        monthlyRecurringCents={shell.summary?.monthlyRecurringCents ?? 0}
        timeZone={shell.timeZone}
      />
    </>
  );
}
