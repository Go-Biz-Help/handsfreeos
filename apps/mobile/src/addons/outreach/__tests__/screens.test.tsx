import { AUTOMATION_DEFAULTS, type AutomationOutput } from '@hfos/core/addons/outreach/automation';
import type { LiveOutput, LiveTeamOutput } from '@hfos/core/addons/outreach/live';
import { blankPlaybook, type Playbook } from '@hfos/core/addons/outreach/playbooks';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { openWebPath } from '@/home/open';

import { LiveBody, pressShown } from '../live';
import { OutreachMoreRow } from '../more';
import { OutreachHomeRows, WebOnlyBody } from '../page';
import { mergeSection, PlaybookBody, sectionWords } from '../playbook';
import { businessDraftOf, SettingsBody } from '../settings';
import { id, ME, TZ, WS } from './mocks';

/**
 * Social Outreach's other screens on the phone (decision 44): its one row in More, its first screen and the tabs left
 * to the web, the live view with Start my day and Stop for today, the settings, and a playbook changed a part at a
 * time on what's there now.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
}));
jest.mock('@/changes', () => ({
  change: jest.fn(async () => ({ id: 'change-1', queued: true })),
  ChangeError: class extends Error {},
}));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

const NOW = Date.parse('2026-10-10T15:00:00.000Z');

beforeEach(() => {
  mockOnline = true;
  jest.mocked(openWebPath).mockClear();
});

describe('Social Outreach in More and its first screen', () => {
  it('has one row in More, saying what waits, opening the add-on', async () => {
    await render(<OutreachMoreRow workspaceId={WS} messages={3} />);
    expect(screen.getByText('Social Outreach')).toBeTruthy();
    expect(screen.getByText('3 messages wait for your OK')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('more-outreach-open'));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/a/outreach`);
  });

  it('opens each tab at the web’s address, which the route map sends to the phone’s screen or the web', async () => {
    await render(<OutreachHomeRows workspaceId={WS} messages={0} />);
    expect(screen.getByText('No messages wait for your OK')).toBeTruthy();
    for (const tab of ['waiting', 'live', 'today', 'groups', 'chats', 'playbooks', 'settings'])
      await fireEvent.press(screen.getByTestId(`outreach-row-${tab}`));
    await fireEvent.press(screen.getByTestId('outreach-row-activity'));
    await fireEvent.press(screen.getByTestId('outreach-row-friends'));
    expect(jest.mocked(openWebPath).mock.calls.map(([p]) => p)).toEqual(
      [
        'waiting',
        'live',
        'today',
        'groups',
        'chats',
        'playbooks',
        'settings',
        'activity',
        'friends',
      ].map((v) => `/app/w/${WS}/a/outreach?view=${v}`),
    );
  });

  it('says a tab left to the web is there, and opens it', async () => {
    await render(<WebOnlyBody tab="activity" workspaceId={WS} />);
    expect(screen.getByText('Activity is on the web')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('outreach-open-web'));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/a/outreach?view=activity`);
  });
});

const LIMIT = { done: 2, most: 20 };
const LIVE: LiveOutput = {
  timezone: TZ,
  now: new Date(NOW).toISOString(),
  sending: 'steps',
  canSend: true,
  day: { date: '2026-10-10', state: 'none', why: null, via: null, at: null },
  computer: {
    id: id(1),
    name: 'Chrome on Mac',
    lastSeenAt: new Date(NOW - 30_000).toISOString(),
    activeAt: null,
    working: true,
    state: 'working',
    version: '0.16.0',
  },
  computers: [],
  status: {
    state: 'working',
    line: 'Liking a post of Dana Reyes’s',
    lineAt: new Date(NOW - 20_000).toISOString(),
    nextAt: null,
  },
  limits: {
    friend_request: LIMIT,
    first_message: LIMIT,
    follow_up: LIMIT,
    comment: LIMIT,
    like: { done: 7, most: 40 },
  },
  waiting: 4,
  warning: null,
  steps: [{ at: new Date(NOW - 60_000).toISOString(), kind: 'done', line: 'Liked a post' }],
};

const liveHandlers = () => ({
  onRetry: jest.fn(),
  onStart: jest.fn(),
  onStop: jest.fn(),
  onWaiting: jest.fn(),
  onSettings: jest.fn(),
});

describe('The live view on the phone', () => {
  it('shows what the extension is doing, today’s counts and steps, and starts and stops the day', async () => {
    const h = liveHandlers();
    await render(
      <LiveBody
        live={LIVE}
        at={NOW}
        error={null}
        team={null}
        online
        now={NOW}
        pressed={null}
        {...h}
      />,
    );
    expect(within(screen.getByTestId('live-state')).getByText('Working')).toBeTruthy();
    expect(screen.getByText('Liking a post of Dana Reyes’s')).toBeTruthy();
    expect(screen.getByText('7 of 40')).toBeTruthy();
    expect(screen.getByText('Waiting for you: 4')).toBeTruthy();
    expect(screen.getByText('Liked a post')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('live-start'));
    await fireEvent.press(screen.getByTestId('live-stop'));
    expect(h.onStart).toHaveBeenCalled();
    expect(h.onStop).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('live-waiting'));
    expect(h.onWaiting).toHaveBeenCalled();
  });

  it('with no signal, keeps the last answer as of when it came, and a press waits on the phone', async () => {
    const h = liveHandlers();
    await render(
      <LiveBody
        live={LIVE}
        at={NOW - 5 * 60_000}
        error={null}
        team={null}
        online={false}
        now={NOW}
        pressed="stopped"
        {...h}
      />,
    );
    expect(screen.getByTestId('screen-subtitle').props.children).toMatch(/^As of /);
    expect(screen.getByText('Live needs signal. Try again when you’re back online.')).toBeTruthy();
    expect(screen.getByTestId('outreach-queued-note')).toBeTruthy();
    expect(within(screen.getByTestId('live-state')).getByText('Stopped for today')).toBeTruthy();
  });

  it('says why there’s no day to start while the extension does nothing on its own', async () => {
    await render(
      <LiveBody
        live={{ ...LIVE, sending: 'off', canSend: false }}
        at={NOW}
        error={null}
        team={null}
        online
        now={NOW}
        pressed={null}
        {...liveHandlers()}
      />,
    );
    expect(screen.queryByTestId('live-start')).toBeNull();
    expect(screen.getByTestId('live-sending-off')).toBeTruthy();
    expect(screen.getByText(/Ask an owner of this business/)).toBeTruthy();
  });

  it('shows owners and admins each person’s state, never their lines', async () => {
    const team: LiveTeamOutput = {
      timezone: TZ,
      now: new Date(NOW).toISOString(),
      people: [
        {
          userId: id(7),
          name: 'Riley Member',
          state: 'offline',
          day: LIVE.day,
          sending: 'steps',
          computer: {
            name: 'Chrome on Windows',
            state: 'working',
            lastSeenAt: new Date(NOW - 3_600_000).toISOString(),
          },
          limits: LIVE.limits,
          waiting: 2,
          warned: true,
        },
      ],
    };
    await render(
      <LiveBody
        live={LIVE}
        at={NOW}
        error={null}
        team={team}
        online
        now={NOW}
        pressed={null}
        {...liveHandlers()}
      />,
    );
    const person = screen.getByTestId('live-team-person');
    expect(within(person).getByText('Riley Member')).toBeTruthy();
    expect(within(person).getByText('Offline')).toBeTruthy();
    expect(within(person).getByText(/2 waiting · Facebook warned them$/)).toBeTruthy();
  });

  it('offers no Start my day while a Facebook warning keeps the day stopped', async () => {
    const h = liveHandlers();
    await render(
      <LiveBody
        live={{
          ...LIVE,
          day: { ...LIVE.day, state: 'stopped', why: 'warning', via: null, at: LIVE.now },
        }}
        at={NOW}
        error={null}
        team={null}
        online
        now={NOW}
        pressed={null}
        {...h}
      />,
    );
    await fireEvent.press(screen.getByTestId('live-start'));
    expect(h.onStart).not.toHaveBeenCalled();
  });

  it('names the open computer when the one that works is offline, and the others as standing by', async () => {
    const mac = LIVE.computer!;
    await render(
      <LiveBody
        live={{
          ...LIVE,
          computer: { ...mac, lastSeenAt: new Date(NOW - 3 * 3_600_000).toISOString() },
          computers: [
            {
              ...mac,
              id: id(2),
              name: 'Chrome on the office PC',
              working: false,
              state: 'standby',
              lastSeenAt: new Date(NOW - 20_000).toISOString(),
            },
            {
              ...mac,
              id: id(3),
              name: 'Chrome on the laptop',
              working: false,
              state: 'signed_out',
              lastSeenAt: new Date(NOW - 20_000).toISOString(),
            },
          ],
        }}
        at={NOW}
        error={null}
        team={null}
        online
        now={NOW}
        pressed={null}
        {...liveHandlers()}
      />,
    );
    expect(screen.getByTestId('live-other-open').props.children).toBe(
      'Chrome on the office PC is open: open the panel there to work from it.',
    );
    const others = screen.getAllByTestId('live-other-computer').map((n) => n.props.children);
    expect(others[0]).toMatch(/^Chrome on the office PC · Standing by · seen /);
    expect(others[1]).toMatch(/^Chrome on the laptop · Signed out · seen /);
    expect(screen.queryByText(/^On Chrome on the office PC/)).toBeNull();
  });

  it('shows a press only while it waits on the phone, then HandsFreeOS’s answer, whatever it says', () => {
    const press = { state: 'started' as const, id: 'change-1', at: NOW };
    expect(pressShown(null, null, NOW)).toBe(false);
    // Not read back yet, and nothing answered since.
    expect(pressShown(press, null, NOW - 60_000)).toBe(true);
    for (const state of ['waiting', 'sending', 'held', 'retry'] as const)
      expect(pressShown(press, { state }, NOW + 60_000)).toBe(true);
    // Sent, or waiting on the person: HandsFreeOS's answer shows, even when it kept the day stopped.
    for (const state of ['sent', 'refused', 'ask'] as const)
      expect(pressShown(press, { state }, NOW - 60_000)).toBe(false);
    expect(pressShown(press, null, NOW + 1)).toBe(false);
  });

  it('says plainly it needs signal when there’s nothing to show', async () => {
    await render(
      <LiveBody
        live={null}
        at={null}
        error="Live needs signal. Try again when you’re back online."
        team={null}
        online={false}
        now={NOW}
        pressed={null}
        {...liveHandlers()}
      />,
    );
    expect(screen.getByTestId('live-needs-signal')).toBeTruthy();
  });
});

const AUTOMATION: AutomationOutput = {
  settings: AUTOMATION_DEFAULTS,
  timezone: TZ,
  saved: false,
  wheels: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  userId: ME,
  name: 'Dana Reyes',
  changedBy: null,
  rules: {
    sendingAllowed: ['off', 'steps'],
    repliesAllowed: ['draft'],
    dailyLimits: {},
  },
};

describe('Social Outreach’s settings on the phone', () => {
  const props = () => ({
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

  it('saves the person’s own choices, only those the business allows', async () => {
    const p = props();
    await render(<SettingsBody automation={AUTOMATION} {...p} />);
    expect(screen.getByText('My settings')).toBeTruthy();
    expect(screen.queryByTestId('settings-my-sending-everything')).toBeNull();
    expect(screen.getByText(/Your business doesn’t allow:/)).toBeTruthy();
    expect(screen.getByText(/An owner or admin of this business sets the choices/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-my-sending-steps'));
    await fireEvent.press(screen.getByTestId('settings-my-pushes-each'));
    await fireEvent.press(screen.getByTestId('settings-my-start-up'));
    await fireEvent.press(screen.getByTestId('settings-my-save'));
    expect(p.onSaveMine).toHaveBeenCalledWith({
      ...AUTOMATION_DEFAULTS,
      sending: 'steps',
      pushes: 'each',
      hours: { ...AUTOMATION_DEFAULTS.hours, start: 10 },
    });
  });

  it('lets owners and admins pick whose, and set the business’s', async () => {
    const p = props();
    const business = { contactsFromChats: 'tagged', weeklyReport: true };
    await render(
      <SettingsBody
        automation={AUTOMATION}
        {...p}
        manages
        business={business}
        people={{
          people: [
            {
              userId: ME,
              name: 'Dana Reyes',
              saved: false,
              sending: 'off',
              replies: 'draft',
              wheels: false,
            },
            {
              userId: id(7),
              name: 'Riley Member',
              saved: true,
              sending: 'steps',
              replies: 'draft',
              wheels: true,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText('Dana Reyes (not set yet)')).toBeTruthy();
    await fireEvent.press(screen.getAllByTestId('settings-for-person')[1]!);
    expect(p.onWhose).toHaveBeenCalledWith(id(7));
    await fireEvent.press(screen.getByTestId('settings-contacts-everyone'));
    await fireEvent.press(screen.getByTestId('settings-weekly'));
    await fireEvent.press(screen.getByTestId('settings-morning-down'));
    await fireEvent.press(screen.getByTestId('settings-business-save'));
    expect(p.onSaveBusiness).toHaveBeenCalledWith({
      ...businessDraftOf(business),
      contactsFromChats: 'everyone',
      weeklyReport: false,
      morningPushHour: 7,
    });
  });

  it('can’t save with no signal', async () => {
    await render(<SettingsBody automation={AUTOMATION} {...props()} online={false} />);
    expect(
      screen.getByText('Settings needs signal. Try again when you’re back online.'),
    ).toBeTruthy();
  });
});

const PLAYBOOK: Playbook = {
  id: id(30),
  name: 'Bakery owners',
  template: null,
  details: { ...blankPlaybook(), offer: 'A 20-minute demo', tags: ['Hot'] },
  archivedAt: null,
  createdAt: '2026-10-01T15:00:00.000Z',
  updatedAt: '2026-10-01T15:00:00.000Z',
};

describe('A playbook on the phone', () => {
  it('puts only the part changed on the playbook as it is now', () => {
    const fresh = {
      name: 'Bakery owners (web)',
      details: { ...PLAYBOOK.details, tone: 'Warm', offer: 'A free trial' },
    };
    const draft = { name: 'Phone name', details: { ...PLAYBOOK.details, signs: ['Owner'] } };
    const merged = mergeSection(fresh, draft, 'signs');
    expect(merged.name).toBe('Bakery owners (web)');
    expect(merged.details).toEqual({ ...fresh.details, signs: ['Owner'] });
    expect(mergeSection(fresh, draft, 'name')).toEqual({
      name: 'Phone name',
      details: fresh.details,
    });
    expect(
      mergeSection(
        fresh,
        { ...draft, details: { ...draft.details, link: 'https://example.com' } },
        'offer',
      ).details,
    ).toMatchObject({
      offer: 'A 20-minute demo',
      link: 'https://example.com',
      tone: 'Warm',
    });
  });

  it('reads each part, and nothing yet where there’s nothing', () => {
    expect(sectionWords(PLAYBOOK.details, 'offer')).toBe('A 20-minute demo');
    expect(sectionWords(PLAYBOOK.details, 'signs')).toBe('Nothing yet.');
    expect(sectionWords(PLAYBOOK.details, 'goal')).toBe('Book a demo');
  });

  it('lets owners and admins change a part, and says what’s wrong when it can’t be saved', async () => {
    const onSave = jest.fn(async () => 'Keep it under 300 characters.');
    await render(
      <PlaybookBody
        playbook={PLAYBOOK}
        error={null}
        manages
        online
        onRetry={jest.fn()}
        onSave={onSave}
        onArchive={jest.fn()}
      />,
    );
    await fireEvent.press(screen.getByTestId('playbook-edit-signs'));
    await fireEvent.changeText(screen.getByTestId('playbook-lines'), 'Owner\n\n Runs a Page ');
    await fireEvent.press(screen.getByTestId('playbook-save'));
    expect(onSave).toHaveBeenCalledWith(
      PLAYBOOK,
      expect.objectContaining({
        details: expect.objectContaining({ signs: ['Owner', 'Runs a Page'] }),
      }),
      'signs',
    );
    expect(await screen.findByText('Keep it under 300 characters.')).toBeTruthy();
  });

  it('is read-only for everyone else', async () => {
    await render(
      <PlaybookBody
        playbook={PLAYBOOK}
        error={null}
        manages={false}
        online
        onRetry={jest.fn()}
        onSave={jest.fn()}
        onArchive={jest.fn()}
      />,
    );
    expect(
      screen.getByText('An owner or admin of this business writes the playbooks.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('playbook-edit-signs')).toBeNull();
    expect(screen.queryByTestId('playbook-archive')).toBeNull();
  });

  it('says plainly when the business has no such playbook, and goes back to the list', async () => {
    const onPlaybooks = jest.fn();
    const body = (loading: boolean) => (
      <PlaybookBody
        playbook={null}
        loading={loading}
        error={null}
        manages
        online
        onRetry={jest.fn()}
        onPlaybooks={onPlaybooks}
        onSave={jest.fn()}
        onArchive={jest.fn()}
      />
    );
    await render(body(true));
    expect(screen.getByTestId('playbook-loading')).toBeTruthy();
    expect(screen.queryByTestId('playbook-missing')).toBeNull();
    await render(body(false));
    expect(
      screen.getByText('This playbook isn’t in this business. Pick one from Playbooks.'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('playbook-missing-back'));
    expect(onPlaybooks).toHaveBeenCalled();
  });
});
