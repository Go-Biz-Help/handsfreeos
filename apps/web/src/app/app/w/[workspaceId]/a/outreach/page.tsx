import { ASK_KINDS_FOR } from '@hfos/core/addons/outreach/asks';
import { outreachSetupPath } from '@hfos/core/addons/outreach/setup';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { readOutreachAddress } from '@/addons/outreach/address';
import { addonPage } from '@/addons/gate';
import { OutreachHome } from '@/addons/outreach/home';
import { BOARD_STAGES, type Board } from '@/addons/outreach/board';
import type { PlaybookList } from '@/addons/outreach/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Social Outreach' };

/** Find groups' box starts with the first playbook in use's first words to search for groups: '' with none. */
function searchWordsOf(list: PlaybookList | null): string {
  const inUse = list?.playbooks.find((p) => !p.archivedAt && p.details.groupWords.length);
  return (inUse?.details.groupWords[0] ?? '').replace(/[“”"]/g, '').trim();
}

/**
 * Social Outreach's page (its manifest's `ui.nav` points here), four tabs and the gear (decision 59, ./address.ts):
 * Today (the bare page, `?view=today`, and the old `?view=waiting`), with what the person's computer is doing,
 * everything that needs them and their list; the full day of their computer and the team's for owners and admins
 * (`?view=live`); People, everyone reached by where they stand (`?view=pipeline`, a board for everyone in play),
 * their friends and the Don't pitch list (`?view=friends`) and their chats as the AI read them (`?view=chats`); the
 * groups saved (`?view=groups`); Results (`?view=results`, and the old `?view=activity`); and Settings, every setting
 * the extension follows, with anyone's for owners and admins (`?view=settings&for=`), and the business's playbooks
 * with how each opener did (`?view=playbooks`). The Today tab's label counts what needs the person. It opens through
 * the gate: "not available here" while the add-on is off, and not found for someone without `outreach.use`. Owners
 * and admins (`outreach.manage`) write the playbooks and see everyone's results (`?who=everyone`); anyone else asking
 * for that sees their own. Someone who never saved their own settings and never started Social Outreach's setup is
 * sent there from the bare page (`./setup`).
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
  const shown = readOutreachAddress(sp);
  // The bare page, as the side menu opens it: a first-timer is sent to the setup. A tab's own link never is.
  const bare = Object.keys(sp).length === 0;
  return addonPage(workspaceId, 'outreach', 'outreach.use', async () => {
    const { api } = await apiServer();
    const workspace = api
      .POST('/v1/queries/workspace.get', { body: { workspaceId } })
      .then(unwrapPage);
    // How many things need the person, on the Today tab's label: no number when it can't be had.
    // Today has the list itself.
    const waitingCount =
      shown.view === 'today'
        ? Promise.resolve(null)
        : api
            .POST('/v1/queries/outreach.waiting', { body: { workspaceId, items: false } })
            .then((r) => r.data?.count ?? null)
            .catch(() => null);
    // What the person asked their computer to do from here: each tab its own kinds, the Live tab all of them.
    const asksOf = (tab?: keyof typeof ASK_KINDS_FOR) =>
      api
        .POST('/v1/queries/outreach.asks', {
          body: { workspaceId, ...(tab ? { kinds: [...ASK_KINDS_FOR[tab]] } : {}) },
        })
        .then(unwrapPage);
    // What the person's computer is doing: Today's strip, and Settings' computers. Left out when it can't be had.
    const liveOf = () =>
      api
        .POST('/v1/queries/outreach.live', { body: { workspaceId } })
        .then((r) => r.data ?? null)
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
      const [me, people, business, live, setup] = await Promise.all([
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
        whose ? null : liveOf(),
        // Where the team gets the extension: the business's own link, read as everyone reads it.
        api
          .POST('/v1/queries/outreach.setup', { body: { workspaceId } })
          .then((r) => r.data ?? null)
          .catch(() => null),
      ]);
      const canStartFresh = got.workspace.permissions.includes('addons.purge');
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={canManage}
          canStartFresh={canStartFresh}
          shown={{
            view: 'settings',
            me,
            mine: !whose,
            people,
            business: business?.settings ?? null,
            canStartFresh,
            live,
            extensionLink: setup?.extensionLink ?? null,
          }}
        />
      );
    }
    if (shown.view === 'live') {
      const [got, live, asks] = await Promise.all([
        workspace,
        api.POST('/v1/queries/outreach.live', { body: { workspaceId } }).then(unwrapPage),
        asksOf(),
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
          shown={{ view: 'live', live, team, asks }}
        />
      );
    }
    if (shown.view === 'pipeline') {
      const stageOf = (view: (typeof BOARD_STAGES)[number] | typeof shown.stages) =>
        api
          .POST('/v1/queries/outreach.stages', {
            body: {
              workspaceId,
              view,
              ...(shown.search ? { search: shown.search } : {}),
              page: view === shown.stages ? shown.page : 1,
            },
          })
          .then(unwrapPage);
      // Everyone in play is a board: each column's first page, asked one stage at a time.
      const onBoard = shown.stages === 'all' && !shown.search && shown.page === 1;
      const [got, pipeline, columns, asks] = await Promise.all([
        workspace,
        stageOf(shown.stages),
        onBoard ? Promise.all(BOARD_STAGES.map((stage) => stageOf(stage))) : null,
        // Research on the rows: left out (the buttons wait) when it can't be had.
        asksOf('pipeline').catch(() => null),
      ]);
      const board = columns
        ? (Object.fromEntries(BOARD_STAGES.map((stage, i) => [stage, columns[i]!])) as Board)
        : null;
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'pipeline',
            pipeline,
            board,
            show: shown.stages,
            search: shown.search,
            asks,
          }}
        />
      );
    }
    if (shown.view === 'groups') {
      const [got, groups, asks, playbooks] = await Promise.all([
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
        asksOf('groups'),
        // Find groups starts from the first playbook in use's words to search for groups.
        api
          .POST('/v1/queries/outreach.playbook.list', { body: { workspaceId } })
          .then((r) => r.data ?? null)
          .catch(() => null),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'groups',
            groups,
            show: shown.groups,
            search: shown.search,
            asks,
            searchWords: searchWordsOf(playbooks),
          }}
        />
      );
    }
    if (shown.view === 'friends') {
      const [got, friends, tidy, asks] = await Promise.all([
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
        asksOf('friends'),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'friends',
            friends,
            tidy,
            show: shown.show,
            search: shown.search,
            asks,
          }}
        />
      );
    }
    if (shown.view === 'chats') {
      const [got, chats, asks] = await Promise.all([
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
        asksOf('chats'),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'chats',
            asks,
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
    if (shown.view === 'results') {
      // The three numbers (decision 70): left out when they can't be had, so the rest still shows.
      const trackingOf = (everyone: boolean) =>
        api
          .POST('/v1/queries/outreach.tracking', {
            body: { workspaceId, period: shown.period, everyone },
          })
          .then((r) => r.data ?? null)
          .catch(() => null);
      // Everyone's steps only once it's known they may see them.
      const [got, own, ownNumbers] = await Promise.all([
        workspace,
        shown.everyone ? null : activityOf(false),
        shown.everyone ? null : trackingOf(false),
      ]);
      const canManage = got.workspace.permissions.includes('outreach.manage');
      const [activity, tracking] = own
        ? [own, ownNumbers]
        : await Promise.all([activityOf(canManage), trackingOf(canManage)]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          waitingCount={await waitingCount}
          businessName={got.workspace.name}
          canManage={canManage}
          shown={{ view: 'results', activity, tracking, period: shown.period }}
        />
      );
    }
    // Today, the bare page's: a first-timer is sent to the setup first.
    const [got, setup, today, helpful, asks, live, waiting] = await Promise.all([
      workspace,
      bare
        ? api.POST('/v1/queries/outreach.setup', { body: { workspaceId } }).then(unwrapPage)
        : null,
      api.POST('/v1/queries/outreach.today', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/outreach.helpful', { body: { workspaceId } }).then(unwrapPage),
      asksOf('today'),
      liveOf(),
      api
        .POST('/v1/queries/outreach.waiting', { body: { workspaceId, items: true } })
        .then((r) => r.data ?? null)
        .catch(() => null),
    ]);
    if (setup?.firstTime) redirect(outreachSetupPath(workspaceId));
    const canManage = got.workspace.permissions.includes('outreach.manage');
    // Owners and admins see who's on training wheels, to end them early; until the person is ready, Get ready shows
    // in place of the day's list (decision 63).
    const [wheels, readiness] = await Promise.all([
      canManage
        ? api.POST('/v1/queries/outreach.wheels', { body: { workspaceId } }).then(unwrapPage)
        : null,
      today.ready
        ? null
        : api.POST('/v1/queries/outreach.readiness', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <OutreachHome
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        canManage={canManage}
        shown={{ view: 'today', today, helpful, wheels, asks, live, waiting, readiness }}
      />
    );
  });
}
