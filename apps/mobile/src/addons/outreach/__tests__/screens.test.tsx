import type { LiveOutput, LiveTeamOutput } from '@hfos/core/addons/outreach/live';
import type { HelpfulListOutput } from '@hfos/core/addons/outreach/helpful';
import type { StagesOutput } from '@hfos/core/addons/outreach/stages';
import type { TodayItem, TodayOutput } from '@hfos/core/addons/outreach/today';
import { blankPlaybook, type Playbook } from '@hfos/core/addons/outreach/playbooks';
import { VIDEO_PART_KEYS } from '@hfos/core/addons/outreach/video';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as React from 'react';

import { router } from 'expo-router';

import { openWebPath } from '@/home/open';

import { OutreachFrame, OutreachWorkspace } from '../frame';
import { LiveStrip } from '../hub';
import { LiveBody, pressShown, startRefusedOf } from '../live';
import { OutreachMoreRow } from '../more';
import { isSetUp, WebOnlyBody } from '../page';
import { PersonMenuScope } from '../person-menu';
import { PipelineBody } from '../pipeline';
import { mergeSection, PlaybookBody, sectionsOf, sectionWords } from '../playbook';
import { TodayBody } from '../today';
import { id, TZ, WS } from './mocks';

/**
 * Social Outreach's other screens on the phone (decisions 44 and 59): its one row in More, its four tabs and the gear,
 * the tabs left to the web, Today's strip and the live view with Start my day and Stop for today, Today with posts
 * asking for what the business offers first, each name opening the person menu, the Pipeline's Client stage, and a
 * playbook changed a part at a time on what's there now. Settings have their own file (./settings.test.tsx).
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
  videoLink: null,
  send: null,
  personId: null,
  demoBooked: false,
});

describe('Today on the phone', () => {
  it('puts posts asking for what the business offers first, apart from the other comments', async () => {
    const today: TodayOutput = {
      limits: LIVE.limits,
      items: [post(1, 'Lee Park', true), post(2, 'Kim Ng', false)],
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

  it('puts LinkedIn’s helpful post on the person’s own feed, to copy and post there', async () => {
    const actions = { write: jest.fn(), ok: jest.fn(), posted: jest.fn(), skip: jest.fn() };
    const today: TodayOutput = {
      limits: LIVE.limits,
      items: [],
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
    const helpful: HelpfulListOutput = {
      posts: [
        {
          helpfulId: id(70),
          platform: 'linkedin',
          groupId: null,
          groupName: null,
          groupUrl: null,
          playbookName: 'CRM demos',
          state: 'draft',
          how: 'copy',
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
      posting: 'copy',
    };
    await render(
      <TodayBody
        platform="linkedin"
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
    expect(within(part).getByText('One helpful post a day, on your own feed.')).toBeTruthy();
    expect(within(part).getByText('Your LinkedIn feed · Following up on quotes')).toBeTruthy();
    expect(
      within(part).getByText(
        'Copy it, post it on your LinkedIn feed yourself, then press I posted it.',
      ),
    ).toBeTruthy();
    expect(within(part).getByTestId('today-helpful-open')).toHaveTextContent('Open LinkedIn');
    expect(within(part).queryByText(/group/i)).toBeNull();
    await fireEvent.press(screen.getByTestId('today-helpful-posted'));
    expect(actions.posted).toHaveBeenCalledWith(id(70));
  });
});

const todayOf = (items: TodayItem[], partners: TodayItem[] = []): TodayOutput => ({
  limits: LIVE.limits,
  items,
  partners,
  readAdmins: [],
  hasPlaybook: true,
  warning: null,
  auto: [],
  messages: [],
  sending: 'off',
  wheels: { on: false, from: null, ok: 0, daysLeft: 0, edits: 0 },
  ready: true,
  week: null,
});

const stagePerson = (
  n: number,
  name: string,
  stage: StagesOutput['people'][number]['stage'],
): StagesOutput['people'][number] => ({
  profileId: id(80 + n),
  personId: stage === 'client' ? id(90 + n) : null,
  name,
  url: `https://www.facebook.com/made.up.${n}`,
  platform: 'facebook',
  stage,
  why: stage === 'client' ? ['A client in Contacts: they’re tagged Client'] : [],
  nextStep: null,
  lastAt: null,
  threadKey: null,
  marked: false,
  demoBooked: false,
  check: null,
});

describe('Names open the person menu', () => {
  // With no signal, so the menu asks HandsFreeOS nothing: its Open items work all the same.
  const scoped = (children: React.ReactNode) => (
    <PersonMenuScope workspaceId={WS} online={false} writesContacts onChanged={jest.fn()}>
      {children}
    </PersonMenuScope>
  );

  it('makes each name on Today a button that opens it, with no “…” beside it; a partner’s stays words', async () => {
    const partner = {
      ...post(3, 'Sam Partner', false),
      kind: 'opener' as const,
      partnerId: id(99),
    };
    await render(
      scoped(
        <TodayBody
          today={todayOf([post(1, 'Lee Park', true), post(2, 'Kim Ng', false)], [partner])}
          error={null}
          wheels={null}
          onRetry={jest.fn()}
          onOk={jest.fn()}
          onSkip={jest.fn()}
          onNotForMe={jest.fn()}
          onEndWheels={jest.fn()}
        />,
      ),
    );
    expect(screen.queryByText('…')).toBeNull();
    expect(screen.queryByLabelText('More for Lee Park')).toBeNull();
    const names = screen.getAllByTestId('person-menu');
    expect(names.map((n) => n.props.accessibilityLabel)).toEqual(['Lee Park', 'Kim Ng']);
    expect(within(screen.getByTestId('today-partners')).getByText('Sam Partner')).toBeTruthy();
    await fireEvent.press(names[0]!);
    expect(screen.getByTestId('person-menu-sheet')).toBeTruthy();
    expect(screen.getByTestId('person-open-page')).toHaveTextContent('Open on Facebook');
  });

  it('shows the Pipeline’s Client chip and badge, with no moves for a client, and the name opens the menu', async () => {
    const onView = jest.fn();
    const pipeline: StagesOutput = {
      counts: {
        all: 1,
        found: 0,
        warming: 1,
        friends: 0,
        talking: 0,
        ready: 0,
        pitched: 0,
        booked: 0,
        client: 1,
        lost: 0,
      },
      people: [stagePerson(1, 'Rowan Client', 'client'), stagePerson(2, 'Avery Warm', 'warming')],
      page: 1,
      pages: 1,
      total: 2,
    };
    const body = (view: 'all' | 'client') =>
      scoped(
        <PipelineBody
          view={view}
          onView={onView}
          search=""
          onSearch={jest.fn()}
          pipeline={pipeline}
          error={null}
          onRetry={jest.fn()}
          onMore={jest.fn()}
          onMark={jest.fn()}
        />,
      );
    const { rerender } = await render(body('all'));
    expect(screen.getByTestId('pipeline-show-client')).toHaveTextContent('Client 1');
    await fireEvent.press(screen.getByTestId('pipeline-show-client'));
    expect(onView).toHaveBeenCalledWith('client');
    const [client, warm] = screen.getAllByTestId('pipeline-person');
    expect(within(client!).getByTestId('pipeline-stage')).toHaveTextContent('Client');
    // Good news, in the success colour, as on the web.
    expect(within(client!).getByTestId('pipeline-stage').props.className).toContain(
      'bg-success-soft',
    );
    expect(within(client!).getByText('A client in Contacts: they’re tagged Client')).toBeTruthy();
    expect(within(client!).queryByTestId(/^pipeline-mark-/)).toBeNull();
    expect(within(warm!).getAllByTestId(/^pipeline-mark-/).length).toBeGreaterThan(0);
    expect(screen.queryByText('…')).toBeNull();
    await fireEvent.press(within(client!).getByTestId('person-menu'));
    expect(screen.getByTestId('person-menu-sheet')).toBeTruthy();
    await rerender(body('client'));
    expect(screen.getByText(/^A client gets no outreach/)).toBeTruthy();
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
      platform: 'facebook',
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

  it('tells an owner or admin where to allow it when the business allows only Off, never to ask an owner', async () => {
    const onGeneral = jest.fn();
    await render(
      <LiveBody
        live={{ ...LIVE, sending: 'off', canSend: false }}
        at={NOW}
        error={null}
        team={null}
        online
        now={NOW}
        pressed={null}
        manages
        onGeneral={onGeneral}
        {...liveHandlers()}
      />,
    );
    expect(screen.getByTestId('live-sending-off')).toHaveTextContent(
      /Allow it for your team in Settings → General\.$/,
    );
    expect(screen.queryByText(/Ask an owner/)).toBeNull();
    await fireEvent.press(screen.getByTestId('live-general'));
    expect(onGeneral).toHaveBeenCalled();
  });

  it('holds Start while something holds the day, saying what and where, as Today’s strip does', async () => {
    const h = liveHandlers();
    const held = 'Your numbers aren’t set yet. Finish it under Get ready on the Today tab.';
    await render(
      <LiveBody
        live={LIVE}
        at={NOW}
        error={null}
        team={null}
        online
        now={NOW}
        pressed={null}
        ready={false}
        held={held}
        {...h}
      />,
    );
    expect(screen.getByTestId('live-start')).toBeDisabled();
    expect(screen.getByTestId('live-not-ready')).toHaveTextContent(held);
    await fireEvent.press(screen.getByTestId('live-start'));
    expect(h.onStart).not.toHaveBeenCalled();
  });

  it('keeps a refused Start beside the button, in HandsFreeOS’s words, with Do it now where it’s fixed', async () => {
    const fix = jest.fn();
    const words =
      'LinkedIn is off for you, so there’s no day to start there. Turn it on under Social Outreach → Settings → LinkedIn.';
    const view = await render(
      <LiveStrip
        platform="linkedin"
        live={LIVE}
        error={null}
        online
        now={NOW}
        pressed={null}
        refused={{ words, fix }}
        onDetails={jest.fn()}
        {...liveHandlers()}
      />,
    );
    const note = screen.getByTestId('live-start-refused');
    expect(within(note).getByText(words)).toBeTruthy();
    await fireEvent.press(within(note).getByTestId('live-start-fix'));
    expect(fix).toHaveBeenCalled();
    // Nothing to press when nothing fixes it here (a warning today): the words alone.
    await view.rerender(
      <LiveBody
        live={LIVE}
        at={NOW}
        error={null}
        team={null}
        online
        now={NOW}
        pressed={null}
        refused={{ words: 'Facebook showed you a warning today.', fix: null }}
        {...liveHandlers()}
      />,
    );
    expect(screen.getByTestId('live-start-refused')).toHaveTextContent(
      'Facebook showed you a warning today.',
    );
    expect(screen.queryByTestId('live-start-fix')).toBeNull();
  });

  it('sends each refused Start to where the phone fixes it, by its rule and details', () => {
    const to = { manages: true, onSettings: jest.fn(), onToday: jest.fn() };
    const refusal = (rule: string, details: unknown, reason = 'Words.') => ({
      reason,
      rule,
      answer: JSON.stringify({
        error: { code: 'rule_violation', message: reason, rule, details, disposition: 'final' },
      }),
    });
    // The person's own choice there, and the networks they use: the network's page of Settings.
    startRefusedOf(
      refusal('outreach_sending_off', { platform: 'linkedin', allowed: true }),
      'linkedin',
      to,
    ).fix!();
    expect(to.onSettings).toHaveBeenLastCalledWith('linkedin');
    startRefusedOf(
      refusal('outreach_network_off', { platform: 'linkedin', allowed: true }),
      'linkedin',
      to,
    ).fix!();
    expect(to.onSettings).toHaveBeenLastCalledWith('linkedin');
    // A business that allows only Off: General, for an owner or admin; nothing to press for anyone else.
    startRefusedOf(
      refusal('outreach_sending_off', { platform: 'linkedin', allowed: false }),
      'linkedin',
      to,
    ).fix!();
    expect(to.onSettings).toHaveBeenLastCalledWith('general');
    expect(
      startRefusedOf(
        refusal('outreach_sending_off', { platform: 'linkedin', allowed: false }),
        'linkedin',
        { ...to, manages: false },
      ).fix,
    ).toBeNull();
    // A network the business doesn't use: its own page, where the team's say on it is.
    startRefusedOf(
      refusal('outreach_network_off', { platform: 'linkedin', allowed: false }),
      'linkedin',
      to,
    ).fix!();
    expect(to.onSettings).toHaveBeenLastCalledWith('linkedin');
    // Get ready's items: under Get ready on Today, with the words kept as HandsFreeOS said them.
    const numbers = startRefusedOf(
      refusal('outreach_not_ready', { item: 'numbers', platform: 'facebook' }, 'Set a goal.'),
      'facebook',
      to,
    );
    expect(numbers.words).toBe('Set a goal.');
    numbers.fix!();
    expect(to.onToday).toHaveBeenCalled();
    // A warning today: nothing fixes it.
    expect(
      startRefusedOf(refusal('outreach_warned_today', undefined), 'facebook', to).fix,
    ).toBeNull();
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
    // The short video: its link, and the script written on the computer, part by part.
    expect(sectionWords(PLAYBOOK.details, 'video')).toBe(
      'No video yet\n\nWrite the script on your computer, under Playbooks in HandsFreeOS.',
    );
    const scripted = sectionWords(
      {
        ...PLAYBOOK.details,
        videoLink: 'https://www.loom.com/share/abc123',
        videoScript: {
          parts: VIDEO_PART_KEYS.map((part) => ({ part, say: `Say ${part}.`, show: 'You' })),
          at: '2026-10-15T09:00:00.000Z',
          version: 1,
        },
      },
      'video',
    );
    expect(scripted).toContain('https://www.loom.com/share/abc123');
    expect(scripted).toContain('1 · Who it’s for, and the problem\nSay who.\nShow: You');
  });

  it('shows each network’s own words on a customers’ playbook that runs there, and what an emptied list means', () => {
    const details = {
      ...PLAYBOOK.details,
      platforms: ['facebook' as const, 'instagram' as const, 'alignable' as const],
      hashtags: ['austinroofing', 'hailrepair'],
      businessKinds: [],
      wordsWritten: ['instagram' as const, 'alignable' as const],
      worksOnline: true,
    };
    expect(sectionsOf(details)).toEqual(
      expect.arrayContaining(['hashtags', 'businessKinds', 'worksOnline']),
    );
    expect(sectionsOf(details)).not.toContain('postSearches');
    expect(sectionsOf({ ...details, goal: 'partner' })).not.toContain('hashtags');
    expect(sectionWords(details, 'hashtags')).toBe('#austinroofing\n#hailrepair');
    expect(sectionWords(details, 'businessKinds')).toBe(
      'Alignable won’t search for businesses for this playbook.',
    );
    expect(sectionWords({ ...details, wordsWritten: [] }, 'businessKinds')).toBe('Nothing yet.');
    expect(sectionWords(details, 'worksOnline')).toBe(
      'You work with clients online, so Alignable searches anywhere.',
    );
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
