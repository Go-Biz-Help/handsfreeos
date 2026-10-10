import type { Metadata } from 'next';
import { readOutreachAddress } from '@/addons/outreach/address';
import { addonPage } from '@/addons/gate';
import { OutreachHome } from '@/addons/outreach/home';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Social Outreach' };

/**
 * Social Outreach's page (its manifest's `ui.nav` points here): the activity the browser extension noted, what it's
 * doing right now with the person's day, and the team's for owners and admins (`?view=live`), everything waiting for
 * the person (`?view=waiting`, whose count every tab shows on its label), the
 * person's list for today (`?view=today`), the groups saved (`?view=groups`), the person's friends and the Don't pitch list (`?view=friends`), their chats as the AI read them (`?view=chats`), and
 * the business's playbooks with how each opener did (`?view=playbooks`), and every setting the extension follows, with
 * anyone's for owners and admins (`?view=settings&for=`). It
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
    // How many things wait for the person, on the Waiting for you tab's label: no number when it can't be had.
    const waitingCount = api
      .POST('/v1/queries/outreach.waiting', { body: { workspaceId, items: false } })
      .then((r) => r.data?.count ?? null)
      .catch(() => null);
    const activityOf = (everyone: boolean) =>
      api
        .POST('/v1/queries/outreach.activity', {
          body: { workspaceId, period: shown.period, everyone },
        })
        .then(unwrapPage);
    if (shown.view === 'settings') {
      const got = await workspace;
      const canManage = got.workspace.permissions.includes('outreach.manage');
      // Someone else's, for owners and admins; anyone else asking sees their own.
      const whose = canManage && shown.for ? shown.for : undefined;
      const [me, people, business] = await Promise.all([
        api
          .POST('/v1/queries/outreach.automation', {
            body: { workspaceId, ...(whose ? { userId: whose } : {}) },
          })
          .then(unwrapPage),
        canManage
          ? api
              .POST('/v1/queries/outreach.automation.people', { body: { workspaceId } })
              .then(unwrapPage)
          : null,
        canManage
          ? api
              .POST('/v1/queries/addon.settings', { body: { workspaceId, addonId: 'outreach' } })
              .then(unwrapPage)
          : null,
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={canManage}
          shown={{
            view: 'settings',
            me,
            mine: !whose,
            people,
            business: business?.settings ?? null,
          }}
        />
      );
    }
    if (shown.view === 'live') {
      const [got, live] = await Promise.all([
        workspace,
        api.POST('/v1/queries/outreach.live', { body: { workspaceId } }).then(unwrapPage),
      ]);
      const canManage = got.workspace.permissions.includes('outreach.manage');
      // Owners and admins see how each person's extension is doing: never their lines or messages.
      const team = canManage
        ? await api
            .POST('/v1/queries/outreach.live.team', { body: { workspaceId } })
            .then(unwrapPage)
        : null;
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={canManage}
          shown={{ view: 'live', live, team }}
        />
      );
    }
    if (shown.view === 'waiting') {
      const [got, waiting] = await Promise.all([
        workspace,
        api
          .POST('/v1/queries/outreach.waiting', { body: { workspaceId, items: true } })
          .then(unwrapPage),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{ view: 'waiting', waiting }}
        />
      );
    }
    if (shown.view === 'today') {
      const [got, today] = await Promise.all([
        workspace,
        api.POST('/v1/queries/outreach.today', { body: { workspaceId } }).then(unwrapPage),
      ]);
      const canManage = got.workspace.permissions.includes('outreach.manage');
      // Owners and admins see who's on training wheels, to end them early.
      const wheels = canManage
        ? await api.POST('/v1/queries/outreach.wheels', { body: { workspaceId } }).then(unwrapPage)
        : null;
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={canManage}
          shown={{ view: 'today', today, wheels }}
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
          waitingCount={await waitingCount}
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
          waitingCount={await waitingCount}
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
          waitingCount={await waitingCount}
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
          waitingCount={await waitingCount}
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
        waitingCount={await waitingCount}
        businessName={got.workspace.name}
        canManage={canManage}
        shown={{ view: 'activity', activity, period: shown.period }}
      />
    );
  });
}
