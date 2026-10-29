import { OUTREACH_PAGES, type OutreachPage } from '@hfos/core/addons/outreach/pages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { ExternalLink } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';

import { openOutreach, switchOutreach } from './kit';

/**
 * One of Social Outreach's pages on the phone (decision 126): its name at the top, as the add-on's first screen lists
 * them (./home.tsx) in the web's side-menu order, and Back to that list. People has its own Pipeline, Chats, the
 * Partners list and the Never contact list, a row of them that scrolls, and Friends, which stays on the web.
 */

/** People's lists the phone has. */
type PeopleList = 'pipeline' | 'chats' | 'partners' | 'never_contact';
const PEOPLE_LISTS: readonly PeopleList[] = ['pipeline', 'chats', 'partners', 'never_contact'];

/** The business whose Social Outreach is open: the page sets it, so each screen's body draws the frame alone. */
export const OutreachWorkspace = React.createContext('');

export function OutreachFrame({
  page,
  people,
  subtitle,
  testID,
  children,
}: {
  page: OutreachPage;
  /** Which of People's lists, on People. */
  people?: PeopleList;
  subtitle?: string;
  testID?: string;
  children?: React.ReactNode;
}) {
  const workspaceId = React.useContext(OutreachWorkspace);
  return (
    <Screen
      title={OUTREACH_PAGES[page]}
      subtitle={subtitle ?? W.title}
      leading="back"
      testID={testID}
      header={
        page === 'people' ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-1.5" accessibilityLabel={OUTREACH_PAGES.people}>
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
        ) : undefined
      }
    >
      {children}
    </Screen>
  );
}
