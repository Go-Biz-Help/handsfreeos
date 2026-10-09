import type { Metadata } from 'next';
import { readOutreachAddress } from '@/addons/outreach/address';
import { addonPage } from '@/addons/gate';
import { OutreachHome } from '@/addons/outreach/home';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Social Outreach' };

/**
 * Social Outreach's page (its manifest's `ui.nav` points here): the activity the browser extension noted, the
 * person's list for today (`?view=today`), the groups saved (`?view=groups`), the person's friends and the Don't pitch list (`?view=friends`), their chats as the AI read them (`?view=chats`), and
 * the business's playbooks with how each opener did (`?view=playbooks`). It
 * opens through the gate: "not available here" while the add-on is off, and not found for someone without
 * `outreach.use`. Owners and admins (`outreach.manage`) write the playbooks and see everyone's activity
 * (`?who=everyone`); anyone else asking for that sees their own.
 */
export default async function OutreachPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const shown = readOutreachAddress(await searchParams);
  return addonPage(workspaceId, 'outreach', 'outreach.use', async () => {
    const { api } = await apiServer();
    const workspace = api
      .POST('/v1/queries/workspace.get', { body: { workspaceId } })
      .then(unwrapPage);
    const activityOf = (everyone: boolean) =>
      api
        .POST('/v1/queries/outreach.activity', {
          body: { workspaceId, period: shown.period, everyone },
        })
        .then(unwrapPage);
    if (shown.view === 'today') {
      const [got, today] = await Promise.all([
        workspace,
        api.POST('/v1/queries/outreach.today', { body: { workspaceId } }).then(unwrapPage),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{ view: 'today', today }}
        />
      );
    }
    if (shown.view === 'groups') {
      const [got, groups] = await Promise.all([
        workspace,
        api
          .POST('/v1/queries/outreach.groups', {
            body: {
              workspaceId,
              view: shown.groups,
              ...(shown.search ? { search: shown.search } : {}),
              page: shown.page,
            },
          })
          .then(unwrapPage),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{ view: 'groups', groups, show: shown.groups, search: shown.search }}
        />
      );
    }
    if (shown.view === 'friends') {
      const [got, friends, tidy] = await Promise.all([
        workspace,
        api
          .POST('/v1/queries/outreach.friends', {
            body: {
              workspaceId,
              view: shown.show,
              ...(shown.search ? { search: shown.search } : {}),
              page: shown.page,
            },
          })
          .then(unwrapPage),
        api.POST('/v1/queries/outreach.friends.tidy', { body: { workspaceId } }).then(unwrapPage),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{ view: 'friends', friends, tidy, show: shown.show, search: shown.search }}
        />
      );
    }
    if (shown.view === 'chats') {
      const [got, chats] = await Promise.all([
        workspace,
        api
          .POST('/v1/queries/outreach.chats', {
            body: {
              workspaceId,
              view: shown.chats,
              ...(shown.tag ? { tag: shown.tag } : {}),
              ...(shown.search ? { search: shown.search } : {}),
              page: shown.page,
            },
          })
          .then(unwrapPage),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'chats',
            chats,
            show: shown.chats,
            tag: shown.tag,
            search: shown.search,
          }}
        />
      );
    }
    if (shown.view === 'playbooks') {
      const [got, list] = await Promise.all([
        workspace,
        api.POST('/v1/queries/outreach.playbook.list', { body: { workspaceId } }).then(unwrapPage),
      ]);
      const canManage = got.workspace.permissions.includes('outreach.manage');
      // Owners and admins see how everyone's openers did; anyone else, their own.
      const openers = await api
        .POST('/v1/queries/outreach.openers', { body: { workspaceId, everyone: canManage } })
        .then(unwrapPage);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={canManage}
          shown={{ view: 'playbooks', list, openers }}
        />
      );
    }
    // Everyone's steps only once it's known they may see them.
    const [got, own] = await Promise.all([workspace, shown.everyone ? null : activityOf(false)]);
    const canManage = got.workspace.permissions.includes('outreach.manage');
    const activity = own ?? (await activityOf(canManage));
    return (
      <OutreachHome
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        canManage={canManage}
        shown={{ view: 'activity', activity, period: shown.period }}
      />
    );
  });
}
