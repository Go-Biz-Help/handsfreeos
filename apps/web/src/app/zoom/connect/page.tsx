import { ADDON_CATALOG } from '@hfos/core';
import type { Metadata } from 'next';
import { Card } from '@/components/ui/card';
import { getMe } from '@/lib/api/server';
import { ZoomConnect } from './zoom-connect';

export const metadata: Metadata = { title: 'Connect Zoom' };

/**
 * The last step of adding HandsFreeOS's coaching app to Zoom: Zoom's sign-in said who the Zoom user is (sealed in
 * `?t=`, by the worker's /oauth/zoom-live/callback), and this, signed in to HandsFreeOS (the proxy asks first),
 * says who they are here and in which business. Confirming links the two (`/v1/zoom-live/link` on the worker), which
 * is how HandsFreeOS knows that Zoom user is an active person here. Reached from Zoom's Marketplace (Add) or from
 * Connect Zoom in HandsFreeOS.
 */
export default async function ZoomConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { t } = await searchParams;
  const me = await getMe();
  const listens = (permissions: readonly string[]) =>
    ADDON_CATALOG.some((m) => m.liveCalls?.zoom && permissions.includes(m.liveCalls.permission));
  // The businesses where something would coach them in Zoom, first; any of theirs if none does yet.
  const coached = me.workspaces.filter((w) => listens(w.permissions));
  const places = (coached.length ? coached : me.workspaces).map((w) => ({
    id: w.id,
    name: w.name,
  }));
  return (
    <main className="mx-auto max-w-[520px] space-y-3 p-4" data-testid="zoom-connect">
      <h1 className="text-[17px] font-semibold">Connect Zoom to HandsFreeOS</h1>
      {typeof t !== 'string' || !t ? (
        <Card className="p-4 text-[14px]">
          This link is missing its Zoom sign-in. Add the HandsFreeOS Sales Coach app from Zoom’s App
          Marketplace again, or press Connect Zoom in Settings → My calendar.
        </Card>
      ) : places.length === 0 ? (
        <Card className="p-4 text-[14px]">
          You’re not in a business on HandsFreeOS yet. Create one, or ask its owner to invite you,
          then add the app again.
        </Card>
      ) : (
        <ZoomConnect ticket={t} places={places} nobodyCoaches={coached.length === 0} />
      )}
    </main>
  );
}
