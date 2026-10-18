import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ExternalLink, Settings2 } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';

import { openOutreach, switchOutreach, type OutreachTab } from './kit';

/**
 * Social Outreach's frame on the phone (decision 59): its name, the gear for Settings and Playbooks, and the four tabs
 * the web has, Today, People, Groups and Results, so the add-on is one place rather than a list of screens. People has
 * its own Pipeline, Chats, the Partners list and the Never contact list, a row of them that scrolls, and Friends, which
 * stays on the web.
 */

export type FrameTab = 'today' | 'people' | 'groups' | 'results';
/** People's lists the phone has. */
type PeopleList = 'pipeline' | 'chats' | 'partners' | 'never_contact';
const PEOPLE_LISTS: readonly PeopleList[] = ['pipeline', 'chats', 'partners', 'never_contact'];

/** The business whose Social Outreach is open: the page sets it, so each screen's body draws the frame alone. */
export const OutreachWorkspace = React.createContext('');

const TAB_VIEW: Readonly<Record<FrameTab, OutreachTab>> = {
  today: 'today',
  people: 'pipeline',
  groups: 'groups',
  results: 'results',
};

export function OutreachFrame({
  tab,
  people,
  subtitle,
  testID,
  children,
}: {
  tab: FrameTab;
  /** Which of People's lists, on the People tab. */
  people?: PeopleList;
  subtitle?: string;
  testID?: string;
  children?: React.ReactNode;
}) {
  const workspaceId = React.useContext(OutreachWorkspace);
  return (
    <Screen
      title={W.title}
      subtitle={subtitle}
      leading="back"
      testID={testID}
      trailing={
        <Pressable
          role="button"
          accessibilityLabel={W.tabs.settings}
          onPress={() => openOutreach(workspaceId, 'settings')}
          className="size-11 items-center justify-center rounded-full active:bg-card-2"
          testID="outreach-open-settings"
        >
          <Icon as={Settings2} className="size-[21px] text-text-2" />
        </Pressable>
      }
      header={
        <View className="gap-2">
          <Segmented
            label={W.title}
            value={tab}
            onChange={(t) => switchOutreach(workspaceId, TAB_VIEW[t])}
            options={(['today', 'people', 'groups', 'results'] as const).map((t) => ({
              value: t,
              label: W.tabs[t],
              testID: `outreach-tab-${t}`,
            }))}
            testID="outreach-tabs"
          />
          {tab === 'people' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-1.5" accessibilityLabel={W.tabs.people}>
                {PEOPLE_LISTS.map((v) => {
                  const on = (people ?? 'pipeline') === v;
                  return (
                    <Button
                      key={v}
                      size="sm"
                      variant={on ? 'secondary' : 'ghost'}
                      accessibilityState={{ selected: on }}
                      onPress={() => {
                        if (!on) switchOutreach(workspaceId, v);
                      }}
                      testID={`outreach-people-${v}`}
                    >
                      {W.peopleParts[v]}
                    </Button>
                  );
                })}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={ExternalLink}
                  accessibilityLabel={`${W.peopleParts.friends}, ${W.onTheWeb.toLowerCase()}`}
                  onPress={() => openOutreach(workspaceId, 'friends')}
                  testID="outreach-people-friends"
                >
                  {W.peopleParts.friends}
                </Button>
              </View>
            </ScrollView>
          ) : null}
        </View>
      }
    >
      {children}
    </Screen>
  );
}
