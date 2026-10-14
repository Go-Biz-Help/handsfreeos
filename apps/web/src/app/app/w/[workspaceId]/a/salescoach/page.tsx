import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { Card } from '@/components/ui/card';

export const metadata: Metadata = { title: 'AI Sales Coach' };

/**
 * AI Sales Coach's first page (its manifest's `ui.nav` points here). It opens through the gate: "not available here"
 * while the add-on is off, and not found for someone without `salescoach.use`. Its components go in
 * apps/web/src/addons/salescoach/, which only this add-on's pages and the web's registry may import.
 */
export default async function SalescoachPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'salescoach', 'salescoach.use', () => (
    <div className="mx-auto max-w-[720px] py-8">
      <Card className="p-7">
        <h1 className="text-xl font-semibold tracking-tight">AI Sales Coach</h1>
        <p className="mt-2 text-text-2">
          Coaches your team live on calls: what to say next, answers to objections, and notes,
          follow-ups and scores after.
        </p>
      </Card>
    </div>
  ));
}
