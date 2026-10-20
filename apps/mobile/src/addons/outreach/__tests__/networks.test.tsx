import {
  AUTOMATION_DEFAULTS,
  NETWORKS_DEFAULTS,
  type AutomationOutput,
  type AutomationSettings,
  type NetworkChoices,
} from '@hfos/core/addons/outreach/automation';
import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import { outreachSettings, type OutreachSettings } from '@hfos/core/addons/outreach/chat-read';
import type { LiveOutput } from '@hfos/core/addons/outreach/live';
import type { ReadinessOutput } from '@hfos/core/addons/outreach/readiness';
import type { StagesOutput } from '@hfos/core/addons/outreach/stages';
import type { TodayItem, TodayOutput } from '@hfos/core/addons/outreach/today';
import { OUTREACH_WORDS } from '@hfos/core/addons/outreach/words';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as React from 'react';

import { SAVE_PAUSE_MS } from '../autosave';
import { LiveStrip } from '../hub';
import { PipelineBody } from '../pipeline';
import { SettingsPartBody } from '../settings';
import { NetworkModes, NetworkTicks } from '../settings-bits';
import { TodayBody } from '../today';
import { id, ME, TZ } from './mocks';

/**
 * Each network on the phone (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Build order" step 3): Today's strip
 * a row for each network with its own Start my day, the list in its network's words, the network on each row of the
 * pipeline with a filter, and each network's own page of Settings (Chris, 2026-10-16): its switch, its choices in its
 * words inside what the business allows, its limits as they stand, and for owners and admins the team's say on it,
 * each change saved as it's made.
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
const W_ALONG = OUTREACH_WORDS.sections.along;
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

  it('says a list with no runner is the person’s own to do, with no Start my day or Settings to change it', async () => {
    const h = handlers();
    await render(
      <LiveStrip
        platform="instagram"
        live={{ ...LIVE, sending: 'off', canSend: true }}
        error={null}
        online
        now={NOW}
        pressed={null}
        many={false}
        shown
        onShow={jest.fn()}
        {...h}
      />,
    );
    expect(screen.getByTestId('live-sending-off')).toHaveTextContent(
      /doesn’t work on Instagram on its own yet/,
    );
    expect(screen.queryByTestId('live-settings')).toBeNull();
    expect(screen.queryByTestId('live-start')).toBeNull();
  });

  it('offers Alignable’s Settings while its Sending is Off, now its runner works there', async () => {
    const h = handlers();
    await render(
      <LiveStrip
        platform="alignable"
        live={{ ...LIVE, sending: 'off', canSend: true }}
        error={null}
        online
        now={NOW}
        pressed={null}
        many={false}
        shown
        onShow={jest.fn()}
        {...h}
      />,
    );
    expect(screen.getByTestId('live-sending-off')).not.toHaveTextContent(/on its own yet/);
    expect(screen.getByTestId('live-settings')).toBeTruthy();
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
      partners: [],
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
  networkWheels: {
    linkedin: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
    instagram: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
    alignable: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  },
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

const partProps = () => ({
  error: null,
  mine: true,
  business: null,
  manages: false,
  online: true,
  onRetry: jest.fn(),
  onSaveMine: jest.fn(async (_settings: AutomationSettings): Promise<string | null> => null),
  onSaveBusiness: jest.fn(
    async (_edit: (now: OutreachSettings) => Partial<OutreachSettings>): Promise<string | null> =>
      null,
  ),
});

/** The defaults with LinkedIn turned on or off, and its choices. */
const withLinkedIn = (on: boolean, choices: Partial<NetworkChoices> = {}): AutomationSettings => ({
  ...AUTOMATION_DEFAULTS,
  networks: { ...NETWORKS_DEFAULTS, linkedin: { ...NETWORKS_DEFAULTS.linkedin, on, ...choices } },
});

