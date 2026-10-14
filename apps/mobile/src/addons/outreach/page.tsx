import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';

import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { openWebPath } from '@/home/open';

import { ChatsScreen } from './chats';
import { OutreachWorkspace } from './frame';
import { GroupsScreen } from './groups';
import { TodayHub } from './hub';
import { isSetUp, outreachPath, useOutreachContext, type OutreachTab, type WebTab } from './kit';
import { LiveScreen } from './live';
import { NeverContactScreen } from './never-contact';
import { PipelineScreen } from './pipeline';
import { PlaybooksScreen } from './playbooks';
import { ResultsScreen } from './results';
import { SettingsScreen } from './settings';

/**
 * Social Outreach's page on the phone (decisions 44 and 59), by its address's `?view=`, as the web's: four tabs and
 * the gear. Today (no `?view=`, `today`, and the old `waiting`) has what the computer is doing, Needs you and the
 * list; People is the Pipeline, Chats and the Never contact list; then Groups and Results; the gear opens Settings, with Playbooks there.
 * `live` is the computer's whole day. Friends, and the old Activity, have a lot to look through, so they stay on the
 * web: a link to them opens there (the manifest's `ui.phone` `web`), and this says so if one is opened here anyway.
 */

const PHONE_TABS: readonly OutreachTab[] = [
  'waiting',
  'live',
  'today',
  'pipeline',
  'groups',
  'chats',
  'never_contact',
  'results',
  'playbooks',
  'settings',
];
const WEB_TABS: readonly WebTab[] = ['activity', 'friends'];

export function OutreachPage(props: {
  view?: string;
  for?: string;
  show?: string;
  tag?: string;
  q?: string;
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
}: {
  view?: string;
  for?: string;
  show?: string;
  tag?: string;
  q?: string;
}) {
  const tab = PHONE_TABS.find((t) => t === view);
  const webTab = WEB_TABS.find((t) => t === view);
  switch (tab) {
    case 'live':
      return <LiveScreen />;
    case 'pipeline':
      return <PipelineScreen show={show} q={q} />;
    case 'groups':
      return <GroupsScreen show={show} q={q} />;
    case 'chats':
      return <ChatsScreen show={show} tag={tag} q={q} />;
    case 'never_contact':
      return <NeverContactScreen q={q} />;
    case 'results':
      return <ResultsScreen />;
    case 'playbooks':
      return <PlaybooksScreen />;
    case 'settings':
      return <SettingsScreen whose={whose} />;
    default:
      return webTab ? <WebOnlyScreen tab={webTab} /> : <TodayHub />;
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
