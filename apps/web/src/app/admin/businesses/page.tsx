import { deskBusinessSort } from '@hfos/core';
import { Businesses, type BusinessRow } from '@/components/admin/businesses';
import { apiServer, unwrap } from '@/lib/api/server';

export default async function BusinessesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; cursor?: string }>;
}) {
  const { q, sort, cursor } = await searchParams;
  const { api } = await apiServer();
  const [list, me] = await Promise.all([
    api
      .POST('/v1/queries/platform.business.list', {
        body: {
          ...(q ? { search: q } : {}),
          // The orders the page offers; anything else in the address is read as the default.
          sort: deskBusinessSort(sort),
          ...(cursor ? { cursor } : {}),
          limit: 25,
        },
      })
      .then(unwrap),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrap),
  ]);
  return (
    <Businesses
      businesses={list.businesses as unknown as BusinessRow[]}
      totals={list.totals}
      sort={sort ?? 'newest'}
      search={q ?? ''}
      nextCursor={list.nextCursor}
      staff={{
        canViewAs: me.staff?.permissions.includes('platform.view_as') ?? false,
        founder: me.staff?.founder ?? false,
      }}
    />
  );
}