describe('A network’s page of Settings on the phone, saved as it’s changed', () => {
  it('turns LinkedIn on at once, saying so beside the switch, and shows its own choices in its words', async () => {
    const p = partProps();
    await render(<SettingsPartBody part="linkedin" automation={AUTOMATION} {...p} />);
    expect(screen.getByTestId('screen-title')).toHaveTextContent('LinkedIn');
    expect(screen.getByText('What the extension does for you on LinkedIn.')).toBeTruthy();
    // Off to start: nothing of LinkedIn's shows until it's on.
    expect(screen.getByTestId('settings-networks-linkedin-off')).toHaveTextContent(
      'LinkedIn is off for you: nothing runs, reads or shows there.',
    );
    expect(screen.queryByTestId('settings-networks-linkedin-sending-steps')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-networks-linkedin-on'));
    expect(p.onSaveMine).toHaveBeenCalledTimes(1);
    expect(p.onSaveMine).toHaveBeenLastCalledWith(withLinkedIn(true));
    expect(screen.getByTestId('settings-networks-linkedin-saved')).toHaveTextContent(
      'LinkedIn is on. The extension picks it up in a few seconds.',
    );
    expect(
      screen.getByText(
        'Invitations to connect, likes and comments on their own; each message waits for one tap',
      ),
    ).toBeTruthy();
    // Only the switches LinkedIn's runner does: it never accepts invitations on its own.
    expect(screen.queryByText('Accept invitations from people who fit a playbook')).toBeNull();
    expect(screen.getByTestId('settings-networks-linkedin-collect')).toBeTruthy();
    expect(screen.getByTestId('settings-networks-linkedin-chrome')).toHaveTextContent(
      /press Allow on LinkedIn, then Allow in Chrome’s box\.$/,
    );
    // Facebook's own switches aren't LinkedIn's.
    expect(screen.queryByTestId('settings-networks-linkedin-noting')).toBeNull();
    // Its choices save at once too, with the plain Saved.
    await fireEvent.press(screen.getByTestId('settings-networks-linkedin-sending-steps'));
    expect(p.onSaveMine).toHaveBeenCalledTimes(2);
    expect(p.onSaveMine).toHaveBeenLastCalledWith(withLinkedIn(true, { sending: 'steps' }));
    expect(screen.getByTestId('settings-networks-linkedin-saved')).toHaveTextContent(
      'Saved. The extension follows it in a few seconds.',
    );
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('says beside a choice that it starts LinkedIn’s training wheels, until they’ve started', async () => {
    const starts = /^Choosing this starts training wheels/;
    const automation = { ...AUTOMATION, settings: withLinkedIn(true, { sending: 'steps' }) };
    await render(<SettingsPartBody part="linkedin" automation={automation} {...partProps()} />);
    const everything = screen.getByTestId('settings-networks-linkedin-sending-everything');
    expect(within(everything).getByText(starts)).toBeTruthy();
    expect(
      within(screen.getByTestId('settings-networks-linkedin-replies-simple')).getByText(starts),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('settings-networks-linkedin-sending-approve_all')).queryByText(
        starts,
      ),
    ).toBeNull();
    // Started: each is as it is, and the page says where they stand.
    const wheels = { on: true, from: '2026-10-09T15:00:00.000Z', ok: 3, daysLeft: 6, edits: 0 };
    await render(
      <SettingsPartBody
        part="linkedin"
        automation={{
          ...automation,
          networkWheels: { ...automation.networkWheels, linkedin: wheels },
        }}
        {...partProps()}
      />,
    );
    expect(screen.queryByText(starts)).toBeNull();
    expect(screen.getByTestId('settings-networks-linkedin-wheels')).toHaveTextContent(
      /^Training wheels: every message waits for your OK/,
    );
  });

  it('puts the switch back when it can’t be saved, with the server’s words beside it', async () => {
    const p = partProps();
    const refusal =
      'Your business doesn’t use LinkedIn for outreach. Turn it off, or ask an owner of this business to allow it under Social Outreach → Settings → Business settings.';
    let answer: (problem: string | null) => void = () => undefined;
    p.onSaveMine.mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          answer = resolve;
        }),
    );
    await render(<SettingsPartBody part="linkedin" automation={AUTOMATION} {...p} />);
    await fireEvent.press(screen.getByTestId('settings-networks-linkedin-on'));
    expect(screen.getByTestId('settings-networks-linkedin-saving')).toHaveTextContent('Saving…');
    await act(async () => answer(refusal));
    expect(screen.getByTestId('settings-networks-linkedin-on')).not.toBeChecked();
    expect(screen.getByTestId('settings-networks-linkedin-problem')).toHaveTextContent(refusal);
    expect(screen.queryByTestId('settings-networks-linkedin-sending-steps')).toBeNull();
  });

  it('needs signal: with none, the switch and the choices wait', async () => {
    await render(
      <SettingsPartBody part="facebook" automation={AUTOMATION} {...partProps()} online={false} />,
    );
    expect(
      screen.getByText('Settings needs signal. Try again when you’re back online.'),
    ).toBeTruthy();
    for (const testID of [
      'settings-networks-facebook-on',
      'settings-networks-facebook-sending-steps',
      'settings-networks-facebook-replies-simple',
      'settings-networks-facebook-posting-own',
      'settings-networks-facebook-warmUp',
      'settings-networks-facebook-noting',
    ])
      expect(screen.getByTestId(testID)).toBeDisabled();
  });

  it('says only why a network the business doesn’t use can’t be turned on, and who can change it', async () => {
    await render(
      <SettingsPartBody
        part="linkedin"
        automation={{
          ...AUTOMATION,
          settings: withLinkedIn(true),
          rules: { ...AUTOMATION.rules, networksAllowed: ['facebook'] },
        }}
        {...partProps()}
      />,
    );
    expect(screen.getByTestId('settings-networks-linkedin-not-allowed')).toHaveTextContent(
      'Your business doesn’t use LinkedIn for outreach. Ask an owner or admin of this business to allow it under Social Outreach → Settings → LinkedIn.',
    );
    expect(screen.getByTestId('settings-networks-linkedin-on')).toBeDisabled();
    expect(screen.getByTestId('settings-networks-linkedin-on')).not.toBeChecked();
    expect(screen.queryByTestId('settings-networks-linkedin-sending-steps')).toBeNull();
    expect(screen.queryByTestId('settings-networks-linkedin-limits')).toBeNull();
  });

  it('has Facebook’s own switches, and the person’s limits there as they stand, halved on training wheels', async () => {
    const p = partProps();
    const automation = {
      ...AUTOMATION,
      rules: { ...AUTOMATION.rules, dailyLimits: { friend_request: 12 } },
    };
    await render(<SettingsPartBody part="facebook" automation={automation} {...p} />);
    expect(screen.getByText('Your daily limits on Facebook')).toBeTruthy();
    expect(screen.getByTestId('settings-networks-facebook-limit-friend_request')).toHaveTextContent(
      '12Friend requests',
    );
    expect(screen.getByTestId('settings-networks-facebook-limit-like')).toHaveTextContent(
      '40Likes',
    );
    // No Chrome note on Facebook: the extension is let on there from the start.
    expect(screen.queryByTestId('settings-networks-facebook-chrome')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-networks-facebook-noting'));
    expect(p.onSaveMine).toHaveBeenLastCalledWith({ ...AUTOMATION_DEFAULTS, noting: false });
    await render(
      <SettingsPartBody
        part="facebook"
        automation={{ ...automation, wheels: { ...automation.wheels, on: true } }}
        {...partProps()}
      />,
    );
    expect(screen.getByTestId('settings-networks-facebook-limit-friend_request')).toHaveTextContent(
      '6Friend requests',
    );
  });

  it('says LinkedIn’s limits in its words', async () => {
    await render(
      <SettingsPartBody
        part="linkedin"
        automation={{ ...AUTOMATION, settings: withLinkedIn(true) }}
        {...partProps()}
      />,
    );
    expect(screen.getByTestId('settings-networks-linkedin-limit-friend_request')).toHaveTextContent(
      '15Invitations to connect',
    );
  });
});

