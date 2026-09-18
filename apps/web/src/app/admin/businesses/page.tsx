import { Businesses, type BusinessRow } from '@/components/admin/businesses';
import { apiServer, unwrap } from '@/lib/api/server';

/** The orders the page offers; anything else in the address is read as the default. */
const SORTS = ['newest', 'busiest', 'quietest', 'name'] as const;
type Sort = (typeof SORTS)[number];

export default async function BusinessesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; cursor?: string }>;
}) {
  const { q, sort, cursor } = await searchParams;
  const { api } = await apiServer();
  const list = unwrap(
    await api.POST('/v1/queries/platform.business.list', {
      body: {
        ...(q ? { search: q } : {}),
        sort: SORTS.includes(sort as Sort) ? (sort as Sort) : 'newest',
        ...(cursor ? { cursor } : {}),
        limit: 25,
      },
    }),
  );
  return (
    <Businesses
      businesses={list.businesses as unknown as BusinessRow[]}
      totals={list.totals}
      sort={sort ?? 'newest'}
      search={q ?? ''}
      nextCursor={list.nextCursor}
    />
  );
}
