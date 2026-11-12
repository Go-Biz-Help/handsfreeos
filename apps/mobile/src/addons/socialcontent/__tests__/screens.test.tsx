import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { Creator, Post } from '@hfos/core/addons/socialcontent/shapes';
import * as React from 'react';

import { change } from '@/changes';
import { openWebPath } from '@/home/open';
import { workerPost } from '@/lib/worker';

import { CalendarBody } from '../calendar';
import { CreatorsBody, creatorsActions, type CreatorsActions } from '../creators';
import { pageDetail, SocialcontentHomeBody } from '../home';
import { IdeasBody } from '../ideas';
import { SocialcontentMoreRow } from '../more';
import { draftOf, PostBody, saveInput, type PostActions, type PostDraft } from '../own-post';
import { PlaybookBody } from '../playbook';
import { SettingsBody, settingsActions, type SettingsActions } from '../settings';
import { StandoutsBody } from '../standouts';
import {
  ago,
  calendarView,
  content,
  creator,
  id,
  idea,
  ME,
  niche,
  NOW,
  overview,
  playbook,
  post,
  work,
  WS,
} from './mocks';

/**
 * AI Social Media Content Creator on the phone (docs/socialcontent.md, parts 5 and 12): its one row in More, its first
 * screen listing its pages, Creators (what it's doing, niches, the three lists and a creator's posts), Standouts with
 * their filters, the Playbook, Ideas, the Calendar and one of its posts, and Settings, where watching videos asks again
 * before it's turned on. Each says it needs signal when there's none.
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
jest.mock('@/lib/worker', () => ({ workerPost: jest.fn(async () => ({ added: 2 })) }));
jest.mock('@/home/open', () => ({ openWebPath: jest.fn() }));
jest.mock('expo-linking', () => ({ openURL: jest.fn(async () => true) }));
jest.mock('@/inbox/storage', () => ({
  signedUrl: jest.fn(async () => 'https://storage.test/picture.jpg'),
}));
jest.mock('@/components/shell/screen', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Screen: require('./mocks').TestScreen,
}));

beforeEach(() => {
  jest.mocked(openWebPath).mockClear();
  jest.mocked(change).mockClear();
  jest.mocked(workerPost).mockClear();
});

function creatorsActionsMock(): jest.Mocked<CreatorsActions> {
  return {
    findNow: jest.fn(),
    suggestNiches: jest.fn(),
    addNiche: jest.fn(async (_name: string) => true),
    decideNiche: jest.fn(),
    addCreator: jest.fn(async (_link: string) => true),
    decideCreator: jest.fn(),
    readAgain: jest.fn(),
    posts: jest.fn(async (_creator: Creator): Promise<readonly Post[] | null> => [post(10)]),
    openSettings: jest.fn(),
  };
}

describe('its row in More and its first screen', () => {
  it('has one row in More, opening the add-on’s first screen', async () => {
    await render(<SocialcontentMoreRow workspaceId={WS} />);
    expect(screen.getByText('AI Social Media Content Creator')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('more-socialcontent-open'));
    expect(openWebPath).toHaveBeenCalledWith(`/app/w/${WS}/a/socialcontent`);
  });

  it('lists its six pages with their counts, and opens each', async () => {
    const onOpen = jest.fn();
    await render(<SocialcontentHomeBody overview={overview()} onOpen={onOpen} />);
    for (const page of ['creators', 'standouts', 'playbook', 'ideas', 'calendar', 'settings'])
      expect(screen.getByTestId(`socialcontent-open-${page}`)).toBeTruthy();
    expect(screen.getByText('1 creator studied · 2 to tick')).toBeTruthy();
    expect(screen.getByText('4 standouts')).toBeTruthy();
    expect(screen.queryByTestId('socialcontent-home-needs-reader')).toBeNull();
    expect(screen.getByText('Your own posts, two weeks ahead, and how they did')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('socialcontent-open-standouts'));
    expect(onOpen).toHaveBeenCalledWith('standouts');
    await fireEvent.press(screen.getByTestId('socialcontent-open-calendar'));
    expect(onOpen).toHaveBeenCalledWith('calendar');
  });

  it('still lists the pages with no signal, and says when no computer reads', async () => {
    expect(pageDetail('creators', null)).toBe('Your niches, and the creators found in them');
    await render(
      <SocialcontentHomeBody
        overview={overview({
          settings: { ...overview().settings, readerUserId: null, readerName: null },
        })}
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByTestId('socialcontent-home-needs-reader')).toHaveTextContent(
      /No computer reads the networks yet/,
    );
  });
});

describe('Creators', () => {
  const data = {
    overview: overview({
      work: [
        work(70, {
          state: 'taken',
          takenAt: ago(3),
          progress: { now: 'Searching Instagram for #crm', searched: ['#crm'], searches: 4 },
        }),
        work(71, {
          state: 'done',
          finishedAt: ago(30),
          progress: { profiles: 12, suggested: 3, didntFit: 9 },
        }),
      ],
      counts: { suggested: 2, studying: 1, skipped: 0, standouts: 4, waiting: 2 },
    }),
    niches: [
      niche(1, { name: 'CRM software', own: true, state: 'picked' }),
      niche(2, { name: 'Sales automation' }),
    ],
    creators: [
      creator(1),
      creator(2),
      creator(3, {
        state: 'studying',
        postsReadAt: ago(60),
        postsCount: 40,
        standoutsCount: 4,
      }),
    ],
  };
  const body = (props: Partial<React.ComponentProps<typeof CreatorsBody>> = {}) => (
    <CreatorsBody
      data={data}
      error={null}
      online
      busy={null}
      now={NOW}
      onRetry={jest.fn()}
      actions={creatorsActionsMock()}
      {...props}
    />
  );

  it('says what the reading computer is doing now and did lately', async () => {
    await render(body());
    expect(screen.getByTestId('socialcontent-reader')).toHaveTextContent(
      'Reading on Chris’s computer · checked in 2 minutes ago · extension 0.128.2',
    );
    expect(screen.getByTestId(`socialcontent-now-${id(70)}`)).toHaveTextContent(
      /Find creators for “CRM software” on Instagram.*Searching Instagram for #crm.*Searched 1 of 4: #crm/,
    );
    expect(screen.getByText('1 more thing waiting')).toBeTruthy();
    expect(screen.getByTestId(`socialcontent-lately-${id(71)}`)).toHaveTextContent(
      /Done · 30 minutes ago.*Read 12 profiles.*3 suggested, 9 didn’t fit/,
    );
  });

  it('opens on Suggested, and ticks, skips and studies creators', async () => {
    const actions = creatorsActionsMock();
    await render(body({ actions }));
    expect(screen.getByTestId('socialcontent-tab-suggested')).toHaveTextContent('Suggested (2)');
    const first = screen.getByTestId('socialcontent-creator-creator_1');
    expect(first).toHaveTextContent(/Posts short tips about sales follow-ups/);
    await fireEvent.press(within(first).getByTestId('socialcontent-creator-study'));
    expect(actions.decideCreator).toHaveBeenCalledWith(data.creators[0], true);
    await fireEvent.press(
      within(screen.getByTestId('socialcontent-creator-creator_2')).getByTestId(
        'socialcontent-creator-skip',
      ),
    );
    expect(actions.decideCreator).toHaveBeenLastCalledWith(data.creators[1], false);
  });

  it('shows a studied creator’s posts in a sheet, with how far past their normal each did', async () => {
    const actions = creatorsActionsMock();
    await render(body({ actions }));
    await fireEvent.press(screen.getByTestId('socialcontent-tab-studying'));
    const studied = screen.getByTestId('socialcontent-creator-creator_3');
    expect(within(studied).getByTestId('socialcontent-creator-read')).toHaveTextContent(
      '40 posts read · 4 standouts · read today',
    );
    await fireEvent.press(within(studied).getByTestId('socialcontent-creator-read-again'));
    expect(actions.readAgain).toHaveBeenCalledWith(data.creators[2]);
    await fireEvent.press(within(studied).getByTestId('socialcontent-creator-posts'));
    expect(actions.posts).toHaveBeenCalledWith(data.creators[2]);
    await waitFor(() => expect(screen.getByTestId('socialcontent-post-code10')).toBeTruthy());
    const card = screen.getByTestId('socialcontent-post-code10');
    expect(within(card).getByTestId('post-views')).toHaveTextContent(
      '31,000 views · 3.1 times their normal',
    );
    expect(card).toHaveTextContent(/Standout · On views/);
    expect(within(card).getByTestId('socialcontent-notes-code10')).toHaveTextContent(
      /A question in the first line stops the scroll/,
    );
  });

  it('suggests, adds, searches and skips niches', async () => {
    const actions = creatorsActionsMock();
    await render(body({ actions }));
    const niches = screen.getByTestId('socialcontent-niches');
    expect(niches).toHaveTextContent(/Your niche.*CRM software.*Similar niches.*Sales automation/);
    await fireEvent.press(within(niches).getByTestId('socialcontent-suggest-niches'));
    expect(actions.suggestNiches).toHaveBeenCalled();
    const [own, similar] = within(niches).getAllByTestId('socialcontent-niche');
    expect(within(own!).queryByTestId('socialcontent-niche-pick')).toBeNull();
    await fireEvent.press(within(similar!).getByTestId('socialcontent-niche-pick'));
    expect(actions.decideNiche).toHaveBeenCalledWith(data.niches[1], 'picked');
    await fireEvent.changeText(screen.getByTestId('socialcontent-add-niche'), 'Real estate tech');
    await fireEvent.press(screen.getByTestId('socialcontent-add-niche-go'));
    expect(actions.addNiche).toHaveBeenCalledWith('Real estate tech');
  });

  it('adds a creator from a link, then shows who’s studied', async () => {
    const actions = creatorsActionsMock();
    await render(body({ actions }));
    await fireEvent.changeText(
      screen.getByTestId('socialcontent-add-link'),
      ' https://www.instagram.com/newone/ ',
    );
    await fireEvent.press(screen.getByTestId('socialcontent-add-link-go'));
    expect(actions.addCreator).toHaveBeenCalledWith('https://www.instagram.com/newone/');
    await waitFor(() => expect(screen.getByTestId('socialcontent-creator-creator_3')).toBeTruthy());
  });

  it('can’t press anything with no signal, and says when nobody reads', async () => {
    await render(
      body({
        online: false,
        data: {
          ...data,
          overview: overview({
            settings: { ...overview().settings, readerUserId: null, readerName: null },
          }),
        },
      }),
    );
    expect(screen.getByTestId('socialcontent-find')).toBeDisabled();
    expect(screen.getByTestId('socialcontent-needs-reader')).toBeTruthy();
    expect(screen.queryByTestId('socialcontent-activity')).toBeNull();
  });

  it('says it needs signal with none, with Try again', async () => {
    const onRetry = jest.fn();
    await render(
      body({
        data: null,
        error: 'Creators needs signal. Try again when you’re back online.',
        onRetry,
      }),
    );
    expect(screen.getByTestId('socialcontent-creators-needs-signal')).toHaveTextContent(
      /Creators needs signal/,
    );
    await fireEvent.press(screen.getByTestId('socialcontent-retry'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('sends each press as its command, or the worker’s action, and says how it went', async () => {
    const act = jest.fn(async (_key: string, run: () => Promise<unknown>, _done?: unknown) =>
      run(),
    );
    jest.mocked(change).mockResolvedValueOnce({
      id: 'c',
      queued: false,
      output: { networks: ['instagram'], niches: 2 },
    } as never);
    const actions = creatorsActions(WS, act as never);
    actions.findNow();
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('socialcontent.find.now', { workspaceId: WS }),
    );
    expect(act.mock.calls[0]![0]).toBe('find');
    const done = act.mock.calls[0]![2] as unknown as (out: unknown) => string;
    expect(done({ networks: ['instagram'], niches: 2 })).toBe(
      'Looking for creators on Instagram in 2 niches. Your reading computer works on it while Chrome is open.',
    );
    actions.suggestNiches();
    await waitFor(() =>
      expect(workerPost).toHaveBeenCalledWith(
        '/v1/addons/socialcontent/actions/socialcontent.niches.suggest',
        { workspaceId: WS, input: {} },
      ),
    );
    actions.decideCreator(creator(4), true);
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith('socialcontent.creator.decide', {
        workspaceId: WS,
        creatorId: id(4),
        study: true,
      }),
    );
  });
});

describe('Standouts', () => {
  const studied = [
    creator(1, { state: 'studying' }),
    creator(2, { state: 'studying', network: 'linkedin', handle: 'li_two', shown: 'li_two' }),
  ];
  const body = (props: Partial<React.ComponentProps<typeof StandoutsBody>> = {}) => (
    <StandoutsBody
      data={{ posts: [post(1), post(2)], more: true, creators: studied }}
      error={null}
      online
      network={null}
      creatorId={null}
      loadingMore={false}
      onRetry={jest.fn()}
      onNetwork={jest.fn()}
      onCreator={jest.fn()}
      onMore={jest.fn()}
      {...props}
    />
  );

  it('lists the standouts, newest first, and shows more', async () => {
    const onMore = jest.fn();
    await render(body({ onMore }));
    expect(screen.getByTestId('socialcontent-post-code1')).toHaveTextContent(
      /Creator 1 · @creator_1 · Instagram · Video/,
    );
    await fireEvent.press(screen.getByTestId('socialcontent-standouts-more'));
    expect(onMore).toHaveBeenCalled();
  });

  it('keeps to a network, or to one creator picked from a sheet', async () => {
    const onNetwork = jest.fn();
    const onCreator = jest.fn();
    await render(body({ onNetwork, onCreator }));
    await fireEvent.press(screen.getByTestId('socialcontent-standouts-network-linkedin'));
    expect(onNetwork).toHaveBeenCalledWith('linkedin');
    await fireEvent.press(screen.getByTestId('socialcontent-standouts-creator'));
    await fireEvent.press(screen.getByTestId('socialcontent-standouts-pick-li_two'));
    expect(onCreator).toHaveBeenCalledWith(id(2));
  });

  it('says when there are none yet', async () => {
    await render(body({ data: { posts: [], more: false, creators: [] } }));
    expect(screen.getByTestId('socialcontent-standouts-none')).toHaveTextContent(
      /No standouts yet/,
    );
    expect(screen.queryByTestId('socialcontent-standouts-creator')).toBeNull();
  });
});

describe('the Playbook', () => {
  const examples = [
    {
      id: id(50),
      link: 'https://www.instagram.com/p/x/',
      network: 'instagram' as const,
      kind: 'video' as const,
      creatorShown: '@creator_1',
    },
  ];

  it('shows the summary, when it was written, and each thing to do with its standouts', async () => {
    const onWrite = jest.fn();
    await render(
      <PlaybookBody
        data={{ playbook: playbook(), examples }}
        error={null}
        online
        writing={false}
        onRetry={jest.fn()}
        onWrite={onWrite}
      />,
    );
    expect(screen.getByText('Short videos that open with a question do best.')).toBeTruthy();
    expect(screen.getByTestId('socialcontent-playbook-when')).toHaveTextContent(
      'Written 2 days ago from 4 standouts. 2 standouts noted since.',
    );
    expect(screen.getByTestId('socialcontent-playbook-section')).toHaveTextContent(
      /Hooks.*Open with a question.*It stops the scroll.*From.*@creator_1 · Video/,
    );
    await fireEvent.press(screen.getByTestId('socialcontent-playbook-write'));
    expect(onWrite).toHaveBeenCalled();
  });

  it('says there’s none yet, with nothing to write it from', async () => {
    await render(
      <PlaybookBody
        data={{
          playbook: playbook({ sections: [], writtenAt: null, noted: 0, standouts: 0 }),
          examples: [],
        }}
        error={null}
        online
        writing={false}
        onRetry={jest.fn()}
        onWrite={jest.fn()}
      />,
    );
    expect(screen.getByTestId('socialcontent-playbook-none')).toBeTruthy();
    expect(screen.queryByTestId('socialcontent-playbook-write')).toBeNull();
  });
});

describe('Ideas', () => {
  it('opens on New, and saves, uses or skips an idea', async () => {
    const onDecide = jest.fn();
    const ideas = [idea(1), idea(2, { state: 'saved' })];
    await render(
      <IdeasBody
        data={{ ideas, examples: [], hasPlaybook: true }}
        error={null}
        online
        busy={null}
        onRetry={jest.fn()}
        onGet={jest.fn()}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByTestId('socialcontent-ideas-tab-new')).toHaveTextContent('New (1)');
    const card = screen.getByTestId(`socialcontent-idea-${id(1)}`);
    expect(card).toHaveTextContent(/Idea 1.*Hook: “Still chasing leads by hand\?”/);
    await fireEvent.press(within(card).getByTestId('socialcontent-idea-saved'));
    expect(onDecide).toHaveBeenCalledWith(ideas[0], 'saved');
    await fireEvent.press(screen.getByTestId('socialcontent-ideas-tab-saved'));
    const saved = screen.getByTestId(`socialcontent-idea-${id(2)}`);
    expect(within(saved).queryByTestId('socialcontent-idea-saved')).toBeNull();
    await fireEvent.press(within(saved).getByTestId('socialcontent-idea-used'));
    expect(onDecide).toHaveBeenLastCalledWith(ideas[1], 'used');
  });

  it('says ideas come from the Playbook while there isn’t one', async () => {
    await render(
      <IdeasBody
        data={{ ideas: [], examples: [], hasPlaybook: false }}
        error={null}
        online
        busy={null}
        onRetry={jest.fn()}
        onGet={jest.fn()}
        onDecide={jest.fn()}
      />,
    );
    expect(screen.getByTestId('socialcontent-ideas-none')).toHaveTextContent(
      /Ideas come from the Playbook/,
    );
    expect(screen.queryByTestId('socialcontent-ideas-get')).toBeNull();
  });

  it('gets no ideas until the main offer is live (pick 7b)', async () => {
    await render(
      <IdeasBody
        data={{ ideas: [], examples: [], hasPlaybook: true, offerLive: false }}
        error={null}
        online
        busy={null}
        onRetry={jest.fn()}
        onGet={jest.fn()}
        onDecide={jest.fn()}
      />,
    );
    expect(screen.getByTestId('socialcontent-offer-not-live')).toBeTruthy();
    expect(screen.queryByTestId('socialcontent-ideas-get')).toBeNull();
  });
});

describe('Settings', () => {
  function settingsActionsMock(): jest.Mocked<SettingsActions> {
    return {
      setNetwork: jest.fn(),
      readOnMine: jest.fn(),
      stopReading: jest.fn(),
      watch: jest.fn(),
      tryWatching: jest.fn(),
      stop: jest.fn(),
    };
  }
  const body = (props: Partial<React.ComponentProps<typeof SettingsBody>> = {}) => (
    <SettingsBody
      overview={overview({
        work: [work(80, { state: 'waiting' }), work(81, { state: 'done', finishedAt: ago(5) })],
      })}
      error={null}
      online
      busy={null}
      onRetry={jest.fn()}
      actions={settingsActionsMock()}
      {...props}
    />
  );

  it('asks again, saying it uses a lot more AI, before watching videos is turned on', async () => {
    const actions = settingsActionsMock();
    await render(body({ actions }));
    await fireEvent.press(screen.getByTestId('socialcontent-watch-on'));
    expect(actions.watch).not.toHaveBeenCalled();
    expect(screen.getByTestId('socialcontent-watch-sheet')).toHaveTextContent(
      /Turn on watching videos\?.*about 10 to 20 times as much/,
    );
    await fireEvent.press(screen.getByTestId('socialcontent-watch-yes'));
    expect(actions.watch).toHaveBeenCalledWith(true);
  });

  it('turns watching off straight away, and tries it on a few videos', async () => {
    const actions = settingsActionsMock();
    await render(
      body({
        actions,
        overview: overview({ settings: { ...overview().settings, watchVideos: true } }),
      }),
    );
    await fireEvent.press(screen.getByTestId('socialcontent-watch-on'));
    expect(actions.watch).toHaveBeenCalledWith(false);
    await fireEvent.press(screen.getByTestId('socialcontent-watch-try'));
    expect(actions.tryWatching).toHaveBeenCalled();
  });

  it('turns a network on, never the last one off, and stops waiting work', async () => {
    const actions = settingsActionsMock();
    await render(body({ actions }));
    expect(screen.getByTestId('socialcontent-network-instagram')).toBeDisabled();
    expect(screen.getByTestId('socialcontent-network-tiktok')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('socialcontent-network-facebook'));
    expect(actions.setNetwork).toHaveBeenCalledWith('facebook', true);
    const waiting = screen.getByTestId(`socialcontent-work-${id(80)}`);
    await fireEvent.press(within(waiting).getByTestId('socialcontent-work-stop'));
    expect(actions.stop).toHaveBeenCalledWith(expect.objectContaining({ id: id(80) }));
    expect(
      within(screen.getByTestId(`socialcontent-work-${id(81)}`)).queryByTestId(
        'socialcontent-work-stop',
      ),
    ).toBeNull();
  });

  it('leaves the settings to owners and admins, and says where the extension goes', async () => {
    await render(body({ overview: overview({ mayManage: false, readerIsMe: false }) }));
    expect(screen.getByTestId('socialcontent-reader')).toHaveTextContent(
      'Chris’s computer reads the networks.',
    );
    expect(screen.getByTestId('socialcontent-watch-on')).toBeDisabled();
    expect(screen.queryByTestId('socialcontent-read-on-mine')).toBeNull();
    expect(screen.queryByTestId('socialcontent-watch-try')).toBeNull();
    expect(
      screen.getAllByText('Only an owner or admin of this business changes these.').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Get the extension on that computer/)).toBeTruthy();
  });

  it('saves through the settings command, reading on this person’s computer', async () => {
    const act = jest.fn(async (_key: string, run: () => Promise<unknown>, _done?: unknown) =>
      run(),
    );
    const actions = settingsActions(WS, ME, ['instagram'], act as never);
    actions.setNetwork('facebook', true);
    actions.readOnMine();
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(change).toHaveBeenCalledWith('socialcontent.settings.save', {
      workspaceId: WS,
      networks: ['instagram', 'facebook'],
    });
    expect(change).toHaveBeenCalledWith('socialcontent.settings.save', {
      workspaceId: WS,
      readerUserId: ME,
    });
    // The last network on is never turned off.
    actions.setNetwork('instagram', false);
    expect(change).toHaveBeenCalledTimes(2);
  });
});

describe('the Calendar', () => {
  const today = new Date(NOW).toISOString().slice(0, 10);
  const tomorrow = new Date(NOW + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const went = content(32, {
    title: 'Three things to check',
    state: 'posted',
    postAt: ago(3 * 24 * 60),
    postedAt: ago(3 * 24 * 60),
    postedTo: [{ place: 'feed', link: 'https://www.instagram.com/p/DAbc/', at: ago(3 * 24 * 60) }],
    numbers: {
      feed: { d2: { at: ago(24 * 60), days: 2, views: 820, likes: 41, comments: 3, shares: 2 } },
    },
  });
  const body = (props: Partial<React.ComponentProps<typeof CalendarBody>> = {}) => (
    <CalendarBody
      data={calendarView({
        posts: [content(30, { title: 'Porch season' })],
        undated: [content(31, { title: 'Moving checklist', postAt: null })],
        open: [{ network: 'facebook', date: tomorrow, at: `${tomorrow}T12:00:00.000Z` }],
        recent: [went],
      })}
      error={null}
      online
      busy={null}
      now={NOW}
      onRetry={jest.fn()}
      onOpen={jest.fn()}
      onFill={jest.fn()}
      onAutoFill={jest.fn()}
      onOkWeek={jest.fn()}
      onWrite={jest.fn()}
      {...props}
    />
  );

  it('shows its posts by day, the open days, posts with no day and what went up lately', async () => {
    const onOpen = jest.fn();
    const onWrite = jest.fn();
    await render(body({ onOpen, onWrite }));
    expect(screen.getByTestId('socialcontent-calendar-filled')).toHaveTextContent(
      /^Filled .* fills again in 5 days$/,
    );
    const day = screen.getByTestId(`socialcontent-day-${tomorrow}`);
    expect(within(day).getByText('Porch season')).toBeTruthy();
    expect(within(day).getByText('Facebook at 12:00 PM')).toBeTruthy();
    expect(screen.queryByTestId(`socialcontent-day-${today}`)).toBeNull();
    expect(
      within(screen.getByTestId('socialcontent-undated')).getByText('Moving checklist'),
    ).toBeTruthy();
    expect(screen.getByTestId(`socialcontent-post-${id(32)}-numbers`)).toHaveTextContent(
      'After 2 days: 820 views · 41 likes · 3 comments · 2 shares',
    );
    await fireEvent.press(screen.getByTestId(`socialcontent-post-${id(30)}`));
    expect(onOpen).toHaveBeenCalledWith(id(30));
    await fireEvent.press(screen.getByTestId(`socialcontent-open-write-facebook-${tomorrow}`));
    expect(onWrite).toHaveBeenCalledWith(
      'facebook',
      `${tomorrow}T12:00:00.000Z`,
      `open:facebook:${tomorrow}`,
    );
  });

  it('fills, OKs the week while there are drafts, and writes one', async () => {
    const onFill = jest.fn();
    const onOkWeek = jest.fn();
    const onWrite = jest.fn();
    await render(body({ onFill, onOkWeek, onWrite }));
    await fireEvent.press(screen.getByTestId('socialcontent-calendar-fill'));
    expect(onFill).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('socialcontent-calendar-ok-week'));
    expect(onOkWeek).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('socialcontent-calendar-write'));
    expect(onWrite).toHaveBeenCalledWith(null, null, 'write');
    await render(body({ data: calendarView({ posts: [content(30, { state: 'ready' })] }) }));
    expect(screen.queryByTestId('socialcontent-calendar-ok-week')).toBeNull();
  });

  it('stops filling on its own with its switch, and starts again (the owner, 11 Nov)', async () => {
    const onAutoFill = jest.fn();
    await render(body({ onAutoFill }));
    await fireEvent.press(screen.getByTestId('socialcontent-calendar-auto-fill'));
    expect(onAutoFill).toHaveBeenCalledWith(false);
    await render(body({ onAutoFill, data: calendarView({ autoFill: false, nextFillAt: null }) }));
    expect(screen.queryByTestId('socialcontent-calendar-fill')).toBeNull();
    expect(screen.getByTestId('socialcontent-calendar-filled')).toHaveTextContent(
      /^Filled .* filling on its own is off/,
    );
    await fireEvent.press(screen.getByTestId('socialcontent-calendar-auto-fill'));
    expect(onAutoFill).toHaveBeenCalledWith(true);
    // Only an owner or admin flips it; anyone else is told who can.
    await render(
      body({ data: calendarView({ autoFill: false, nextFillAt: null, mayManage: false }) }),
    );
    expect(screen.getByTestId('socialcontent-calendar-auto-fill')).toBeDisabled();
    expect(screen.getByTestId('socialcontent-calendar-filled')).toHaveTextContent(
      /An owner or admin can turn filling on its own back on\.$/,
    );
  });

  it('writes nothing until the main offer is live, and says where to put it live (pick 7b)', async () => {
    await render(body({ data: calendarView({ offerLive: false }) }));
    expect(screen.getByTestId('socialcontent-offer-not-live')).toHaveTextContent(
      /Your main offer isn’t live yet/,
    );
    expect(screen.queryByTestId('socialcontent-calendar-fill')).toBeNull();
    expect(screen.queryByTestId('socialcontent-calendar-write')).toBeNull();
    await render(body());
    expect(screen.queryByTestId('socialcontent-offer-not-live')).toBeNull();
  });

  it('says how to start when it’s empty, and can’t press anything with no signal', async () => {
    await render(body({ data: calendarView(), online: false }));
    expect(screen.getByTestId('socialcontent-calendar-empty')).toHaveTextContent(
      /Fill the calendar/,
    );
    expect(screen.getByTestId('socialcontent-calendar-fill')).toBeDisabled();
    expect(screen.getByTestId('socialcontent-calendar-write')).toBeDisabled();
  });

  it('says it needs signal with none, with Try again', async () => {
    const onRetry = jest.fn();
    await render(body({ data: null, error: 'The Calendar needs signal.', onRetry }));
    expect(screen.getByTestId('socialcontent-calendar-needs-signal')).toHaveTextContent(
      /^The Calendar needs signal\.Try again$/,
    );
    await fireEvent.press(screen.getByTestId('socialcontent-retry'));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('one of its posts', () => {
  function actionsMock(): jest.Mocked<PostActions> {
    return {
      save: jest.fn(async (_d: PostDraft): Promise<unknown> => undefined),
      approve: jest.fn(),
      postNow: jest.fn(),
      skip: jest.fn(),
      rewrite: jest.fn(),
      makePicture: jest.fn(),
      add: jest.fn(),
      remove: jest.fn(),
      share: jest.fn(),
    };
  }
  const body = (props: Partial<React.ComponentProps<typeof PostBody>> = {}) => (
    <PostBody
      post={content(40, { title: 'Porch season' })}
      timeZone="UTC"
      facebookPage={null}
      error={null}
      online
      busy={null}
      uploading={false}
      onRetry={jest.fn()}
      actions={actionsMock()}
      {...props}
    />
  );

  it('OKs a draft, says what it still needs, and saves what’s changed instead', async () => {
    const actions = actionsMock();
    await render(
      body({ actions, post: content(40, { title: 'Porch season', stillNeeds: 'Add a picture.' }) }),
    );
    expect(screen.getByTestId('screen-title')).toHaveTextContent('Porch season');
    expect(screen.getByTestId('socialcontent-post-still-needs')).toHaveTextContent(
      'Add a picture.',
    );
    await fireEvent.press(screen.getByTestId('socialcontent-post-ok'));
    expect(actions.approve).toHaveBeenCalledWith(true);
    await fireEvent.changeText(screen.getByTestId('socialcontent-post-words'), 'New words.');
    expect(screen.queryByTestId('socialcontent-post-ok')).toBeNull();
    await fireEvent.press(screen.getByTestId('socialcontent-post-save'));
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ words: 'New words.' }));
  });

  it('puts an OK’d post up now or takes the OK back, and skips or brings one back', async () => {
    const actions = actionsMock();
    await render(body({ actions, post: content(40, { state: 'ready', approvedAt: ago(5) }) }));
    await fireEvent.press(screen.getByTestId('socialcontent-post-now'));
    expect(actions.postNow).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('socialcontent-post-unok'));
    expect(actions.approve).toHaveBeenCalledWith(false);
    await fireEvent.press(screen.getByTestId('socialcontent-post-skip'));
    expect(actions.skip).toHaveBeenCalledWith(true);
    await render(body({ actions, post: content(41, { state: 'skipped' }) }));
    await fireEvent.press(screen.getByTestId('socialcontent-post-restore'));
    expect(actions.skip).toHaveBeenCalledWith(false);
  });

  it('removes a post only for those who may, and only once asked (the owner, 11 Nov)', async () => {
    await render(body());
    expect(screen.queryByTestId('socialcontent-post-remove')).toBeNull();
    const onRemove = jest.fn();
    await render(body({ onRemove }));
    await fireEvent.press(screen.getByTestId('socialcontent-post-remove'));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByTestId('socialcontent-post-remove-ask')).toHaveTextContent(
      /Its day opens up/,
    );
    await fireEvent.press(screen.getByTestId('socialcontent-post-remove-no'));
    expect(screen.queryByTestId('socialcontent-post-remove-ask')).toBeNull();
    await fireEvent.press(screen.getByTestId('socialcontent-post-remove'));
    await fireEvent.press(screen.getByTestId('socialcontent-post-remove-yes'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    // A post that went up stays, with its numbers.
    await render(body({ onRemove, post: content(42, { state: 'posted', postedAt: ago(1) }) }));
    expect(screen.queryByTestId('socialcontent-post-remove')).toBeNull();
  });

  it('asks for the Facebook Page first, and takes the person’s video for a video post', async () => {
    const actions = actionsMock();
    await render(
      body({
        actions,
        post: content(40, { network: 'facebook', format: 'video', facebookWhere: ['page'] }),
      }),
    );
    expect(
      screen.getByText('Add your Facebook Page’s link in Settings → Posting first.'),
    ).toBeTruthy();
    await fireEvent.press(screen.getByTestId('socialcontent-post-add-video'));
    expect(actions.add).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('socialcontent-post-add-video')).toHaveTextContent('Add your video');
  });

  it('makes its picture, adds the person’s photos, and has it written again', async () => {
    const actions = actionsMock();
    await render(body({ actions }));
    await fireEvent.press(screen.getByTestId('socialcontent-post-make-photo'));
    expect(actions.makePicture).toHaveBeenCalledWith('photo', '');
    await fireEvent.press(screen.getByTestId('socialcontent-post-add-photo'));
    expect(actions.add).toHaveBeenCalledWith(false);
    await fireEvent.changeText(screen.getByTestId('socialcontent-post-rewrite-ask'), 'Shorter');
    await fireEvent.press(screen.getByTestId('socialcontent-post-rewrite'));
    expect(actions.rewrite).toHaveBeenCalledWith('Shorter');
  });

  it('opens its pictures full screen, and goes between them (the owner, 11 Nov)', async () => {
    const pic = (n: number) => ({
      fileId: id(90 + n),
      bucket: 'files',
      objectPath: `w/${n}.png`,
      name: `Slide ${n}`,
      mimeType: 'image/png',
    });
    await render(body({ post: content(40, { format: 'carousel', pictures: [pic(1), pic(2)] }) }));
    expect(screen.queryByTestId('socialcontent-picture-viewer-count')).toBeNull();
    await fireEvent.press(screen.getByTestId(`socialcontent-post-picture-${id(92)}`));
    expect(screen.getByTestId('socialcontent-picture-viewer-count')).toHaveTextContent('2 of 2');
    expect(screen.getByTestId('socialcontent-picture-viewer-next')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('socialcontent-picture-viewer-previous'));
    expect(screen.getByTestId('socialcontent-picture-viewer-count')).toHaveTextContent('1 of 2');
    await fireEvent.press(screen.getByTestId('socialcontent-picture-viewer-close'));
    expect(screen.queryByTestId('socialcontent-picture-viewer-count')).toBeNull();
  });

  it('shows where a post went up and how it did, with nothing left to change', async () => {
    await render(
      body({
        post: content(40, {
          state: 'posted',
          postedAt: ago(8 * 24 * 60),
          postedTo: [{ place: 'feed', link: 'https://www.instagram.com/p/DAbc/', at: ago(60) }],
          numbers: {
            feed: {
              d2: { at: ago(60), days: 2, views: 820, likes: 41, comments: 3, shares: 2 },
              d7: { at: ago(30), days: 7, failure: 'Instagram didn’t show the post.' },
            },
          },
          doneWell: { place: 'feed', on: 'views', times: 3.2, at: ago(30) },
        }),
      }),
    );
    expect(screen.getByTestId('socialcontent-post-went')).toHaveTextContent(/Posted/);
    expect(screen.getByTestId('socialcontent-post-numbers')).toHaveTextContent(
      /After 2 days: 820 views.*After 7 days: couldn’t read its numbers.*It did well: 3.2 times your usual views/,
    );
    expect(screen.queryByTestId('socialcontent-post-actions')).toBeNull();
  });

  it('saves the day and time in the business’s time zone, and no day as none', () => {
    const p = content(40, { postAt: '2026-11-12T15:00:00.000Z' });
    const d = draftOf(p, 'America/Chicago');
    expect(d).toMatchObject({ day: '2026-11-12', time: '09:00' });
    expect(saveInput(p, { ...d, time: '10:30' }, 'America/Chicago')).toMatchObject({
      postId: id(40),
      postAt: '2026-11-12T16:30:00.000Z',
      hashtags: ['homes'],
      script: null,
    });
    expect(saveInput(p, { ...d, day: '' }, 'America/Chicago').postAt).toBeNull();
  });

  it('says it needs signal with none, with Try again', async () => {
    const onRetry = jest.fn();
    await render(body({ post: null, error: 'This post needs signal.', onRetry }));
    expect(screen.getByTestId('socialcontent-post-needs-signal')).toHaveTextContent(
      /^This post needs signal\.Try again$/,
    );
    await fireEvent.press(screen.getByTestId('socialcontent-retry'));
    expect(onRetry).toHaveBeenCalled();
  });
});