describe('A network’s page and the person’s computer (decisions 74 and 77)', () => {
  const asks = (
    allowed: ('facebook' | 'linkedin' | 'instagram')[] | null,
    version = '0.48.0',
  ): AsksOutput => ({
    now: new Date().toISOString(),
    timezone: TZ,
    computer: {
      computerId: id(9),
      name: 'Chrome on Mac 12',
      online: true,
      signedOut: false,
      lastSeenAt: new Date().toISOString(),
      version,
      allowed,
    },
    warnedToday: false,
    asks: [],
  });

  it('says what to press when Chrome hasn’t let the extension on LinkedIn, and checks LinkedIn when asked', async () => {
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    await render(
      <SettingsPartBody
        part="linkedin"
        automation={{ ...AUTOMATION, settings: withLinkedIn(true) }}
        {...partProps()}
        asks={asks(['facebook'])}
        askActions={actions}
      />,
    );
    expect(screen.getByTestId('settings-networks-linkedin-chrome-blocked')).toHaveTextContent(
      'Chrome on Mac 12 isn’t allowed on LinkedIn yet. Open the extension’s panel on a LinkedIn page and press Allow on LinkedIn, then Allow in Chrome’s box.',
    );
    expect(screen.getByTestId('settings-networks-linkedin-checkup')).toHaveTextContent(
      /^Check LinkedInIf something on LinkedIn isn’t working, press this once\./,
    );
    await fireEvent.press(screen.getByTestId('settings-networks-linkedin-checkup-ask'));
    expect(actions.ask).toHaveBeenCalledWith({ kind: 'checkup' }, 'linkedin');
  });

  it('checks Facebook when asked, with no line about Chrome, whose Facebook is the extension’s own (decision 77)', async () => {
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    await render(
      <SettingsPartBody
        part="facebook"
        automation={AUTOMATION}
        {...partProps()}
        asks={asks(['facebook'], '0.57.0')}
        askActions={actions}
      />,
    );
    expect(screen.queryByTestId('settings-networks-facebook-chrome')).toBeNull();
    expect(screen.queryByTestId('settings-networks-facebook-chrome-blocked')).toBeNull();
    expect(screen.getByTestId('settings-networks-facebook-checkup')).toHaveTextContent(
      /^Check FacebookIf something on Facebook isn’t working, press this once\./,
    );
    await fireEvent.press(screen.getByTestId('settings-networks-facebook-checkup-ask'));
    expect(actions.ask).toHaveBeenCalledWith({ kind: 'checkup' }, 'facebook');
  });

  it('shows a network still looked at only Chrome’s say, what it does there for now, and its Check (decision 78)', async () => {
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    const instagramOn: AutomationOutput = {
      ...AUTOMATION,
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...NETWORKS_DEFAULTS,
          instagram: { ...NETWORKS_DEFAULTS.instagram, on: true },
        },
      },
      rules: { ...AUTOMATION.rules, networksAllowed: ['facebook', 'linkedin', 'instagram'] },
    };
    await render(
      <SettingsPartBody
        part="instagram"
        automation={instagramOn}
        {...partProps()}
        asks={asks(['facebook'], '0.58.0')}
        askActions={actions}
      />,
    );
    expect(screen.getByTestId('settings-networks-instagram-chrome-blocked')).toHaveTextContent(
      'Chrome on Mac 12 isn’t allowed on Instagram yet. Open the extension’s panel on an Instagram page and press Allow on Instagram, then Allow in Chrome’s box.',
    );
    expect(screen.getByTestId('settings-networks-instagram-looking')).toHaveTextContent(
      /^Instagram is new to HandsFreeOS\. For now the extension only reads it/,
    );
    // Nothing to choose yet, and no limits to show.
    expect(screen.queryByTestId('settings-networks-instagram-sending-steps')).toBeNull();
    expect(screen.queryByTestId('settings-networks-instagram-limits')).toBeNull();
    expect(screen.getByTestId('settings-networks-instagram-checkup')).toHaveTextContent(
      /^Check InstagramPress this once, so the extension can learn Instagram from your own account\./,
    );
    await fireEvent.press(screen.getByTestId('settings-networks-instagram-checkup-ask'));
    expect(actions.ask).toHaveBeenCalledWith({ kind: 'checkup' }, 'instagram');
  });

  it('reads and checks the person’s profile there, on a network still looked at too (decision 80)', async () => {
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    const instagramOn: AutomationOutput = {
      ...AUTOMATION,
      settings: {
        ...AUTOMATION_DEFAULTS,
        networks: {
          ...NETWORKS_DEFAULTS,
          instagram: { ...NETWORKS_DEFAULTS.instagram, on: true },
        },
      },
      rules: { ...AUTOMATION.rules, networksAllowed: ['facebook', 'linkedin', 'instagram'] },
    };
    const readiness: ReadinessOutput = {
      ready: false,
      next: 'profile',
      changed: [],
      platform: 'instagram',
      items: [{ item: 'profile', state: 'todo', whose: 'person', left: null }],
      offer: { version: 1, line: 'We help roofers get booked inspections.' },
      profile: {},
      profileCheck: null,
      messages: { at: null, version: null, samples: null },
      numbers: { goal: null, at: null, days: [1, 2, 3, 4, 5], canSend: 15 },
    };
    const onTick = jest.fn(async () => undefined);
    await render(
      <SettingsPartBody
        part="instagram"
        automation={instagramOn}
        {...partProps()}
        asks={asks(['facebook', 'instagram'], '0.62.0')}
        askActions={actions}
        profile={{ readiness, onTick }}
      />,
    );
    const part = screen.getByTestId('settings-networks-instagram-profile');
    expect(within(part).getByText('Your Instagram profile')).toBeTruthy();
    expect(screen.getByTestId('settings-networks-instagram-profile-state')).toHaveTextContent(
      'Have the extension read your Instagram profile, and the AI says what to change.',
    );
    await fireEvent.press(screen.getByTestId('settings-networks-instagram-profile-open'));
    await fireEvent.press(screen.getByTestId('ready-profile-read-ask'));
    expect(actions.ask).toHaveBeenCalledWith({ kind: 'profile_read' }, 'instagram');
    // Ticked here, as on Get ready.
    await fireEvent.press(screen.getByTestId('ready-profile-name'));
    await waitFor(() => expect(onTick).toHaveBeenCalledWith('name', true));
    // Someone else's settings: no profile of theirs to read.
    await render(
      <SettingsPartBody
        part="instagram"
        automation={instagramOn}
        {...partProps()}
        mine={false}
        profile={{ readiness, onTick }}
      />,
    );
    expect(screen.queryByTestId('settings-networks-instagram-profile')).toBeNull();
  });

  it('says how to update a build before Check Facebook, and asks nothing of it', async () => {
    const actions = { busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() };
    await render(
      <SettingsPartBody
        part="facebook"
        automation={AUTOMATION}
        {...partProps()}
        asks={asks(['facebook'], '0.56.0')}
        askActions={actions}
      />,
    );
    expect(screen.getByTestId('outreach-ask-too-old')).toHaveTextContent(
      /^HandsFreeOS Social on Chrome on Mac 12 is an older build \(0\.56\.0\) that can’t do this yet\. Download the newest one/,
    );
    await fireEvent.press(screen.getByTestId('settings-networks-facebook-checkup-ask'));
    expect(actions.ask).not.toHaveBeenCalled();
  });

  it('says only how to allow it once Chrome has, and asks nothing on someone else’s settings', async () => {
    await render(
      <SettingsPartBody
        part="linkedin"
        automation={{ ...AUTOMATION, settings: withLinkedIn(true) }}
        {...partProps()}
        asks={asks(['facebook', 'linkedin'])}
        askActions={{ busy: null, ask: jest.fn(), reply: jest.fn(), stop: jest.fn() }}
      />,
    );
    expect(screen.queryByTestId('settings-networks-linkedin-chrome-blocked')).toBeNull();
    expect(screen.getByTestId('settings-networks-linkedin-chrome')).toBeTruthy();
    await render(
      <SettingsPartBody
        part="linkedin"
        automation={{ ...AUTOMATION, settings: withLinkedIn(true) }}
        {...partProps()}
        mine={false}
      />,
    );
    expect(screen.queryByTestId('settings-networks-linkedin-checkup')).toBeNull();
  });
});

