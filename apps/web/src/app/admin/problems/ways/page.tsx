import { problemArea } from '@hfos/core';
import { LearnedWays } from '@/components/admin/learned-ways';
import { apiServer, unwrapPage } from '@/lib/api/server';

/** The ways the AI helper learned to find a step's button in a new place (decision 142), from every business. */
export default async function LearnedWaysPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const area = problemArea((await searchParams).area);
  const { api } = await apiServer();
  const list = await api
    .POST('/v1/queries/platform.learned_way.list', { body: { area } })
    .then(unwrapPage);
  return <LearnedWays ways={list.ways} area={area} />;
}
