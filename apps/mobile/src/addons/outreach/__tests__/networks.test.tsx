import {
  AUTOMATION_DEFAULTS,
  NETWORKS_DEFAULTS,
  type AutomationOutput,
} from '@hfos/core/addons/outreach/automation';
import type { LiveOutput } from '@hfos/core/addons/outreach/live';
import type { StagesOutput } from '@hfos/core/addons/outreach/stages';
import type { TodayItem, TodayOutput } from '@hfos/core/addons/outreach/today';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { LiveStrip } from '../hub';
import { PipelineBody } from '../pipeline';
import { SettingsBody } from '../settings';
import { TodayBody } from '../today';
import { id, ME, TZ } from './mocks';

/**
 * Each network on the phone (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Build order" step 3): Today's strip
 * a row for each network with its own Start my day, the list in its network's words, the network on each row of the
 * pipeline with a filter, and LinkedIn turned on in My settings with choices of its own, inside what the business
 * allows.
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
  change: jest.fn(async () => ({ id: 'change-1', queued: true })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: true }),
  networkSnapshot: () => ({ online: true, lastOnlineAt: 0 }),
}));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

const NOW = Date.parse('2026-10-10T15:00:00.000Z');
const LIMIT = { done: 1, most: 15 };

const LIVE: LiveOutput = {
  timezone: TZ,
  now: new Date(NOW).toISOString(),
  sending: 'steps',
  canSend: true,
  day: { date: '2026-10-10', state: 'none', why: null, via: null, at: null },
  computer: null,
  computers: [],
  status: null,
  limits: {
    friend_request: LIMIT,
    first_message: LIMIT,
    follow_up: LIMIT,
    comment: LIMIT,
    like: LIMIT,
  },
  waiting: 0,
  warning: null,
  steps: [],
};

const handlers = () => ({
  onRetry: jest.fn(),
  onStart: jest.fn(),
  onStop: jest.fn(),
  onSettings: jest.fn(),
  onDetails: jest.fn(),
});

describe('Today’s strip, a row for each network', () => {
  it('gives a network its own row, by name, with its own Start my day', async () => {
    const h = handlers();
    const onShow = jest.fn();
    await render(
      <LiveStrip
        platform="linkedin"
        live={LIVE}
        error={null}
        online
        now={NOW}
        pressed={null}
        many
        shown={false}
        onShow={onShow}
        {...h}
      />,
    );
    const row = screen.getByTestId('today-network-linkedin');
    expect(within(row).getByText('LinkedIn')).toBeTruthy();
    expect(within(row).getByText('Not started today')).toBeTruthy();
    // Not the network shown: its limits are under its own list.
    expect(screen.queryByTestId('today-limits')).toBeNull();
    await fireEvent.press(screen.getByTestId('live-start'));
    expect(h.onStart).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('today-network-linkedin-open'));
    expect(onShow).toHaveBeenCalled();
  });

  it('says the network shown’s limits in its words, and its warning names it', async () => {
    await render(
      <LiveStrip
        platform="linkedin"
        live={{
          ...LIVE,
          day: { ...LIVE.day, state: 'stopped', why: 'warning', via: 'extension' },
          warning: {
            at: new Date(NOW).toISOString(),
            words: 'You’ve reached the weekly invitation limit',
            slowerUntil: new Date(NOW + 7 * 86_400_000).toISOString(),
            requestsFrom: new Date(NOW + 2 * 86_400_000).toISOString(),
            today: true,
          },
        }}
        error={null}
        online
        now={NOW}
        pressed={null}
        many
        shown
        {...handlers()}
      />,
    );
    expect(screen.getByTestId('today-limit-friend_request')).toHaveTextContent(
      /^Invitations to connect1 \/ 15$/,
    );
    expect(screen.getByTestId('live-warning')).toHaveTextContent(
      /^LinkedIn warned you: “You’ve reached the weekly invitation limit”\. The extension stops on LinkedIn for today\./,
    );
    expect(screen.getByText('Stopped for today: LinkedIn showed a warning.')).toBeTruthy();
    // A warning there keeps LinkedIn's day stopped.
    expect(screen.getByTestId('live-start')).toBeDisabled();
  });
});

const item: TodayItem = {
  recent: [],
  kind: 'friend_request',
  name: 'Avery Lane',
  profileId: id(40),
  profileUrl: 'https://www.linkedin.com/in/avery-lane/',
  chatId: null,
  threadKey: null,
  postId: null,
  postUrl: null,
  posted: null,
  post: null,
  asking: false,
  why: ['Owner at Lane Plumbing'],
  summary: null,
  nextStep: null,
  playbookName: null,
  demoLink: null,
  videoLink: null,
  send: null,
  personId: null,
  demoBooked: false,
};

describe('A network’s list for today', () => {
  it('says LinkedIn’s steps in its words, and opens the profile there', async () => {
    const today: TodayOutput = {
      limits: LIVE.limits,
      items: [item],
      readAdmins: [],
      hasPlaybook: true,
      warning: null,
      auto: [],
      messages: [],
      sending: 'off',
      wheels: { on: false, from: null, ok: 0, daysLeft: 0, edits: 0 },
      ready: true,
      week: null,
    };
    await render(
      <TodayBody
        platform="linkedin"
        today={today}
        error={null}
        wheels={null}
        onRetry={jest.fn()}
        onOk={jest.fn()}
        onSkip={jest.fn()}
        onNotForMe={jest.fn()}
        onEndWheels={jest.fn()}
      />,
    );
    const part = screen.getByTestId('today-friend_request');
    expect(within(part).getByText('Send an invitation to connect · 1')).toBeTruthy();
    expect(within(part).getByText('Open on LinkedIn')).toBeTruthy();
  });
});

const person = (
  n: number,
  platform: 'facebook' | 'linkedin',
  name: string,
): StagesOutput['people'][number] => ({
  profileId: id(70 + n),
  personId: null,
  name,
  url:
    platform === 'linkedin'
      ? `https://www.linkedin.com/in/made-up-${n}/`
      : `https://www.facebook.com/made.up.${n}`,
  platform,
  stage: 'warming',
  why: [],
  nextStep: null,
  lastAt: null,
  threadKey: null,
  marked: false,
  demoBooked: false,
  check: null,
});

describe('The network on every row', () => {
  it('names each person’s network on the pipeline, and narrows it to one', async () => {
    const onNet = jest.fn();
    const pipeline: StagesOutput = {
      counts: {
        all: 2,
        found: 0,
        warming: 2,
        friends: 0,
        talking: 0,
        ready: 0,
        pitched: 0,
        booked: 0,
        lost: 0,
      },
      people: [person(1, 'facebook', 'Riley Stone'), person(2, 'linkedin', 'Quinn Harper')],
      page: 1,
      pages: 1,
      total: 2,
    };
    await render(
      <PipelineBody
        view="all"
        onView={jest.fn()}
        net={null}
        onNet={onNet}
        search=""
        onSearch={jest.fn()}
        pipeline={pipeline}
        error={null}
        onRetry={jest.fn()}
        onMore={jest.fn()}
        onMark={jest.fn()}
      />,
    );
    const rows = screen.getAllByTestId('pipeline-person');
    expect(within(rows[0]!).getByTestId('network-name')).toHaveTextContent('Facebook');
    expect(within(rows[1]!).getByTestId('network-name')).toHaveTextContent('LinkedIn');
    await fireEvent.press(screen.getByTestId('network-filter-linkedin'));
    expect(onNet).toHaveBeenCalledWith('linkedin');
    await fireEvent.press(screen.getByTestId('network-filter-all'));
    expect(onNet).toHaveBeenLastCalledWith(null);
  });
});

const AUTOMATION: AutomationOutput = {
  settings: AUTOMATION_DEFAULTS,
  timezone: TZ,
  startedAt: null,
  saved: true,
  wheels: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  networkWheels: { linkedin: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 } },
  userId: ME,
  name: 'Dana Reyes',
  changedBy: null,
  rules: {
    sendingAllowed: ['off', 'steps', 'approve_all', 'everything'],
    repliesAllowed: ['draft', 'simple', 'everything'],
    postingAllowed: ['copy', 'after_ok', 'own'],
    dailyLimits: {},
    networksAllowed: ['facebook', 'linkedin'],
    networkLimits: {},
  },
};

const settingsProps = () => ({
  error: null,
  mine: true,
  people: null,
  business: null,
  manages: false,
  online: true,
  onRetry: jest.fn(),
  onWhose: jest.fn(),
  onSaveMine: jest.fn(async () => null),
  onSaveBusiness: jest.fn(async () => null),
});

describe('Networks in My settings on the phone', () => {
  it('turns LinkedIn on with its own choices, in its words, off to start', async () => {
    const p = settingsProps();
    await render(<SettingsBody automation={AUTOMATION} {...p} />);
    // Off to start: nothing of LinkedIn's shows until it's on.
    expect(screen.queryByTestId('settings-networks-linkedin-sending-steps')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-networks-linkedin-on'));
    expect(
      screen.getByText(
        'Invitations to connect, likes and comments on their own; each message waits for one tap',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Accept invitations from people who fit a playbook')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-networks-linkedin-sending-steps'));
    await fireEvent.press(screen.getByTestId('settings-my-save'));
    expect(p.onSaveMine).toHaveBeenCalledWith({
      ...AUTOMATION_DEFAULTS,
      networks: {
        ...NETWORKS_DEFAULTS,
        linkedin: { ...NETWORKS_DEFAULTS.linkedin, on: true, sending: 'steps' },
      },
    });
  });

  it('says why a network the business doesn’t use can’t be turned on, and who can change it', async () => {
    await render(
      <SettingsBody
        automation={{
          ...AUTOMATION,
          rules: { ...AUTOMATION.rules, networksAllowed: ['facebook'] },
        }}
        {...settingsProps()}
      />,
    );
    expect(screen.getByTestId('settings-networks-linkedin-not-allowed')).toHaveTextContent(
      'Your business doesn’t use LinkedIn for outreach. Ask an owner or admin of this business to allow it under Social Outreach → Settings → Business settings.',
    );
    expect(screen.getByTestId('settings-networks-linkedin-on')).toBeDisabled();
  });

  it('lets owners and admins allow networks and set LinkedIn’s own daily limits', async () => {
    const p = settingsProps();
    await render(
      <SettingsBody
        automation={AUTOMATION}
        {...p}
        manages
        business={{ contactsFromChats: 'tagged' }}
      />,
    );
    expect(screen.getByText('Daily limits on LinkedIn')).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('settings-rules-linkedin-limit-friend_request'),
      '40',
    );
    await fireEvent.press(screen.getByTestId('settings-business-save'));
    // Never past LinkedIn's starting limit.
    expect(p.onSaveBusiness).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rules: expect.objectContaining({ networkLimits: { linkedin: { friend_request: 15 } } }),
      }),
    );
    await fireEvent.press(screen.getByTestId('settings-rules-network-linkedin'));
    expect(screen.queryByText('Daily limits on LinkedIn')).toBeNull();
    // Facebook is always allowed.
    expect(screen.getByTestId('settings-rules-network-facebook')).toBeDisabled();
  });
});