/** What a save of the business's settings puts on what's kept now. */
const savedOn = (
  p: ReturnType<typeof partProps>,
  now: Record<string, unknown>,
): Partial<OutreachSettings> => p.onSaveBusiness.mock.lastCall![0](outreachSettings(now));

describe('For your team on a network, for owners and admins', () => {
  afterEach(() => jest.useRealTimers());

  it('lets the team use LinkedIn or not, saved at once on what’s kept', async () => {
    const p = partProps();
    const kept = { weeklyReport: false, rules: { sendingAllowed: ['off', 'steps'] } };
    await render(
      <SettingsPartBody part="linkedin" automation={AUTOMATION} {...p} manages business={kept} />,
    );
    expect(screen.getByText('For your team on LinkedIn')).toBeTruthy();
    expect(screen.getByTestId('settings-rules-network-linkedin')).toBeChecked();
    await fireEvent.press(screen.getByTestId('settings-rules-network-linkedin'));
    expect(p.onSaveBusiness).toHaveBeenCalledTimes(1);
    // Only LinkedIn's say changes: General's rules stay as they're kept, every other network still allowed.
    expect(savedOn(p, kept).rules).toMatchObject({
      networksAllowed: ['facebook', 'instagram', 'alignable'],
      sendingAllowed: ['off', 'steps'],
    });
    expect(savedOn(p, kept).weeklyReport).toBeUndefined();
    expect(screen.getByTestId('settings-team-linkedin-saved')).toBeTruthy();
    // Not allowed: no limits to set.
    expect(screen.queryByTestId('settings-rules-linkedin-limit-friend_request')).toBeNull();
  });

  it('sets each person’s daily limits on LinkedIn, at most its starting ones, once the stepper stops', async () => {
    jest.useFakeTimers();
    const p = partProps();
    await render(
      <SettingsPartBody part="linkedin" automation={AUTOMATION} {...p} manages business={{}} />,
    );
    // At LinkedIn's starting limit: never past it.
    expect(screen.getByTestId('settings-rules-linkedin-limit-friend_request-up')).toBeDisabled();
    expect(
      screen.getByTestId('settings-rules-linkedin-limit-friend_request-value'),
    ).toHaveTextContent('15');
    await fireEvent.press(screen.getByTestId('settings-rules-linkedin-limit-friend_request-down'));
    await fireEvent.press(screen.getByTestId('settings-rules-linkedin-limit-friend_request-down'));
    expect(p.onSaveBusiness).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(SAVE_PAUSE_MS));
    expect(p.onSaveBusiness).toHaveBeenCalledTimes(1);
    expect(savedOn(p, {}).rules?.networkLimits).toEqual({ linkedin: { friend_request: 13 } });
  });

  it('keeps Facebook allowed always, with its limits for each person', async () => {
    jest.useFakeTimers();
    const p = partProps();
    const kept = { rules: { networkLimits: { linkedin: { like: 5 } } } };
    await render(
      <SettingsPartBody part="facebook" automation={AUTOMATION} {...p} manages business={kept} />,
    );
    expect(screen.getByTestId('settings-rules-network-facebook')).toBeDisabled();
    expect(screen.getByTestId('settings-rules-network-facebook')).toBeChecked();
    expect(screen.getByText('Always allowed')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-rules-facebook-limit-like-down'));
    await act(async () => jest.advanceTimersByTime(SAVE_PAUSE_MS));
    const rules = savedOn(p, kept).rules;
    expect(rules?.dailyLimits).toEqual({ like: 39 });
    // LinkedIn's, set on its page, stay.
    expect(rules?.networkLimits).toEqual({ linkedin: { like: 5 } });
  });

  it('still shows the team’s part on a network the business doesn’t use', async () => {
    await render(
      <SettingsPartBody
        part="linkedin"
        automation={{
          ...AUTOMATION,
          rules: { ...AUTOMATION.rules, networksAllowed: ['facebook'] },
        }}
        {...partProps()}
        manages
        business={{ rules: { networksAllowed: ['facebook'] } }}
      />,
    );
    expect(screen.getByTestId('settings-networks-linkedin-not-allowed')).toHaveTextContent(
      /^Your business doesn’t use LinkedIn for outreach\./,
    );
    expect(screen.getByTestId('settings-rules-network-linkedin')).not.toBeChecked();
    expect(screen.getByTestId('settings-rules-network-linkedin')).toBeEnabled();
  });
});

