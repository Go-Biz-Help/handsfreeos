import { AUTOMATION_DEFAULTS, type AutomationOutput } from '@hfos/core/addons/outreach/automation';
import type { LiveOutput, LiveTeamOutput } from '@hfos/core/addons/outreach/live';
import type { HelpfulListOutput } from '@hfos/core/addons/outreach/helpful';
import type { TodayItem, TodayOutput } from '@hfos/core/addons/outreach/today';
import { blankPlaybook, type Playbook } from '@hfos/core/addons/outreach/playbooks';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { router } from 'expo-router';

import { openWebPath } from '@/home/open';

import { OutreachFrame, OutreachWorkspace } from '../frame';
import { LiveStrip } from '../hub';
import { LiveBody, pressShown } from '../live';
import { OutreachMoreRow } from '../more';
import { isSetUp, WebOnlyBody } from '../page';
import { mergeSection, PlaybookBody, sectionWords } from '../playbook';
import { businessDraftOf, SettingsBody } from '../settings';
import { TodayBody } from '../today';
import { id, ME, TZ, WS } from './mocks';

/**
 * Social Outreach's other screens on the phone (decisions 44 and 59): its one row in More, its four tabs and the gear,
 * the tabs left to the web, Today's strip and the live view with Start my day and Stop for today, Today with posts
 * asking for what the business offers first, the settings, and a playbook changed a part at a time on what's there now.
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
  jest.mocked(router.replace).mockClear();
});

describe('Social Outreach in More and its first screen', () => {
  it('has one row in More, saying what waits, opening the add-on', async () => {
    await render(<OutreachMoreRow workspaceId={WS} messages={3} />);
    expect(screen.getByText('Social Outreach')).toBeTruthy();
    expect(screen.getByText('3 messages wait for your OK')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('more-outreach-open'));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/a/outreach`);
  });

  it('moves between its four tabs in place, and opens Settings and Friends', async () => {
    await render(
      <OutreachWorkspace.Provider value={WS}>
        <OutreachFrame tab="people" people="pipeline" testID="framed" />
      </OutreachWorkspace.Provider>,
    );
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Social Outreach');
    for (const tab of ['today', 'groups', 'results'])
      await fireEvent.press(screen.getByTestId(`outreach-tab-${tab}`));
    await fireEvent.press(screen.getByTestId('outreach-people-chats'));
    // Each tab replaces the screen, rather than stacking another on it.
    expect(jest.mocked(router.replace).mock.calls.map(([href]) => String(href))).toEqual([
      expect.stringContaining('view=today'),
      expect.stringContaining('view=groups'),
      expect.stringContaining('view=results'),
      expect.stringContaining('view=chats'),
    ]);
    await fireEvent.press(screen.getByTestId('outreach-open-settings'));
    await fireEvent.press(screen.getByTestId('outreach-people-friends'));
    expect(jest.mocked(openWebPath).mock.calls.map(([p]) => p)).toEqual(
      ['settings', 'friends'].map((v) => `/app/w/${WS}/a/outreach?view=${v}`),
    );
  });

  it('counts the setup as done only once it’s finished, whether the web’s line was hidden or not', () => {
    expect(isSetUp({ finishedAt: null })).toBe(false);
    expect(isSetUp({ finishedAt: '2026-10-10T15:00:00.000Z' })).toBe(true);
    // No answer yet (no signal): the line waits rather than showing to someone set up.
    expect(isSetUp(null)).toBe(true);
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
    doing: null,
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

const post = (n: number, name: string, asking: boolean): TodayItem => ({
  recent: [],
  kind: 'comment',
  name,
  profileId: id(40 + n),
  profileUrl: `https://www.facebook.com/made.up.${n}`,
  chatId: null,
  threadKey: null,
  postId: id(50 + n),
  postUrl: `https://www.facebook.com/groups/1/posts/${n}/`,
  posted: '20m',
  post: asking ? 'Looking for a CRM for my crew, who do you use?' : 'Any tips for slow months?',
  asking,
  why: [],
  summary: null,
  nextStep: null,
  playbookName: null,
  demoLink: null,
  send: null,
  personId: null,
  demoBooked: false,
});

describe('Today on the phone', () => {
  it('puts posts asking for what the business offers first, apart from the other comments', async () => {
    const today: TodayOutput = {
      limits: LIVE.limits,
      items: [post(1, 'Lee Park', true), post(2, 'Kim Ng', false)],
      readAdmins: [],
      hasPlaybook: true,
      warning: null,
      auto: [],
      messages: [],
      sending: 'off',
      wheels: { on: false, from: null, ok: 0, daysLeft: 0, edits: 0 },
    };
    await render(
      <TodayBody
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
    const asking = screen.getByTestId('today-asking');
    expect(within(asking).getByText('Asking for what you offer · 1')).toBeTruthy();
    expect(within(asking).getByText('Lee Park')).toBeTruthy();
    const comments = screen.getByTestId('today-comment');
    expect(within(comments).getByText('Comment on a post · 1')).toBeTruthy();
    expect(within(comments).queryByText('Lee Park')).toBeNull();
  });

  it('shows today’s helpful post, OKs it for the computer, or puts it aside', async () => {
    const actions = { write: jest.fn(), ok: jest.fn(), posted: jest.fn(), skip: jest.fn() };
    const today: TodayOutput = {
      limits: LIVE.limits,
      items: [],
      readAdmins: [],
      hasPlaybook: true,
      warning: null,
      auto: [],
      messages: [],
      sending: 'off',
      wheels: { on: false, from: null, ok: 0, daysLeft: 0, edits: 0 },
    };
    const helpful: HelpfulListOutput = {
      posts: [
        {
          helpfulId: id(60),
          groupId: id(61),
          groupName: 'Texas Contractors Network',
          groupUrl: 'https://www.facebook.com/groups/texascontractors/',
          playbookName: 'CRM demos',
          state: 'draft',
          how: 'after_ok',
          topic: 'Following up on quotes',
          text: 'I follow up on every quote two days later.',
          postUrl: null,
          whyNot: null,
          askedAt: new Date(NOW).toISOString(),
          postedAt: null,
          comments: 0,
          reactions: 0,
        },
      ],
      today: 1,
      perDay: 1,
      posting: 'after_ok',
    };
    await render(
      <TodayBody
        today={today}
        helpful={helpful}
        onHelpful={actions}
        error={null}
        wheels={null}
        onRetry={jest.fn()}
        onOk={jest.fn()}
        onSkip={jest.fn()}
        onNotForMe={jest.fn()}
        onEndWheels={jest.fn()}
      />,
    );
    const part = screen.getByTestId('today-helpful');
    expect(
      within(part).getByText('Texas Contractors Network · Following up on quotes'),
    ).toBeTruthy();
    expect(within(part).getByText('I follow up on every quote two days later.')).toBeTruthy();
    // Today's is written: no second.
    expect(screen.queryByTestId('today-helpful-write')).toBeNull();
    await fireEvent.press(screen.getByTestId('today-helpful-ok'));
    expect(actions.ok).toHaveBeenCalledWith(id(60));
    await fireEvent.press(screen.getByTestId('today-helpful-skip'));
    expect(actions.skip).toHaveBeenCalledWith(id(60));
  });
});

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
    expect(screen.getByText('Needs you: 4')).toBeTruthy();
    expect(screen.getByText('Liked a post')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('live-start'));
    await fireEvent.press(screen.getByTestId('live-stop'));
    expect(h.onStart).toHaveBeenCalled();
    expect(h.onStop).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('live-waiting'));
    expect(h.onWaiting).toHaveBeenCalled();
  });

  it('before the first day, lists each step with ticks, the one under way showing its progress', async () => {
    const h = liveHandlers();
    const saved = new Date(NOW - 60_000).toISOString();
    await render(
      <LiveBody
        live={{
          ...LIVE,
          day: { ...LIVE.day, state: 'started', via: 'web', at: saved },
          status: {
            ...LIVE.status!,
            line: '3 of 8 groups checked. Reading Lake Homes…',
            doing: 'group_checks',
          },
          lists: {
            friendsAt: saved,
            requestsAt: saved,
            sentAt: saved,
            groupsAt: saved,
            groupChecksAt: null,
            tidyAt: null,
            checksAt: null,
          },
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
    expect(screen.getByTestId('live-pre-day')).toHaveTextContent(/4 of 7 done/);
    expect(screen.getByTestId('live-pre-day-friends')).toHaveTextContent(/Save your friends list/);
    expect(screen.getByTestId('live-pre-day-friends')).toHaveTextContent(/Done/);
    expect(screen.getByTestId('live-pre-day-group_checks')).toHaveTextContent(
      /Check your groups.*3 of 8 groups checked/,
    );
    expect(screen.getByTestId('live-pre-day-checks')).toHaveTextContent(/To come/);
  });

  it('sums the computer up at the top of Today: its state, today’s steps, Start my day and Details', async () => {
    const h = liveHandlers();
    const onDetails = jest.fn();
    await render(
      <LiveStrip
        live={LIVE}
        error={null}
        online
        now={NOW}
        pressed={null}
        onDetails={onDetails}
        {...h}
      />,
    );
    expect(screen.getByTestId('live-state')).toHaveTextContent('Working');
    expect(screen.getByText('Liking a post of Dana Reyes’s')).toBeTruthy();
    expect(screen.getByTestId('today-limit-like')).toHaveTextContent(/^Likes7 \/ 40$/);
    await fireEvent.press(screen.getByTestId('live-start'));
    expect(h.onStart).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('today-status-details'));
    expect(onDetails).toHaveBeenCalled();
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
  startedAt: null,
  saved: false,
  wheels: { on: false, from: null, ok: 0, daysLeft: 7, edits: 0 },
  userId: ME,
  name: 'Dana Reyes',
  changedBy: null,
  rules: {
    sendingAllowed: ['off', 'steps'],
    repliesAllowed: ['draft'],
    postingAllowed: ['copy'],
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

  it('sets where the team gets the extension, checked as the save checks it', async () => {
    const p = props();
    await render(
      <SettingsBody
        automation={AUTOMATION}
        {...p}
        manages
        business={{ contactsFromChats: 'tagged', extensionLink: 'http://old.example.test/x.zip' }}
      />,
    );
    expect(screen.getByText('Where your team gets the extension')).toBeTruthy();
    // A stored link that stopped passing reads as none.
    expect(screen.getByTestId('settings-extension-link-input').props.value).toBe('');
    await fireEvent.changeText(
      screen.getByTestId('settings-extension-link-input'),
      'http://files.example.test/social.zip',
    );
    await fireEvent.press(screen.getByTestId('settings-extension-link-save'));
    expect(
      screen.getByText(
        'That isn’t a whole link starting https://. Paste the https link to the extension’s zip.',
      ),
    ).toBeTruthy();
    expect(p.onSaveBusiness).not.toHaveBeenCalled();
    await fireEvent.changeText(
      screen.getByTestId('settings-extension-link-input'),
      ' https://files.example.test/social.zip ',
    );
    await fireEvent.press(screen.getByTestId('settings-extension-link-save'));
    expect(p.onSaveBusiness).toHaveBeenCalledWith(
      { extensionLink: 'https://files.example.test/social.zip' },
      'Saved. Everyone’s setup shows the link.',
    );
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
