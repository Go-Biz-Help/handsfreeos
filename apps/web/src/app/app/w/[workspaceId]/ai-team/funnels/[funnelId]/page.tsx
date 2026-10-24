import type { Metadata } from 'next';
import { FunnelBuilder } from '@/components/funnels/builder';
import { FUNNEL_STEPS, type FunnelStepKey } from '@/lib/funnels/steps';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Funnel' };

/** A funnel's steps and its live map (`?step=` opens a step: who, stages, messages…). */
export default async function FunnelPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; funnelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, funnelId } = await params;
  const asked = (await searchParams).step;
  const { api } = await apiServer();
  const [funnel, teammate] = await Promise.all([
    api.POST('/v1/queries/funnel.get', { body: { workspaceId, funnelId } }),
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
  ]);
  const got = unwrapPage(funnel);
  const t = unwrapPage(teammate);
  const step = FUNNEL_STEPS.find((s) => s.key === asked)?.key;
  return (
    <FunnelBuilder
      workspaceId={workspaceId}
      initial={got}
      initialStep={
        (step ?? (got.funnel.status === 'draft' ? 'describe' : 'stages')) as FunnelStepKey
      }
      teammateName={t.teammate?.name ?? 'The AI teammate'}
      canManage={t.canManage}
    />
  );
}
