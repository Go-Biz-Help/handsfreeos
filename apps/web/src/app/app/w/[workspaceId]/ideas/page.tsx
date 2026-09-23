import { IDEA_STATUSES } from '@hfos/core';
import type { Metadata } from 'next';
import {
  IdeasBoard,
  type BoardFilters,
  type BoardMine,
  type BoardSort,
  type BoardStatus,
} from '@/components/ideas/ideas-board';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Ideas' };

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** What the address asks for, with anything it does not know read as the default. */
function filtersOf(sp: Record<string, string | string[] | undefined>): BoardFilters {
  const sort = one(sp.sort);
  const status = one(sp.status);
  const mine = one(sp.mine);
  const area = one(sp.area);
  return {
    sort: sort === 'top' || sort === 'new' ? (sort as BoardSort) : 'trending',
    status:
      status === 'all' || (IDEA_STATUSES as readonly string[]).includes(status ?? '')
        ? (status as BoardStatus)
        : 'open',
    areaId: area && /^[a-z][a-z0-9_]{1,40}$/.test(area) ? area : null,
    search: (one(sp.q) ?? '').slice(0, 200),
    mine:
      mine === 'shared' || mine === 'voted' || mine === 'following' ? (mine as BoardMine) : null,
  };
}

export default async function IdeasPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const filters = filtersOf(await searchParams);
  const { api } = await apiServer();
  const [list, areas] = await Promise.all([
    api
      .POST('/v1/queries/idea.list', {
        body: {
          sort: filters.sort,
          status: filters.status,
          ...(filters.areaId ? { areaId: filters.areaId } : {}),
          ...(filters.search ? { search: filters.search } : {}),
          ...(filters.mine ? { mine: filters.mine } : {}),
        },
      })
      .then(unwrapPage),
    api.POST('/v1/queries/idea.areas', { body: {} }).then(unwrapPage),
  ]);
  return (
    <IdeasBoard
      // A new set of filters is a new list: what "Show more" added to the old one goes with it.
      key={JSON.stringify(filters)}
      workspaceId={workspaceId}
      ideas={list.ideas}
      nextCursor={list.nextCursor}
      areas={areas.areas}
      filters={filters}
    />
  );
}
