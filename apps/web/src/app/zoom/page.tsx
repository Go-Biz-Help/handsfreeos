import { ADDON_CATALOG } from '@hfos/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { getMe } from '@/lib/api/server';

export const metadata: Metadata = { title: 'HandsFreeOS in Zoom' };

/**
 * Where HandsFreeOS's app inside Zoom starts (the Zoom app's Home URL): round three of
 * HANDSFREEOS_SALES_COACH_IMPLEMENTATION_PLAN.md. Signed out, the proxy sends it to sign-in first (a password or an
 * emailed code both work in Zoom's browser) and back here.
 *
 * It opens the page of an add-on that hears Zoom meetings (`liveCalls.zoom` in its manifest) in a business where it
 * runs and the person holds its permission: at once when there's one, or a choice when there are several. Which
 * add-ons those are is the catalogue's to say, so nothing here names one.
 */
export default async function ZoomHomePage() {
  const me = await getMe();
  const places = me.workspaces.flatMap((w) =>
    ADDON_CATALOG.flatMap((m) => {
      const live = m.liveCalls;
      if (!live?.zoom || !w.permissions.includes(live.permission)) return [];
      const query = new URLSearchParams(live.zoom.query ?? {}).toString();
      return [
        {
          key: `${w.id}:${m.id}`,
          href: `/app/w/${w.id}/a/${m.id}${live.zoom.path}${query ? `?${query}` : ''}`,
          business: w.name,
          addon: m.name,
        },
      ];
    }),
  );
  if (places.length === 1) redirect(places[0]!.href);
  return (
    <main className="mx-auto max-w-[520px] space-y-3 p-4" data-testid="zoom-home">
      <h1 className="text-[17px] font-semibold">HandsFreeOS in Zoom</h1>
      {places.length === 0 ? (
        <Card className="space-y-2 p-4 text-[14px]">
          <p>Nothing in HandsFreeOS listens to your Zoom meetings yet.</p>
          <p className="text-[13px] text-text-2">
            An owner of your business can turn on an add-on that does, like AI Sales Coach, under
            Settings → Add-ons, and give you its permission. Then open HandsFreeOS from Zoom’s Apps
            button again.
          </p>
        </Card>
      ) : (
        <>
          <p className="text-[13.5px] text-text-2">Which business is this meeting for?</p>
          {places.map((p) => (
            <Link
              key={p.key}
              href={p.href}
              className="block rounded-control border border-border p-3 hover:bg-card-2"
            >
              <span className="block text-[14px] font-medium">{p.business}</span>
              <span className="block text-[12.5px] text-text-2">{p.addon}</span>
            </Link>
          ))}
        </>
      )}
    </main>
  );
}