/**
 * A network the extension doesn't work on its own yet (Instagram, still looked at): its page says so instead of
 * offering Sending and Replies, has no helpful post to choose, and no switches along the way, as nothing reads them.
 */
describe('a network with no runner yet', () => {
  const value: NetworkChoices = { ...NETWORKS_DEFAULTS.instagram, on: true };

  it('says every step there is the person’s own, with nothing to pick', async () => {
    await render(
      <>
        <NetworkModes
          platform="instagram"
          value={value}
          onChange={jest.fn()}
          sendingAllowed={['off', 'steps', 'approve_all', 'everything']}
          repliesAllowed={['draft', 'simple']}
          boxed={false}
          disabled={false}
          testID="modes"
        />
        <NetworkTicks
          platform="instagram"
          value={value}
          onChange={jest.fn()}
          boxed={false}
          disabled={false}
          testID="ticks"
        />
      </>,
    );
    expect(screen.getByTestId('modes-on-its-own')).toHaveTextContent(
      /doesn’t work on Instagram on its own yet/,
    );
    expect(screen.queryByTestId('modes-sending-steps')).toBeNull();
    expect(screen.queryByTestId('modes-sending-off')).toBeNull();
    expect(screen.queryByTestId('modes-replies-draft')).toBeNull();
    expect(screen.queryByTestId('modes-posting-after_ok')).toBeNull();
    expect(screen.queryByText(W_ALONG)).toBeNull();
  });
});
