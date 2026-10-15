import { SALESCOACH_PAGE_VIEWS, type SalescoachPageView } from '@hfos/core/addons/salescoach/words';
import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { SalescoachHome } from '@/addons/salescoach/home';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI Sales Coach' };

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * AI Sales Coach's page (its manifest's `ui.nav` points here), three tabs (`?view=`): the call the coach hears now,
 * for a call on someone's cell (`live`, the bare page); coached calls, each with its write-up (`calls`, and one call
 * with `&call=`); and the playbooks (`playbooks`), which owners and admins write (`salescoach.manage`). `zoom` is
 * the panel HandsFreeOS's app opens inside a Zoom meeting (its manifest's `liveCalls.zoom`, by way of /zoom). It opens
 * through the gate: "not available here" while the add-on is off, and not found for someone without
 * `salescoach.use`. Row security keeps each coached call to its rep and whoever reviews (`salescoach.review`).
 */
export default async function SalescoachPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const asked = one(sp['view']);
  const view: SalescoachPageView = SALESCOACH_PAGE_VIEWS.includes(asked as SalescoachPageView)
    ? (asked as SalescoachPageView)
    : 'live';
  const callId = one(sp['call']);
  return addonPage(workspaceId, 'salescoach', 'salescoach.use', async () => {
    const { api } = await apiServer();
    const got = await api
      .POST('/v1/queries/workspace.get', { body: { workspaceId } })
      .then(unwrapPage);
    const can = (p: string) => got.workspace.permissions.includes(p);
    const shown =
      view === 'calls' && callId
        ? {
            view,
            call: (
              await api
                .POST('/v1/queries/salescoach.call.get', {
                  body: { workspaceId, coachedCallId: callId },
                })
                .then(unwrapPage)
            ).call,
          }
        : view === 'calls'
          ? {
              view,
              calls: (
                await api
                  .POST('/v1/queries/salescoach.call.list', { body: { workspaceId } })
                  .then(unwrapPage)
              ).calls,
            }
          : view === 'playbooks'
            ? {
                view,
                playbooks: (
                  await api
                    .POST('/v1/queries/salescoach.playbook.list', { body: { workspaceId } })
                    .then(unwrapPage)
                ).playbooks,
              }
            : { view };
    return (
      <SalescoachHome
        workspaceId={workspaceId}
        shown={shown}
        canManage={can('salescoach.manage')}
        reviews={can('salescoach.review')}
      />
    );
  });
}
