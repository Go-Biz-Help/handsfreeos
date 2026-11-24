import { OUTREACH_PAGES, type OutreachPage } from '@hfos/core/addons/outreach/pages';
import {
  LEFT_ALONE,
  LEFT_ALONE_KEYS,
  PEOPLE_VIEW_KEYS,
  PEOPLE_VIEW_WORDS as PV,
  PEOPLE_VIEWS,
  peopleListOf,
  peopleViewOf,
  type LeftAlone,
  type PeopleList,
  type PeopleView,
} from '@hfos/core/addons/outreach/people-views';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';

import { openOutreach, switchOutreach, type OutreachTab } from './kit';

/**
 * One of Social Outreach's pages on the phone (decisions 127 and 128): its name at the top, as the add-on's first
 * screen lists them (./home.tsx) in the web's side-menu order, and Back to that list. People is one list with a view
 * for each kind, as on the web (`people-views.ts` in core), a row of them that scrolls, and under Left alone a row of
 * its own lists. A view replaces the screen rather than stacking on it; Skipped for country opens over it. Needs you and
 * Today have a row of parts the same way (decision 193, `PartsRow`), switched in place.
 */

/** The business whose Social Outreach is open: the page sets it, so each screen's body draws the frame alone. */
export const OutreachWorkspace = React.createContext('');

/** A list's screen on the phone, as the web's `?view=` names it, with its query. */
export function peopleScreenOf(at: PeopleList): {
  readonly view: OutreachTab;
  readonly more: string;
} {
  switch (at.list) {
    case 'stages':
      return { view: 'pipeline', more: at.show === 'all' ? '' : `show=${at.show}` };
    case 'friends':
      return at.show === 'never_contact'
        ? { view: 'never_contact', more: '' }
        : { view: 'friends', more: at.show === 'friends' ? '' : `show=${at.show}` };
    case 'chats':
      return { view: 'chats', more: '' };
    case 'partners':
      return { view: 'partners', more: '' };
    case 'hands':
      return { view: 'hands', more: '' };
    case 'country':
      return { view: 'countries', more: 'show=skipped' };
  }
}

const withCount = (label: string, count: number | undefined) =>
  count === undefined ? label : `${label} ${count.toLocaleString('en-US')}`;

/** One choice on a row of parts: its key, its words, how many are on it where that's known, and whether it's open. */
export interface PartChoice<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly count?: number;
  readonly on: boolean;
}

/**
 * A row of parts that scrolls, the one open marked: People's views and Left alone's lists (decision 128), and Needs
 * you's and Today's parts (decision 193). Pressing the one open does nothing.
 */
export function PartsRow<K extends string>({
  label,
  parts,
  onPick,
  testIDOf,
}: {
  label: string;
  parts: readonly PartChoice<K>[];
  onPick: (key: K) => void;
  testIDOf: (key: K) => string;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="flex-row gap-1.5" accessibilityLabel={label}>
        {parts.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant={p.on ? 'secondary' : 'ghost'}
            accessibilityState={{ selected: p.on }}
            onPress={() => {
              if (!p.on) onPick(p.key);
            }}
            testID={testIDOf(p.key)}
          >
            {withCount(p.label, p.count)}
          </Button>
        ))}
      </View>
    </ScrollView>
  );
}

export function OutreachFrame({
  page,
  list,
  counts = {},
  subtitle,
  header,
  testID,
  children,
}: {
  page: OutreachPage;
  /** Which of People's lists, on People: in play when left out. */
  list?: PeopleList;
  /** How many are on each view, where the list shown knows (`peopleCountsOf`). */
  counts?: Partial<Record<PeopleView | LeftAlone, number>>;
  subtitle?: string;
  /** Under the title on a page other than People: Today's parts (decision 193). */
  header?: React.ReactNode;
  testID?: string;
  children?: React.ReactNode;
}) {
  const workspaceId = React.useContext(OutreachWorkspace);
  const at = peopleViewOf(list ?? { list: 'stages', show: 'all' });
  const go = (to: PeopleList) => {
    const { view, more } = peopleScreenOf(to);
    // Skipped for country is a screen of its own, over People, so Back comes here.
    if (to.list === 'country') openOutreach(workspaceId, view, more);
    else switchOutreach(workspaceId, view, more);
  };
  return (
    <Screen
      title={OUTREACH_PAGES[page]}
      subtitle={subtitle ?? W.title}
      leading="back"
      testID={testID}
      header={
        page === 'people' ? (
          <View className="gap-1.5">
            <PartsRow<PeopleView>
              label={PV.label}
              parts={PEOPLE_VIEW_KEYS.map((v) => ({
                key: v,
                label: PEOPLE_VIEWS[v],
                count: counts[v],
                on: at.view === v,
              }))}
              onPick={(v) => go(peopleListOf(v))}
              testIDOf={(v) => `people-view-${v}`}
            />
            {at.alone ? (
              <PartsRow<LeftAlone>
                label={PV.leftAloneLabel}
                parts={LEFT_ALONE_KEYS.map((k) => ({
                  key: k,
                  label: LEFT_ALONE[k],
                  count: counts[k],
                  on: at.alone === k,
                }))}
                onPick={(k) => go(peopleListOf(k))}
                testIDOf={(k) => `people-alone-${k}`}
              />
            ) : null}
          </View>
        ) : (
          header
        )
      }
    >
      {children}
    </Screen>
  );
}
