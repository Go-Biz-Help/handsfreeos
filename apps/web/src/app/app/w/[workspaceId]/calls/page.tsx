import type { Metadata } from 'next';
import { CallLog } from '@/components/calls/call-log';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Calls' };

type Filter = 'all' | 'missed' | 'voicemail';
const FILTERS: readonly Filter[] = ['all', 'missed', 'voicemail'];

/**
 * The call log. A conversation shows a call where it happened, which is what you want while reading one thread
 * and no use at all when the question is "who rang this morning" — so every call is here too, newest first, with
 * its recording and what was said on it.
 */
export default async function CallsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { workspaceId } = await params;
  const { filter: raw } = await searchParams;
  const filter: Filter = FILTERS.includes(raw as Filter) ? (raw as Filter) : 'all';
  const { api } = await apiServer();
  const log = unwrapPage(await api.POST('/v1/queries/call.log', { body: { workspaceId, filter } }));
  return (
    <>
      <PageHeader
        title="Calls"
        description="Every call this business made or took, newest first. Open one for its recording and what was said."
      />
      <CallLog workspaceId={workspaceId} items={log.items} filter={filter} />
    </>
  );
}
