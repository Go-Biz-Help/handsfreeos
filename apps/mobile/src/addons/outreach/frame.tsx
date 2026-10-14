import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ExternalLink, Settings2 } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';

import { openOutreach, switchOutreach, type OutreachTab } from './kit';

/**
 * Social Outreach's frame on the phone (decision 59): its name, the gear for Settings and Playbooks, and the four tabs
 * the web has, Today, People, Groups and Results, so the add-on is one place rather than a list of screens. People has
 * its own Pipeline, Chats and the Never contact list, and Friends, which stays on the web.
 */

export type FrameTab = 'today' | 'people' | 'groups' | 'results';

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
  people?: 'pipeline' | 'chats' | 'never_contact';
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
            <View className="flex-row items-center gap-2">
              <Segmented
                label={W.tabs.people}
                className="flex-1"
                value={people ?? 'pipeline'}
                onChange={(v) => switchOutreach(workspaceId, v)}
                options={(['pipeline', 'chats', 'never_contact'] as const).map((v) => ({
                  value: v,
                  label: W.peopleParts[v],
                  testID: `outreach-people-${v}`,
                }))}
              />
              <Pressable
                role="link"
                accessibilityLabel={`${W.peopleParts.friends}, ${W.onTheWeb.toLowerCase()}`}
                onPress={() => openOutreach(workspaceId, 'friends')}
                className="h-10 flex-row items-center gap-1.5 rounded-[9px] px-3 active:bg-card-2"
                testID="outreach-people-friends"
              >
                <Text className="text-sm font-medium text-text-2">{W.peopleParts.friends}</Text>
                <Icon as={ExternalLink} className="size-3.5 text-text-3" />
              </Pressable>
            </View>
          ) : null}
        </View>
      }
    >
      {children}
    </Screen>
  );
}
