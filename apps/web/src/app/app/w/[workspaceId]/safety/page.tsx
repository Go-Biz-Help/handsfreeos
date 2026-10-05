import type { Metadata } from 'next';
import { MySafetyPage } from '@/components/safety/my-safety';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'My safety' };

/**
 * A person's own Safety page (round six, core): their open check-in with I'm OK and +15 min, their contacts, and the
 * business's times. The "Still there?" push opens it (apps/worker/src/safety/ladder.ts). Everyone has one.
 */
export default async function MySafety({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [got, mine, times] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/safety.mine', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/safety.settings', { body: { workspaceId } }).then(unwrapPage),
  ]);
  return (
    <MySafetyPage
      workspaceId={workspaceId}
      mine={mine}
      times={times}
      timeZone={got.workspace.timezone}
    />
  );
}
