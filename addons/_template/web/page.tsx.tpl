import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { Card } from '@/components/ui/card';

export const metadata: Metadata = { title: '__NAME__' };

/**
 * __NAME__'s first page (its manifest's `ui.nav` points here). It opens through the gate: "not available here"
 * while the add-on is off, and not found for someone without `__ID__.use`. Its components go in
 * apps/web/src/addons/__ID__/, which only this add-on's pages and the web's registry may import.
 */
export default async function __PASCAL__Page({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, '__ID__', '__ID__.use', () => (
    <div className="mx-auto max-w-[720px] py-8">
      <Card className="p-7">
        <h1 className="text-xl font-semibold tracking-tight">__NAME__</h1>
        <p className="mt-2 text-text-2">__SUMMARY__</p>
      </Card>
    </div>
  ));
}
