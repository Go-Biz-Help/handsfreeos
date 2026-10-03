import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SafetyAlertPage } from '@/components/safety/safety-alert';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Safety alert' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A teammate's safety alert (round six, core): where to find someone who missed their check-out, while it's theirs to
 * answer. The push and the email to a teammate contact open it (apps/worker/src/safety/ladder.ts), and so does the
 * all-clear push; once it's answered the page says there's nothing to do.
 */
export default async function SafetyAlert({
  params,
}: {
  params: Promise<{ workspaceId: string; checkInId: string }>;
}) {
  const { workspaceId, checkInId } = await params;
  if (!UUID.test(checkInId)) notFound();
  const { api } = await apiServer();
  const [got, alert] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/safety.alert', { body: { workspaceId, checkInId } }).then(unwrapPage),
  ]);
  return (
    <SafetyAlertPage
      workspaceId={workspaceId}
      checkInId={checkInId}
      alert={alert.alert}
      timeZone={got.workspace.timezone}
    />
  );
}
