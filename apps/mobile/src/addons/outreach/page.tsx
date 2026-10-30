import { readNetwork } from '@hfos/core/addons/outreach/network-words';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';

import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { openWebPath } from '@/home/open';

import { ChatsScreen } from './chats';
import { CodeScreen } from './code';
import { CountriesScreen } from './countries';
import { FindScreen } from './find';
import { OutreachWorkspace } from './frame';
import { FriendsScreen } from './friends';
import { GroupPageScreen } from './group-page';
import { GroupsScreen } from './groups';
import { OutreachHomeScreen } from './home';
import { TodayHub } from './hub';
import { isSetUp, outreachPath, useOutreachContext, type OutreachTab, type WebTab } from './kit';
import { LiveScreen } from './live';
import { NeverContactScreen } from './never-contact';
import { PartnersScreen } from './partners';
import { PipelineScreen } from './pipeline';
import { PlaybooksScreen } from './playbooks';
import { ResultsScreen } from './results';
import { SettingsScreen } from './settings';
import { NeedsYouScreen } from './waiting';

/**
 * Social Outreach on the phone (decisions 44, 59, 127 and 128), by its address's `?view=`, as the web's old addresses
 * name its pages. With none, its first screen lists the pages in the web's side-menu order (./home.tsx). Needs you is
 * `waiting`; Today (`today`) has what the computer is doing on each network, the list and Done today; People is one
 * list with a view for each kind (./frame.tsx): the Pipeline, the friends lists (`friends`, `&show=` which), Chats,
 * the Partners list and the Never contact list; then Find people (`find`), where Groups (`groups`, `&group=` one
 * group's own page, decision 103) open from, Results, Playbooks and Settings, a menu with `?part=` one of its pages
 * (General, or a network's). `live` is Your computer: its whole day, its computers and what was asked of it. `code` is
 * the code a network emailed for an ask (`?ask=`), where its notification opens (decision 82). `countries` is one of
 * the lists the country setting makes (`?show=unsure|skipped`). The old Activity has a lot to look through, so it stays
 * on the web: a link to it opens there (the manifest's `ui.phone` `web`), and this says so if one is opened here
 * anyway.
 */

const PHONE_TABS: readonly OutreachTab[] = [
  'waiting',
  'live',
  'today',
  'pipeline',
  'friends',
  'find',
  'groups',
  'chats',
  'never_contact',
  'partners',
  'results',
  'playbooks',
  'settings',
  'code',
  'countries',
];
const WEB_TABS: readonly WebTab[] = ['activity'];

export function OutreachPage(props: {
  view?: string;
  for?: string;
  show?: string;
  tag?: string;
  q?: string;
  net?: string;
  part?: string;
  ask?: string;
  group?: string;
}) {
  const ctx = useOutreachContext();
  return (
    <OutreachWorkspace.Provider value={ctx.workspaceId}>
      <OutreachView {...props} />
    </OutreachWorkspace.Provider>
  );
}

function OutreachView({
  view,
  for: whose,
  show,
  tag,
  q,
  net,
  part,
  ask,
  group,
}: {
  view?: string;
  for?: string;
  show?: string;
  tag?: string;
  q?: string;
  net?: string;
  part?: string;
  ask?: string;
  group?: string;
}) {
  const tab = PHONE_TABS.find((t) => t === view);
  const webTab = WEB_TABS.find((t) => t === view);
  switch (tab) {
    case 'waiting':
      return <NeedsYouScreen />;
    case 'today':
      return <TodayHub net={readNetwork(net)} />;
    case 'live':
      return <LiveScreen net={readNetwork(net)} />;
    case 'pipeline':
      return <PipelineScreen show={show} q={q} />;
    case 'friends':
      return show === 'never_contact' ? (
        <NeverContactScreen q={q} />
      ) : (
        <FriendsScreen show={show} q={q} />
      );
    case 'find':
      return <FindScreen net={readNetwork(net)} />;
    case 'groups':
      return group ? (
        <GroupPageScreen groupId={group} show={show} />
      ) : (
        <GroupsScreen show={show} q={q} />
      );
    case 'chats':
      return <ChatsScreen show={show} tag={tag} q={q} />;
    case 'never_contact':
      return <NeverContactScreen q={q} />;
    case 'partners':
      return <PartnersScreen show={show} net={readNetwork(net)} />;
    case 'results':
      return <ResultsScreen />;
    case 'playbooks':
      return <PlaybooksScreen />;
    case 'settings':
      return <SettingsScreen whose={whose} part={part} />;
    case 'code':
      return <CodeScreen askId={ask ?? null} />;
    case 'countries':
      return <CountriesScreen show={show} />;
    default:
      return webTab ? <WebOnlyScreen tab={webTab} /> : <OutreachHomeScreen />;
  }
}

/** Whether the person has set Social Outreach up (./kit.tsx). */
export { isSetUp };

/** A tab the phone leaves to the web, opened here anyway: what it is, and a button to open it there. */
export function WebOnlyScreen({ tab }: { tab: WebTab }) {
  const ctx = useOutreachContext();
  return <WebOnlyBody tab={tab} workspaceId={ctx.workspaceId} />;
}

export function WebOnlyBody({ tab, workspaceId }: { tab: WebTab; workspaceId: string }) {
  const what = W.rows[tab];
  return (
    <Screen title={what} leading="back" testID="outreach-web-only">
      <Card className="gap-3 px-5 py-6">
        <Text className="text-[16px] font-semibold">{W.webOnlyTitle(what)}</Text>
        <Text className="text-[14.5px] leading-[21px] text-text-2">{W.webOnlyBody}</Text>
        <Button
          variant="secondary"
          onPress={() => openWebPath(outreachPath(workspaceId, tab))}
          testID="outreach-open-web"
        >
          {W.openOnTheWeb}
        </Button>
      </Card>
    </Screen>
  );
}
