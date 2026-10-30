import type { ActivityOutput } from '@hfos/core/addons/outreach/activity';
import type { PartnersOutput } from '@hfos/core/addons/outreach/partners';
import type { TodayItem, TodayOutput } from '@hfos/core/addons/outreach/today';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { router } from 'expo-router';

import { OutreachFrame, OutreachWorkspace } from '../frame';
import { PartnersBody } from '../partners';
import { ResultsBody } from '../results';
import { TodayBody } from '../today';
import { id, TZ, WS } from './mocks';

/**
 * Partners on the phone (docs/outreach.md, decision 81), as on the web: the Partners list on People, by stage with how
 * many are at each, each row with what their stage offers; a partner's steps on Today, in a part of their own, each
 * message with an OK of its own; and the person's own asks, yeses, calls and partners in Results.
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

const NOW = Date.parse('2026-10-18T15:00:00.000Z');
const COUNTS = {
  found: 1,
  warming: 0,
  asked: 1,
  interested: 0,
  call_booked: 0,
  partner: 0,
  not_now: 1,
};

const partner = (
  over: Partial<PartnersOutput['partners'][number]> = {},
): PartnersOutput['partners'][number] => ({
  partnerId: id(70),
  profileId: id(71),
  name: 'Gail Admin',
  url: 'https://www.facebook.com/gail.admin.1',
  platform: 'facebook',
  kind: 'group_admin',
  fit: 'good',
  stage: 'found',
  stageAt: new Date(NOW - 3 * 86_400_000).toISOString(),
  audience: 'About 4,200 Austin homeowners',
  audienceSize: 4200,
  followers: null,
  why: ['Runs a busy homeowners group'],
  nextStep: 'Comment on their latest post',
  playbook: null,
  marked: false,
  ...over,
});

describe('the Partners list on the phone', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('is one of People’s lists', async () => {
    await render(
      <OutreachWorkspace.Provider value={WS}>
        <OutreachFrame page="people" testID="framed" />
      </OutreachWorkspace.Provider>,
    );
    await fireEvent.press(screen.getByTestId('people-view-partners'));
    expect(String(jest.mocked(router.replace).mock.calls.at(-1)?.[0])).toContain('view=partners');
  });

  it('shows each stage with how many are at it, and what each row’s stage offers', async () => {
    const onView = jest.fn();
    const onMark = jest.fn();
    await render(
      <PartnersBody
        view="all"
        onView={onView}
        list={{
          counts: COUNTS,
          partners: [
            partner(),
            partner({
              partnerId: id(72),
              name: 'Hal Host',
              kind: 'creator',
              fit: 'maybe',
              stage: 'not_now',
              audience: null,
              audienceSize: null,
              followers: 28_200,
              why: [],
              nextStep: null,
            }),
          ],
          more: false,
        }}
        error={null}
        onRetry={jest.fn()}
        onMore={jest.fn()}
        onMark={onMark}
      />,
    );
    expect(screen.getByTestId('partners-show-all')).toHaveTextContent('Everyone 3');
    expect(screen.getByTestId('partners-show-asked')).toHaveTextContent('Asked 1');
    await fireEvent.press(screen.getByTestId('partners-show-not_now'));
    expect(onView).toHaveBeenCalledWith('not_now');
    const [gail, hal] = screen.getAllByTestId('partner');
    expect(within(gail!).getByText('Group admin · About 4,200 Austin homeowners')).toBeTruthy();
    expect(within(gail!).getByTestId('partner-stage')).toHaveTextContent('Found · 3 d ago');
    expect(within(gail!).getByText('Next: Comment on their latest post')).toBeTruthy();
    // Found: the stages ahead, Not now, and Not a partner.
    for (const m of ['interested', 'call_booked', 'not_now', 'not_partner'])
      expect(within(gail!).getByTestId(`partner-mark-${m}`)).toBeTruthy();
    await fireEvent.press(within(gail!).getByTestId('partner-mark-interested'));
    expect(onMark).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Gail Admin' }),
      'interested',
    );
    // Set aside: back on the list, or not a partner after all.
    expect(within(hal!).getByText('Might be a partner')).toBeTruthy();
    expect(within(hal!).getByText('Creator · 28,200 followers')).toBeTruthy();
    expect(within(hal!).getByTestId('partner-mark-again')).toBeTruthy();
    expect(within(hal!).queryByTestId('partner-mark-interested')).toBeNull();
  });

  it('says plainly when nobody is there yet, and waits for signal to mark anyone', async () => {
    await render(
      <PartnersBody
        view="asked"
        onView={jest.fn()}
        list={{ counts: COUNTS, partners: [], more: false }}
        error={null}
        onRetry={jest.fn()}
        onMore={jest.fn()}
        onMark={jest.fn()}
      />,
    );
    expect(screen.getByTestId('partners-empty')).toHaveTextContent('Nobody is at Asked yet.');
    await render(
      <PartnersBody
        view="all"
        onView={jest.fn()}
        list={{ counts: COUNTS, partners: [partner()], more: true }}
        error={null}
        onRetry={jest.fn()}
        onMore={jest.fn()}
        online={false}
        onMark={jest.fn()}
      />,
    );
    expect(screen.getByTestId('partner-mark-interested')).toBeDisabled();
    expect(screen.getByTestId('partners-more')).toBeTruthy();
  });

  it('offers Make partner only to whoever can manage partners', async () => {
    const body = (makesPartners?: boolean) => (
      <PartnersBody
        view="all"
        onView={jest.fn()}
        list={{ counts: COUNTS, partners: [partner({ stage: 'interested' })], more: false }}
        error={null}
        onRetry={jest.fn()}
        onMore={jest.fn()}
        onMark={jest.fn()}
        makesPartners={makesPartners}
      />
    );
    await render(body());
    expect(screen.getByTestId('partner-mark-partner')).toBeTruthy();
    await render(body(false));
    expect(screen.queryByTestId('partner-mark-partner')).toBeNull();
    expect(screen.getByTestId('partner-mark-call_booked')).toBeTruthy();
  });
});

const LIMIT = { done: 0, most: 20 };
const step = (kind: TodayItem['kind'], over: Partial<TodayItem> = {}): TodayItem => ({
  recent: [],
  kind,
  name: 'Gail Admin',
  profileId: id(71),
  profileUrl: 'https://www.facebook.com/gail.admin.1',
  chatId: null,
  threadKey: null,
  postId: null,
  postUrl: null,
  posted: null,
  post: null,
  asking: false,
  why: ['Group admin: About 4,200 Austin homeowners'],
  summary: null,
  nextStep: null,
  playbookName: null,
  demoLink: null,
  videoLink: null,
  send: null,
  personId: null,
  demoBooked: false,
  partnerId: id(70),
  ...over,
});

describe('a partner’s steps on Today', () => {
  it('have a part of their own, each message with an OK of its own', async () => {
    const onOk = jest.fn();
    const today: TodayOutput = {
      limits: {
        friend_request: LIMIT,
        first_message: LIMIT,
        follow_up: LIMIT,
        comment: LIMIT,
        like: LIMIT,
      },
      items: [],
      partners: [
        step('partner_warm_up'),
        step('partner_ask', {
          name: 'Hal Host',
          profileId: id(73),
          send: {
            sendId: id(74),
            state: 'waiting',
            text: 'Would you be open to a partnership?',
            handedOver: false,
            needsYou: 'it’s a message to a partner',
          },
        }),
      ],
      readAdmins: [],
      hasPlaybook: true,
      warning: null,
      auto: ['warm_up'],
      messages: ['partner_ask'],
      sending: 'steps',
      wheels: { on: false, from: null, ok: 0, daysLeft: 0, edits: 0 },
      ready: true,
      week: null,
      fresh: { on: false, from: null, until: null, days: 14 },
      requestsHeld: null,
      profileOwn: null,
      goal: null,
      retryAt: null,
    };
    await render(
      <TodayBody
        today={today}
        error={null}
        wheels={null}
        onRetry={jest.fn()}
        onOk={onOk}
        onSkip={jest.fn()}
        onNotForMe={jest.fn()}
        onEndWheels={jest.fn()}
      />,
    );
    // Nothing for customers today: no "nothing to do" above the partners.
    expect(screen.queryByTestId('today-empty')).toBeNull();
    const part = screen.getByTestId('today-partners');
    expect(within(part).getByText('Partners · 2')).toBeTruthy();
    const [warm, ask] = within(part).getAllByTestId('today-item');
    expect(within(warm!).getByTestId('today-step')).toHaveTextContent(
      'Warm up a partner · Done on its own',
    );
    expect(within(ask!).getByTestId('today-step')).toHaveTextContent('Ask about partnering');
    await fireEvent.press(within(ask!).getByTestId('today-ok'));
    expect(onOk).toHaveBeenCalledWith(id(74));
  });
});

describe('Results on the phone', () => {
  it('has the person’s own asks, yeses, calls and partners made', async () => {
    const zero = { friend_request: 0, first_message: 0, follow_up: 0, comment: 0, like: 0 };
    const activity: ActivityOutput = {
      from: new Date(NOW - 7 * 86_400_000).toISOString(),
      timezone: TZ,
      everyone: false,
      numbers: {
        people: 0,
        friendRequests: 0,
        likes: 0,
        comments: 0,
        chatsStarted: 0,
        followUps: 0,
        replies: 0,
        demos: 0,
      },
      today: zero,
      limits: zero,
      warning: null,
      partners: { asked: 3, interested: 1, calls: 1, partners: 0 },
      groups: [],
      topics: [],
      people: [],
      morePeople: 0,
    };
    const onPartners = jest.fn();
    await render(
      <ResultsBody
        activity={activity}
        error={null}
        period="week"
        onPeriod={jest.fn()}
        onRetry={jest.fn()}
        onWeb={jest.fn()}
        onPartners={onPartners}
      />,
    );
    expect(screen.getByTestId('results-partners-asked')).toHaveTextContent('Asked to partner 3');
    expect(screen.getByTestId('results-partners-calls')).toHaveTextContent('Calls booked 1');
    await fireEvent.press(screen.getByTestId('results-partners-open'));
    expect(onPartners).toHaveBeenCalled();
  });
});
