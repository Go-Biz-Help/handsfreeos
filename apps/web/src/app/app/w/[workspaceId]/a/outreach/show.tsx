import { ASK_KINDS_FOR } from '@hfos/core/addons/outreach/asks';
import { networkShown, networksShown } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { notReadyWords } from '@hfos/core/addons/outreach/readiness';
import { isNetworkPart } from '@hfos/core/addons/outreach/settings-parts';
import { outreachSetupPath } from '@hfos/core/addons/outreach/setup';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { netCookie, readOutreachAddress, type OutreachView } from '@/addons/outreach/address';
import { addonPage } from '@/addons/gate';
import { OutreachHome } from '@/addons/outreach/home';
import { BOARD_STAGES, type Board } from '@/addons/outreach/board';
import type { PlaybookList } from '@/addons/outreach/types';
import { apiServer, errorMessage, unwrap, unwrapPage } from '@/lib/api/server';

/** What a page's route hands on: its business, its query, and Settings' part from its path. */
export interface OutreachPageProps {
  readonly params: Promise<{ workspaceId: string; part?: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Find groups' box starts with the first playbook in use's first words to search for groups: '' with none. */
function searchWordsOf(list: PlaybookList | null): string {
  const inUse = list?.playbooks.find((p) => !p.archivedAt && p.details.groupWords.length);
  return (inUse?.details.groupWords[0] ?? '').replace(/[“”"]/g, '').trim();
}

/**
 * Social Outreach's pages (docs/outreach.md, decision 126), each its own route under `/a/outreach/` and one of the
 * side menu's pages (the manifest's `ui.nav`), drawn by `OutreachHome` (./address.ts says what each address shows):
 * **Needs you**, everything waiting on the person; **Today**, what their computer is doing on each network, with Start
 * my day and Stop for today, its feed and, for owners and admins, the team's, and the network shown's list (`?net=`,
 * else the one picked last, else the first); **People**, everyone reached by where they stand (a board for everyone
 * in play), their friends and the Don't pitch list, their chats as the AI read them and their Partners list (decision
 * 81); **Groups**; **Results**; **Playbooks**, with how each opener did; and **Settings**, every setting the extension
 * follows, a page for each part (`/settings/<part>`, decision 73), with anyone's for owners and admins (`?for=`). Each
 * opens through the gate: "not available here" while the add-on is off, and not found for someone without
 * `outreach.use`. Owners and admins (`outreach.manage`) write the playbooks and see everyone's results
 * (`?who=everyone`); anyone else asking for that sees their own. Someone who never saved their own settings and never
 * started Social Outreach's setup is sent there from Today with nothing in its address, as the side menu opens it
 * (`./setup`).
 *
 * Each network the person works has its own day, list and lists first (Chris: each network on its own): Today asks
 * for each one's live view, for its card, and for the list of the one shown. People's lists are every network's, each
 * row naming its own, or one network's.
 */
export async function showOutreach(
  view: OutreachView,
  { params, searchParams }: OutreachPageProps,
) {
  const { workspaceId, part } = await params;
  const sp = await searchParams;
  const remembered = (await cookies()).get(netCookie(workspaceId))?.value ?? null;
  const shown = readOutreachAddress(view, sp, { part, remembered });
  // Today with nothing in its address, as the side menu opens it: a first-timer is sent to the setup.
  const bare = Object.keys(sp).length === 0;
  return addonPage(workspaceId, 'outreach', 'outreach.use', async () => {
    const { api } = await apiServer();
    const workspace = api
      .POST('/v1/queries/workspace.get', { body: { workspaceId } })
      .then(unwrapPage);
    // What the person asked their computer to do from here: each page its own kinds, Your computer all of them.
    const asksOf = (tab?: keyof typeof ASK_KINDS_FOR) =>
      api
        .POST('/v1/queries/outreach.asks', {
          body: { workspaceId, ...(tab ? { kinds: [...ASK_KINDS_FOR[tab]] } : {}) },
        })
        .then(unwrapPage);
    // What the person's computer is doing, and their day on a network: Today's cards, and Settings' Your computer. Left
    // out when it can't be had.
    const liveOf = (platform?: Platform) =>
      api
        .POST('/v1/queries/outreach.live', {
          body: { workspaceId, ...(platform ? { platform } : {}) },
        })
        .then((r) => r.data ?? null)
        .catch(() => null);
    // A list narrowed to one network, when the address names one.
    const onNetwork = shown.net ? { platform: shown.net } : {};
    const activityOf = (everyone: boolean) =>
      api
        .POST('/v1/queries/outreach.activity', {
          body: { workspaceId, period: shown.period, everyone },
        })
        .then(unwrapPage);
    if (shown.view === 'needs') {
      // Everything waiting on the person, on every network: never narrowed, so nothing that needs them is hidden.
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
          shown={{ view: 'needs', waiting }}
        />
      );
    }
    if (shown.view === 'settings') {
      const got = await workspace;
      const canManage = got.workspace.permissions.includes('outreach.manage');
      // Someone else's, for owners and admins; anyone else asking sees their own.
      const whose = canManage && shown.for ? shown.for : undefined;
      // Only Your computer shows the person's computers and the extension's download.
      const computer = shown.part === 'computer' && !whose;
      // A network's page asks the person's own computer to check it (decision 74), and says what to press when
      // Chrome hasn't let the extension on it. It has their profile there too, read and checked (decision 80).
      const network = isNetworkPart(shown.part) && !whose ? shown.part : null;
      const [me, people, business, live, setup, asks, readiness] = await Promise.all([
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
        computer ? liveOf() : null,
        // Where the team gets the extension: the business's own link, read as everyone reads it.
        computer
          ? api
              .POST('/v1/queries/outreach.setup', { body: { workspaceId } })
              .then((r) => r.data ?? null)
              .catch(() => null)
          : null,
        // A network's own asks there; on Your computer, everything asked of it (decision 126: it was Today's Details).
        network || computer
          ? api
              .POST('/v1/queries/outreach.asks', {
                body: { workspaceId, ...(network ? { kinds: [...ASK_KINDS_FOR.settings] } : {}) },
              })
              .then((r) => r.data ?? null)
              .catch(() => null)
          : null,
        network
          ? api
              .POST('/v1/queries/outreach.readiness', { body: { workspaceId, platform: network } })
              .then((r) => r.data ?? null)
              .catch(() => null)
          : null,
      ]);
      const canStartFresh = got.workspace.permissions.includes('addons.purge');
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={canManage}
          canStartFresh={canStartFresh}
          shown={{
            view: 'settings',
            part: shown.part,
            me,
            mine: !whose,
            people,
            business: business?.settings ?? null,
            canStartFresh,
            live,
            extensionLink: setup?.extensionLink ?? null,
            asks,
            readiness,
          }}
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
              ...onNetwork,
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
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'pipeline',
            pipeline,
            board,
            show: shown.stages,
            search: shown.search,
            net: shown.net,
            asks,
          }}
        />
      );
    }
    if (shown.view === 'groups' && shown.group) {
      // A group's own page (decision 103): a group no longer kept says so, with the way back, not a 404.
      const [got, people] = await Promise.all([
        workspace,
        api
          .POST('/v1/queries/outreach.group.people', {
            body: { workspaceId, groupId: shown.group, view: shown.outcome, page: shown.page },
          })
          .then((r) => ({ people: unwrap(r), problem: null }))
          .catch((e: unknown) => ({ people: null, problem: errorMessage(e) })),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'group',
            groupId: shown.group,
            people: people.people,
            problem: people.problem,
            outcome: shown.outcome,
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
              ...onNetwork,
            },
          })
          .then(unwrapPage),
        // Tidying up on the network narrowed to, Facebook's when none: each network's limits are its own.
        api
          .POST('/v1/queries/outreach.friends.tidy', { body: { workspaceId, ...onNetwork } })
          .then(unwrapPage),
        asksOf('friends'),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'friends',
            friends,
            tidy,
            show: shown.show,
            search: shown.search,
            net: shown.net,
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
              ...onNetwork,
            },
          })
          .then(unwrapPage),
        asksOf('chats'),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'chats',
            asks,
            chats,
            show: shown.chats,
            tag: shown.tag,
            search: shown.search,
            net: shown.net,
          }}
        />
      );
    }
    if (shown.view === 'partners') {
      const [got, partners] = await Promise.all([
        workspace,
        api
          .POST('/v1/queries/outreach.partners', {
            body: { workspaceId, view: shown.partners, page: shown.page, ...onNetwork },
          })
          .then(unwrapPage),
      ]);
      return (
        <OutreachHome
          workspaceId={workspaceId}
          businessName={got.workspace.name}
          canManage={got.workspace.permissions.includes('outreach.manage')}
          shown={{
            view: 'partners',
            partners,
            show: shown.partners,
            net: shown.net,
            page: shown.page,
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
          businessName={got.workspace.name}
          canManage={canManage}
          shown={{ view: 'results', activity, tracking, period: shown.period }}
        />
      );
    }
    // Today. Opened from the side menu, with nothing in its address, a first-timer is sent to the setup first.
    const [got, setup, mine, asks, waiting] = await Promise.all([
      workspace,
      bare
        ? api.POST('/v1/queries/outreach.setup', { body: { workspaceId } }).then(unwrapPage)
        : null,
      // The networks the person works, for their cards and the list shown: Facebook's alone when they can't be had.
      api
        .POST('/v1/queries/outreach.automation', { body: { workspaceId } })
        .then((r) => r.data ?? null)
        .catch(() => null),
      asksOf('today'),
      // What needs the person: its count leads to Needs you, and a message waiting there stays off the list here.
      api
        .POST('/v1/queries/outreach.waiting', { body: { workspaceId, items: true } })
        .then((r) => r.data ?? null)
        .catch(() => null),
    ]);
    if (setup?.firstTime) redirect(outreachSetupPath(workspaceId));
    const nets: readonly Platform[] = mine
      ? networksShown(mine.settings, mine.rules.networksAllowed)
      : ['facebook'];
    const net = networkShown(nets, shown.net);
    // Get ready on each network: whether the person is ready there, and what holds its day, said beside its Start my
    // day (its own playbook counts; the profile never does, decision 90). The network shown's is the Get ready card's,
    // while anything is left on it, the profile's advice among them.
    const readinessOf = (platform: Platform) =>
      api
        .POST('/v1/queries/outreach.readiness', { body: { workspaceId, platform } })
        .then((r) => r.data ?? null)
        .catch(() => null);
    const [today, lives, helpful, readies] = await Promise.all([
      api
        .POST('/v1/queries/outreach.today', { body: { workspaceId, platform: net } })
        .then(unwrapPage),
      Promise.all(nets.map((p) => liveOf(p))),
      // The helpful post on the network shown: in a group on Facebook, on the person's own feed on LinkedIn.
      api
        .POST('/v1/queries/outreach.helpful', { body: { workspaceId, platform: net } })
        .then(unwrapPage),
      Promise.all(nets.map((p) => readinessOf(p))),
    ]);
    const networks = nets.flatMap((platform, i) => {
      const live = lives[i];
      const r = readies[i] ?? null;
      const ready = platform === net ? today.ready : r?.ready;
      return live
        ? [{ platform, live, ready, held: ready === false && r ? notReadyWords(r) : null }]
        : [];
    });
    const canManage = got.workspace.permissions.includes('outreach.manage');
    // Owners and admins see who's on training wheels, to end them early, and how each person's extension is doing on
    // the network shown, never their lines or messages. Until the person is ready on the network shown, its Get ready
    // shows in place of the day's list (decision 63); once they are, it shows only while the profile there is left, as
    // advice beside the list.
    const shownReadiness = readies[nets.indexOf(net)] ?? null;
    const [wheels, team, readiness] = await Promise.all([
      canManage
        ? api.POST('/v1/queries/outreach.wheels', { body: { workspaceId } }).then(unwrapPage)
        : null,
      canManage
        ? api
            .POST('/v1/queries/outreach.live.team', { body: { workspaceId, platform: net } })
            .then((r) => r.data ?? null)
            .catch(() => null)
        : null,
      shownReadiness ??
        (today.ready
          ? null
          : api
              .POST('/v1/queries/outreach.readiness', { body: { workspaceId, platform: net } })
              .then(unwrapPage)),
    ]);
    return (
      <OutreachHome
        workspaceId={workspaceId}
        businessName={got.workspace.name}
        canManage={canManage}
        shown={{
          view: 'today',
          platform: net,
          networks,
          today,
          helpful,
          wheels,
          team,
          asks,
          waiting,
          readiness,
        }}
      />
    );
  });
}
