import type { IdeaStatus } from '@hfos/core';
import { IdeasTriage } from '@/components/admin/ideas-triage';
import { TRIAGE_TABS, type TriageTab } from '@/components/admin/ideas-triage-tabs';
import { apiServer, unwrap } from '@/lib/api/server';

/** What each tab asks for. */
function whereFor(tab: TriageTab): {
  show: 'board' | 'hidden' | 'merged';
  status: IdeaStatus | 'all';
} {
  if (tab === 'hidden') return { show: 'hidden', status: 'all' };
  if (tab === 'merged') return { show: 'merged', status: 'all' };
  if (tab === 'all') return { show: 'board', status: 'all' };
  return { show: 'board', status: tab };
}

export default async function AdminIdeasPage({
  searchParams,
}: {
  searchParams: Promise<{
    show?: string;
    sort?: string;
    q?: string;
    area?: string;
    cursor?: string;
  }>;
}) {
  const sp = await searchParams;
  const tab: TriageTab = TRIAGE_TABS.some((t) => t.key === sp.show)
    ? (sp.show as TriageTab)
    : 'under_review';
  const sort = sp.sort === 'trending' || sp.sort === 'new' ? sp.sort : 'top';
  const areaId = sp.area && /^[a-z][a-z0-9_]{1,40}$/.test(sp.area) ? sp.area : null;
  const cursor = sp.cursor && /^\d{1,6}$/.test(sp.cursor) ? sp.cursor : undefined;
  const { api } = await apiServer();
  const where = whereFor(tab);
  const [data, areas, me] = await Promise.all([
    api
      .POST('/v1/queries/idea.triage', {
        body: {
          show: where.show,
          status: where.status,
          sort,
          ...(areaId ? { areaId } : {}),
          ...(sp.q ? { search: sp.q.slice(0, 200) } : {}),
          ...(cursor ? { cursor } : {}),
        },
      })
      .then(unwrap),
    api.POST('/v1/queries/idea.areas', { body: {} }).then(unwrap),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrap),
  ]);
  return (
    <IdeasTriage
      data={data}
      tab={tab}
      sort={sort}
      search={sp.q ?? ''}
      areaId={areaId}
      areas={areas.areas}
      canManage={me.staff?.permissions.includes('platform.ideas.manage') ?? false}
    />
  );
}
