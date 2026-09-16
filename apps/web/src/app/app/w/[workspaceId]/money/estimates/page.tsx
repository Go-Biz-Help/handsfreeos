import type { Metadata } from 'next';
import { EstimatesList } from '@/components/money/estimates-list';
import { MoneyFilterBar } from '@/components/money/filters';
import {
  ESTIMATE_STATUS_CHOICES,
  estimateListBody,
  readFilters,
} from '@/components/money/list-options';
import { HeadlineStrip } from '@/components/money/headline-strip';
import { MoneyActions, MoneySubnav } from '@/components/money/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { unwrapPage } from '@/lib/api/server';
import { COLLECTED_DAYS, loadMoneyShell } from '../load';

export const metadata: Metadata = { title: 'Estimates' };

const STATUSES = ESTIMATE_STATUS_CHOICES.map((s) => s.value);

export default async function EstimatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const filters = readFilters(await searchParams, { status: STATUSES });
  const shell = await loadMoneyShell(workspaceId);
  const estimates = unwrapPage(
    await shell.api.POST('/v1/queries/estimate.list', {
      body: estimateListBody(workspaceId, filters),
    }),
  );

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
      <MoneySubnav workspaceId={workspaceId} tab="estimates">
        <MoneyFilterBar
          filters={filters}
          statuses={ESTIMATE_STATUS_CHOICES}
          searchLabel="Search estimates"
          count={estimates.estimates.length}
        />
      </MoneySubnav>
      <EstimatesList
        workspaceId={workspaceId}
        initial={estimates}
        filters={filters}
        canManage={shell.canManage}
        timeZone={shell.timeZone}
        now={shell.now}
        goodForDays={shell.settings.estimateGoodForDays}
      />
    </>
  );
}
