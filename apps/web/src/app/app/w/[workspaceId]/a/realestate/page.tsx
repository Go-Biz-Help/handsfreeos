import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { Card } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Real Estate Agent' };

/**
 * Real Estate Agent's first page (its manifest's `ui.nav` points here). It opens through the gate: "not available here"
 * while the add-on is off, and not found for someone without `realestate.use`. Its components go in
 * apps/web/src/addons/realestate/, which only this add-on's pages and the web's registry may import.
 */
export default async function RealestatePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', () => (
    <div className="mx-auto max-w-[720px] py-8">
      <Card className="p-7">
        <h1 className="text-xl font-semibold tracking-tight">Real Estate Agent</h1>
        <p className="mt-2 text-text-2">
          Buyer and listing deals with every duty, deadline and proof tracked.
        </p>
      </Card>
    </div>
  ));
}
