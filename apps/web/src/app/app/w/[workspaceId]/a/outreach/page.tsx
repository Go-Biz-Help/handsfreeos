import { outreachSetupPath } from '@hfos/core/addons/outreach/setup';
import { redirect } from 'next/navigation';
import { forwardedHref, outreachHref } from '@/addons/outreach/address';
import { addonPage } from '@/addons/gate';
import { apiServer, unwrapPage } from '@/lib/api/server';

/**
 * Social Outreach's bare address, `/a/outreach`, which is no page of its own since its pages each have one
 * (docs/outreach.md, decision 127). An old address (`?view=waiting`, `live`, `settings&part=linkedin`…), as pushes,
 * emails, notifications, the extension and old phones still open, goes to the page its view became, with the rest
 * of its query (./address.ts, `forwardedHref`); the browser keeps a `#needs-you` on the way, which Today then
 * follows. The bare address itself opens Today, or the setup for a first-timer. It opens through the gate, as the
 * pages do.
 */
export default async function OutreachPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  return addonPage(workspaceId, 'outreach', 'outreach.use', async () => {
    const forwarded = forwardedHref(workspaceId, sp);
    if (forwarded) redirect(forwarded);
    const { api } = await apiServer();
    const setup = await api
      .POST('/v1/queries/outreach.setup', { body: { workspaceId } })
      .then(unwrapPage);
    redirect(setup.firstTime ? outreachSetupPath(workspaceId) : outreachHref(workspaceId));
  });
}
