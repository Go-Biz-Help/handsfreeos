import type { ActivityOutput } from '@hfos/core/addons/outreach/activity';
import type { FindsWeekOutput } from '@hfos/core/addons/outreach/finds';
import type { FriendsOutput } from '@hfos/core/addons/outreach/friends';
import { waitingOfCopy } from '@hfos/core/addons/outreach/views/waiting';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { FindBody } from '../find';
import { FriendsBody } from '../friends';
import { ResultsBody } from '../results';
import { WaitingBody } from '../waiting';
import { id, ME, TZ } from './mocks';

/**
 * People's friends lists, Find people, Results person by person and Not sure where they live on the phone
 * (docs/outreach.md, decision 128), as on the web: each friends list with its people and the views' counts, a friend's
 * Keep switch, the ways people are found with what each found this week, and the people the country setting isn't sure
 * of waiting in Needs you.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: false, output: {} })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

const NOW = Date.parse('2026-10-10T15:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
afterEach(() => jest.useRealTimers());

const person = (n: number, over: Partial<FriendsOutput['people'][number]> = {}) => ({
  profileId: id(n),
  personId: null,
  name: `Person ${n}`,
  url: `https://www.facebook.com/person.${n}`,
  platform: 'facebook' as const,
  state: null,
  since: null,
  keep: false,
  dontPitch: null,
  neverContact: null,
  mutualFriends: null,
  intro: [],
  group: null,
  friendsSince: null,
  lastMessage: null,
  fit: null,
  check: null,
  ...over,
});

const listOf = (people: FriendsOutput['people']): FriendsOutput => ({
  counts: {
    friends: 120,
    fits: 14,
    requests: 2,
    sent: 9,
    keep: 3,
    dontPitch: 5,
    neverContact: 1,
  },
  cap: 5000,
  download: null,
  people,
  checks: {
    people: 0,
    checked: 0,
    good: 0,
    maybe: 0,
    waiting: 0,
    again: 0,
    today: 0,
    perDay: 40,
  },
  page: 1,
  pages: 1,
  total: people.length,
  more: 0,
});

const friends = (
  list: FriendsOutput | null,
  props: Partial<React.ComponentProps<typeof FriendsBody>> = {},
) => (
  <FriendsBody
    view="requests"
    search=""
    onSearch={jest.fn()}
    list={list}
    error={null}
    onRetry={jest.fn()}
    onMore={jest.fn()}
    online
    onKeep={jest.fn(async () => {})}
    {...props}
  />
);

describe('The friends lists on the phone', () => {
  it('lists a view’s people with how they fit and since when, and each view’s count', async () => {
    await render(
      friends(
        listOf([
          person(1, {
            state: 'request_received',
            since: ago(2),
            fit: { level: 'good', score: 8, playbookName: null, reasons: ['Owns a bakery'] },
          }),
          person(2, { state: 'request_received', since: ago(20), mutualFriends: 6 }),
        ]),
      ),
    );
    expect(screen.getByTestId('people-view-requests')).toHaveTextContent('Requests 2');
    expect(screen.getByTestId('people-view-friends')).toHaveTextContent('Friends 120');
    expect(screen.getByTestId('people-view-requests').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.getByTestId('friends-count')).toHaveTextContent('Requests · 2');
    const [first, second] = screen.getAllByTestId('friend');
    expect(within(first!).getByTestId('friend-fit')).toHaveTextContent('Good fit');
    expect(first).toHaveTextContent(/Owns a bakery/);
    expect(within(first!).getByTestId('friend-since')).toHaveTextContent('Asked · 2 d ago');
    expect(within(second!).getByTestId('friend-mutual')).toHaveTextContent('6 mutual');
    // Keep is a friend's alone.
    expect(screen.queryByTestId('friend-keep')).toBeNull();
  });

  it('keeps a friend from being suggested for unfriending', async () => {
    const onKeep = jest.fn(async () => {});
    await render(
      friends(listOf([person(3, { state: 'friends', friendsSince: '2019-03-02T00:00:00.000Z' })]), {
        view: 'friends',
        onKeep,
      }),
    );
    expect(screen.getByTestId('friend-since')).toHaveTextContent('Friends since Mar 2019');
    await fireEvent(screen.getByTestId('friend-keep'), 'onCheckedChange', true);
    await waitFor(() => expect(onKeep).toHaveBeenCalledWith(id(3), true));
  });

  it('says what a list holds when nobody’s on it, and when nobody has the name searched for', async () => {
    const view = await render(friends(listOf([]), { view: 'sent' }));
    expect(screen.getByTestId('friends-empty')).toHaveTextContent(
      /No requests waiting on an answer/,
    );
    await view.rerender(friends(listOf([]), { view: 'sent', search: 'Zed' }));
    expect(screen.getByTestId('friends-empty')).toHaveTextContent(/Nobody called “Zed” here/);
  });
});

const WEEK: FindsWeekOutput = {
  since: ago(7),
  ways: [
    { platform: 'facebook', how: 'member', found: 40, good: 9, maybe: 4 },
    { platform: 'instagram', how: 'searched', found: 22, good: 5, maybe: 2 },
    { platform: 'linkedin', how: 'searched', found: 3, good: 1, maybe: 0 },
  ],
  followers: { found: 0, good: 0, maybe: 0 },
  members: { found: 10, good: 2, maybe: 1 },
  partners: 2,
  download: null,
};

describe('Find people on the phone', () => {
  it('has a card for each way, with what it found this week, and opens where each is changed', async () => {
    const onOpen = jest.fn();
    await render(<FindBody week={WEEK} error={null} onRetry={jest.fn()} online onOpen={onOpen} />);
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Find people');
    expect(screen.getByTestId('find-way-groups-line')).toHaveTextContent(
      '50 found this week · 11 good fits',
    );
    expect(screen.getByTestId('find-way-searches-line')).toHaveTextContent(
      '25 found this week · 6 good fits',
    );
    expect(screen.getByTestId('find-way-followers-line')).toHaveTextContent(
      'Nothing found this week',
    );
    expect(screen.getByTestId('find-way-partners-line')).toHaveTextContent('2 found this week');
    await fireEvent.press(screen.getByTestId('find-way-groups-open'));
    await fireEvent.press(screen.getByTestId('find-way-searches-open'));
    await fireEvent.press(screen.getByTestId('find-way-partners-open'));
    expect(onOpen.mock.calls.map(([view]) => view)).toEqual(['groups', 'playbooks', 'partners']);
  });

  it('shows one network’s ways when it’s picked', async () => {
    await render(
      <FindBody
        net="alignable"
        week={WEEK}
        error={null}
        onRetry={jest.fn()}
        online
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getAllByTestId(/^find-way-[a-z_]+$/).map((card) => card.props.testID)).toEqual([
      'find-way-groups',
      'find-way-posts',
      'find-way-searches',
      'find-way-events',
      'find-way-partners',
    ]);
  });
});

describe('Results person by person on the phone', () => {
  it('lists the people reached, the latest first, with each step they’ve come', async () => {
    const zero = { friend_request: 0, first_message: 0, follow_up: 0, comment: 0, like: 0 };
    const activity: ActivityOutput = {
      from: ago(7),
      timezone: TZ,
      everyone: false,
      numbers: {
        people: 1,
        friendRequests: 1,
        likes: 0,
        comments: 0,
        chatsStarted: 1,
        followUps: 0,
        replies: 1,
        demos: 0,
      },
      today: zero,
      limits: zero,
      warning: null,
      partners: null,
      groups: [],
      topics: [],
      people: [
        {
          profileId: id(90),
          personId: null,
          name: 'Jo Baker',
          url: 'https://www.linkedin.com/in/jo-baker',
          platform: 'linkedin',
          group: { name: 'Austin Makers', url: 'https://www.linkedin.com/groups/1' },
          requestedAt: ago(3),
          likedAt: null,
          commentedAt: null,
          messagedAt: ago(2),
          repliedAt: ago(1),
          lastAt: ago(1),
        },
      ],
      morePeople: 4,
    };
    await render(
      <ResultsBody
        activity={activity}
        error={null}
        period="week"
        onPeriod={jest.fn()}
        onRetry={jest.fn()}
        onWeb={jest.fn()}
      />,
    );
    const row = screen.getByTestId('results-person');
    expect(row).toHaveTextContent(/Jo Baker.*LinkedIn.*1 d ago.*From Austin Makers/);
    expect(within(row).getByTestId('results-person-requestedAt')).toHaveTextContent(
      'Invitation to connect · 3 d ago',
    );
    expect(within(row).getByTestId('results-person-repliedAt')).toHaveTextContent(
      'Wrote back · 1 d ago',
    );
    expect(within(row).queryByTestId('results-person-likedAt')).toBeNull();
    expect(screen.getByTestId('results-by-person')).toHaveTextContent(/And 4 more, not shown\./);
  });
});

describe('Not sure where they live, in Needs you', () => {
  it('says how many wait for a pick, and opens them', async () => {
    const onOpen = jest.fn();
    await render(
      <WaitingBody
        phone={waitingOfCopy([], ME)}
        server={null}
        serverError={null}
        online
        timeZone={TZ}
        now={NOW}
        onRetry={jest.fn()}
        onOk={jest.fn()}
        onSkip={jest.fn()}
        onOkAll={jest.fn()}
        onClear={jest.fn()}
        onLeave={jest.fn()}
        onSettings={jest.fn()}
        unsure={{ count: 3, onOpen }}
      />,
    );
    expect(screen.getByTestId('waiting-country-unsure')).toHaveTextContent(
      /Not sure where they live.*3 people wait for you to pick\./,
    );
    await fireEvent.press(screen.getByTestId('waiting-country-unsure-open'));
    expect(onOpen).toHaveBeenCalled();
  });
});
