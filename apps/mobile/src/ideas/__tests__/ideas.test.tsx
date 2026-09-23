import { IDEAS_WORDS } from '@hfos/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Text } from 'react-native';

import IdeaScreen from '@/app/app/w/[workspaceId]/ideas/[ideaId]';
import Ideas from '@/app/app/w/[workspaceId]/(tabs)/(more)/ideas';
import Roadmap from '@/app/app/w/[workspaceId]/(tabs)/(more)/ideas/roadmap';
import ShareIdea from '@/app/app/w/[workspaceId]/(tabs)/(more)/ideas/share';
import WhatsNew from '@/app/app/w/[workspaceId]/(tabs)/(more)/ideas/whats-new';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { forgetIdeaAreas } from '@/ideas/use-ideas';
import { forgetWhatsNewSignal, useWhatsNewUnseen, whatsNewRead } from '@/ideas/whats-new-signal';
import { api } from '@/lib/api';
import type { Business, Me } from '@/lib/businesses';
import { setTestOffline } from '@/lib/network';

/**
 * Ideas on the phone (0102): the board every business shares, a vote given and taken back from the business the
 * person has open, sharing with "Is it one of these?" first, one idea with its story and its comments, the roadmap's
 * three lists, and What's new marked read once it has come down. None of it is kept on the phone, so with no signal
 * each screen says so and Try again asks once more.
 */

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    replace: jest.fn(),
    push: jest.fn(),
    setParams: jest.fn(),
    canGoBack: () => true,
  },
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROUTE_IDEA = '22222222-2222-4222-8222-222222222222';
const QUICKBOOKS = '33333333-3333-4333-8333-333333333333';
const COMMENT = '44444444-4444-4444-8444-444444444444';
const ENTRY = '55555555-5555-4555-8555-555555555555';

const business: Business = {
  id: LONE_STAR,
  name: 'Lone Star HVAC & Roofing',
  organizationId: 'org',
  organizationName: 'Lone Star HVAC & Roofing',
  role: 'owner',
  timezone: 'America/Chicago',
};

const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Ramsey' },
  businesses: [business],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

const AREAS = {
  areas: [
    {
      id: 'calendar',
      name: 'Calendar and booking',
      description: 'Calendars, appointments and booking pages',
      sort: 50,
      archived: false,
      openCount: 2,
    },
    { id: 'money', name: 'Money', description: '', sort: 60, archived: false, openCount: 1 },
    { id: 'old', name: 'Retired area', description: '', sort: 70, archived: true, openCount: 0 },
  ],
};

const summary = (over: Record<string, unknown> = {}) => ({
  id: ROUTE_IDEA,
  number: 7,
  title: 'Text the customer when the tech is on the way',
  excerpt: 'A one-tap On my way from the phone app.',
  areaId: 'calendar',
  status: 'planned',
  voteCount: 6,
  commentCount: 1,
  author: { name: 'Riley C.', you: false },
  voted: false,
  createdAt: new Date(Date.now() - 9 * 60_000).toISOString(),
  statusChangedAt: null,
  ...over,
});

const LIST = {
  ideas: [
    summary(),
    summary({
      id: QUICKBOOKS,
      number: 8,
      title: 'Two-way sync with QuickBooks Online',
      excerpt: '',
      areaId: 'money',
      status: 'done',
      voteCount: 5,
      commentCount: 0,
      author: { name: '', you: true },
    }),
  ],
  nextCursor: null,
};

const FULL = {
  idea: {
    ...summary(),
    body: 'Half our no-shows are people who didn’t know we were coming.\n\n- the tech’s name\n- a rough time',
    following: true,
    canEdit: false,
    votingOpen: true,
    mergedInto: null,
    hidden: false,
  },
  comments: [
    {
      id: COMMENT,
      body: 'We are building this now. It starts with the tech’s name.',
      author: { name: 'Sam', you: false, team: true },
      hidden: false,
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    },
  ],
  updates: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      kind: 'status',
      fromStatus: 'under_review',
      toStatus: 'planned',
      note: 'Next up after the calendar work.',
      other: null,
      whatsNew: null,
      by: 'Sam',
      createdAt: '2026-09-09T15:00:00.000Z',
    },
  ],
  shipped: [],
};

const ROADMAP = {
  planned: [
    {
      id: ROUTE_IDEA,
      number: 7,
      title: 'Text the customer when the tech is on the way',
      areaId: 'calendar',
      voteCount: 6,
      voted: false,
      statusChangedAt: null,
    },
  ],
  inProgress: [],
  done: [
    {
      id: QUICKBOOKS,
      number: 8,
      title: 'Two-way sync with QuickBooks Online',
      areaId: 'money',
      voteCount: 5,
      voted: true,
      statusChangedAt: '2026-09-10T15:00:00.000Z',
    },
  ],
};

const WHATS_NEW = {
  entries: [
    {
      id: ENTRY,
      title: 'QuickBooks Online, both ways',
      body: 'Invoices and payments now land in QuickBooks.',
      kind: 'new',
      areaId: 'money',
      publishedAt: '2026-09-10T15:00:00.000Z',
      ideas: [
        {
          id: QUICKBOOKS,
          number: 8,
          title: 'Two-way sync with QuickBooks Online',
          voteCount: 5,
          status: 'done',
        },
      ],
      unseen: true,
      updatedAt: '2026-09-10T15:00:00.000Z',
    },
  ],
  nextCursor: null,
};

/** What the API says, per path. A path given `null` fails instead, as no signal does. */
let answers: Record<string, unknown>;

/** The stand-in API, typed plainly: openapi-fetch's own signature is too deep for a mock to wear. */
const post = api.POST as unknown as jest.Mock<
  Promise<{ data: unknown }>,
  [string, { body: Record<string, unknown> }]
>;

const sent = (path: string) => post.mock.calls.filter((call) => call[0] === path);

function mockApi() {
  post.mockImplementation(async (path) => {
    const answer = answers[path];
    if (answer === undefined) return { data: {} };
    if (answer === null) throw new Error('No signal. Try again when you’re back online.');
    return { data: typeof answer === 'function' ? (answer as () => unknown)() : answer };
  });
}

function inBusiness(children: React.ReactNode) {
  return (
    <BusinessProvider value={{ userId: DALE, me, business, openSwitcher: () => undefined }}>
      {children}
    </BusinessProvider>
  );
}

async function show(element: React.ReactElement) {
  mockApi();
  await render(inBusiness(element));
}

beforeEach(() => {
  jest.clearAllMocks();
  forgetIdeaAreas();
  forgetWhatsNewSignal();
  setTestOffline(false);
  mockParams = {};
  answers = {
    '/v1/queries/idea.areas': AREAS,
    '/v1/queries/idea.list': LIST,
    '/v1/queries/idea.get': FULL,
    '/v1/queries/idea.roadmap': ROADMAP,
    '/v1/queries/whats_new.list': WHATS_NEW,
    '/v1/queries/whats_new.unseen': { unseen: 2 },
    '/v1/queries/idea.similar': { ideas: [] },
    '/v1/commands/idea.vote': { ideaId: ROUTE_IDEA, voted: true, voteCount: 7 },
    '/v1/commands/idea.unvote': { ideaId: ROUTE_IDEA, voted: false, voteCount: 6 },
    '/v1/commands/idea.follow': { ideaId: ROUTE_IDEA, following: false },
    '/v1/commands/idea.comment': { commentId: COMMENT },
    '/v1/commands/idea.share': { ideaId: ROUTE_IDEA, number: 9 },
    '/v1/commands/whats_new.mark_seen': { seenAt: '2026-09-23T16:00:00.000Z' },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('the board', () => {
  it('lists the ideas with where each stands, and a closed one takes no vote', async () => {
    await show(<Ideas />);
    expect(await screen.findByText('Text the customer when the tech is on the way')).toBeTruthy();
    expect(screen.getAllByTestId('idea-row')).toHaveLength(2);
    expect(screen.getByText('Calendar and booking')).toBeTruthy();
    expect(screen.getByText('Planned')).toBeTruthy();
    // Done is closed to votes: its count shows without a button.
    expect(screen.getAllByTestId('idea-vote')).toHaveLength(1);
    expect(screen.getByTestId('idea-votes')).toHaveTextContent('5');
    // The board asks for the open ideas, the ones moving lately first.
    expect(sent('/v1/queries/idea.list')[0]![1]).toEqual({
      body: { sort: 'trending', status: 'open', limit: 20 },
    });
  });

  it('gives a vote from the business the person has open, and shows the count HandsFreeOS answers', async () => {
    await show(<Ideas />);
    await fireEvent.press(await screen.findByTestId('idea-vote'));
    await waitFor(() => expect(sent('/v1/commands/idea.vote')).toHaveLength(1));
    expect(sent('/v1/commands/idea.vote')[0]![1]).toEqual({
      body: { ideaId: ROUTE_IDEA, workspaceId: LONE_STAR },
    });
    await waitFor(() => expect(screen.getAllByTestId('idea-vote-count')[0]).toHaveTextContent('7'));
    expect(screen.getByTestId('idea-vote').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('puts a vote back as it was when it can’t go, and says why', async () => {
    answers['/v1/commands/idea.vote'] = null;
    await show(<Ideas />);
    await fireEvent.press(await screen.findByTestId('idea-vote'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getAllByTestId('idea-vote-count')[0]).toHaveTextContent('6');
  });

  it('searches a moment after the typing stops, and says when nothing matches', async () => {
    await show(<Ideas />);
    await screen.findByText('Text the customer when the tech is on the way');
    answers['/v1/queries/idea.list'] = { ideas: [], nextCursor: null };
    await fireEvent.changeText(screen.getByTestId('ideas-search'), 'drive time');
    await waitFor(() =>
      expect(sent('/v1/queries/idea.list').at(-1)![1]).toEqual({
        body: { sort: 'trending', status: 'open', limit: 20, search: 'drive time' },
      }),
    );
    expect(await screen.findByText(IDEAS_WORDS.noMatch)).toBeTruthy();
  });

  it('opens an idea from its row, and Share from the top bar', async () => {
    await show(<Ideas />);
    await fireEvent.press(await screen.findByTestId(`idea-open-${ROUTE_IDEA}`));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ideas/${ROUTE_IDEA}`);
    await fireEvent.press(screen.getByTestId('share-idea'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ideas/share`);
  });

  it('says it needs a signal, and shows the board once signal is back', async () => {
    answers['/v1/queries/idea.list'] = null;
    setTestOffline(true);
    await show(<Ideas />);
    await screen.findByTestId('ideas-error');
    expect(screen.getByText(IDEAS_WORDS.needsSignal)).toBeTruthy();
    answers['/v1/queries/idea.list'] = LIST;
    await act(async () => setTestOffline(false));
    expect(await screen.findByText('Text the customer when the tech is on the way')).toBeTruthy();
  });

  it('says what went wrong with signal, and Try again asks once more', async () => {
    answers['/v1/queries/idea.list'] = null;
    await show(<Ideas />);
    expect(await screen.findByText('No signal. Try again when you’re back online.')).toBeTruthy();
    answers['/v1/queries/idea.list'] = LIST;
    await fireEvent.press(screen.getByTestId('ideas-retry'));
    expect(await screen.findByText('Text the customer when the tech is on the way')).toBeTruthy();
  });
});

describe('sharing an idea', () => {
  it('offers the ideas that sound the same before a second copy is made', async () => {
    answers['/v1/queries/idea.similar'] = {
      ideas: [
        {
          id: ROUTE_IDEA,
          number: 7,
          title: 'Text the customer when the tech is on the way',
          status: 'planned',
          voteCount: 6,
          voted: false,
        },
      ],
    };
    await show(<ShareIdea />);
    await fireEvent.changeText(
      screen.getByTestId('idea-title'),
      'Text customers the tech is coming',
    );
    expect(await screen.findByTestId('idea-similar')).toHaveTextContent(
      /Text the customer when the tech is on the way/,
    );
    expect(sent('/v1/queries/idea.similar')[0]![1]).toEqual({
      body: { text: 'Text customers the tech is coming' },
    });
  });

  it('asks for a title and what it is about, then shares it from the business open and opens it', async () => {
    await show(<ShareIdea />);
    await fireEvent.press(screen.getByTestId('idea-submit'));
    expect(screen.getByTestId('idea-problem')).toHaveTextContent(IDEAS_WORDS.needsTitle);

    await fireEvent.changeText(screen.getByTestId('idea-title'), 'Route the day by drive time');
    await fireEvent.changeText(screen.getByTestId('idea-body'), 'Fewer miles between visits.');
    await fireEvent.press(screen.getByTestId('idea-submit'));
    expect(screen.getByTestId('idea-problem')).toHaveTextContent(IDEAS_WORDS.needsArea);

    await fireEvent.press(screen.getByTestId('idea-area'));
    // An area the team retired isn't offered for a new idea.
    expect(screen.queryByTestId('idea-area-old')).toBeNull();
    await fireEvent.press(await screen.findByTestId('idea-area-calendar'));
    await fireEvent.press(screen.getByTestId('idea-submit'));
    await waitFor(() => expect(sent('/v1/commands/idea.share')).toHaveLength(1));
    expect(sent('/v1/commands/idea.share')[0]![1]).toEqual({
      body: {
        workspaceId: LONE_STAR,
        title: 'Route the day by drive time',
        body: 'Fewer miles between visits.',
        areaId: 'calendar',
      },
    });
    expect(toast.show).toHaveBeenCalledWith(IDEAS_WORDS.shared(9));
    // The form closes and the idea opens over the board.
    expect(router.back).toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ideas/${ROUTE_IDEA}`);
  });
});

describe('one idea', () => {
  beforeEach(() => {
    mockParams = { ideaId: ROUTE_IDEA };
  });

  it('shows where it stands, what the team said, and the comments, the team’s marked as theirs', async () => {
    await show(<IdeaScreen />);
    expect(await screen.findByTestId('idea-title-shown')).toHaveTextContent(
      'Text the customer when the tech is on the way',
    );
    expect(screen.getByText('We are going to build this.')).toBeTruthy();
    expect(screen.getByTestId('idea-votes-line')).toHaveTextContent('6 votes.');
    expect(screen.getByTestId('idea-updates')).toHaveTextContent(/Moved to Planned/);
    expect(screen.getByText('Next up after the calendar work.')).toBeTruthy();
    expect(screen.getByTestId('idea-comments')).toHaveTextContent(/HandsFreeOS team/);
    // The details as typed: a paragraph, then a list.
    expect(screen.getByText('the tech’s name')).toBeTruthy();
  });

  it('stops the emails with the switch, and puts it back when that can’t go', async () => {
    await show(<IdeaScreen />);
    const toggle = await screen.findByTestId('idea-follow');
    await fireEvent(toggle, 'checkedChange', false);
    await waitFor(() => expect(sent('/v1/commands/idea.follow')).toHaveLength(1));
    expect(sent('/v1/commands/idea.follow')[0]![1]).toEqual({
      body: { ideaId: ROUTE_IDEA, following: false },
    });
    expect(toast.show).toHaveBeenCalledWith(IDEAS_WORDS.followOff);

    answers['/v1/commands/idea.follow'] = null;
    await fireEvent(screen.getByTestId('idea-follow'), 'checkedChange', true);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByTestId('idea-follow').props.accessibilityState).toMatchObject({
      checked: false,
    });
  });

  it('sends a comment and reads the idea back with it', async () => {
    await show(<IdeaScreen />);
    await fireEvent.changeText(
      await screen.findByTestId('idea-comment-body'),
      'We would use this every morning.',
    );
    await fireEvent.press(screen.getByTestId('idea-comment-send'));
    await waitFor(() => expect(sent('/v1/commands/idea.comment')).toHaveLength(1));
    expect(sent('/v1/commands/idea.comment')[0]![1]).toEqual({
      body: { ideaId: ROUTE_IDEA, body: 'We would use this every morning.' },
    });
    await waitFor(() => expect(sent('/v1/queries/idea.get')).toHaveLength(2));
    expect(screen.getByTestId('idea-comment-body').props.value).toBe('');
  });

  it('sends a merged duplicate’s readers to the idea it joined, with no box to comment in', async () => {
    answers['/v1/queries/idea.get'] = {
      ...FULL,
      idea: {
        ...FULL.idea,
        votingOpen: false,
        mergedInto: { id: QUICKBOOKS, number: 8, title: 'Two-way sync with QuickBooks Online' },
      },
    };
    await show(<IdeaScreen />);
    await fireEvent.press(await screen.findByTestId('idea-merged'));
    expect(router.replace).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ideas/${QUICKBOOKS}`);
    expect(screen.queryByTestId('idea-comment-body')).toBeNull();
    expect(screen.queryByTestId('idea-vote')).toBeNull();
  });
});

describe('the roadmap', () => {
  it('shows planned first, and what shipped with the day it did', async () => {
    await show(<Roadmap />);
    expect(await screen.findByText('Text the customer when the tech is on the way')).toBeTruthy();
    expect(screen.getByTestId('roadmap-planned')).toHaveTextContent('Planned · 1');
    await fireEvent.press(screen.getByTestId('roadmap-in_progress'));
    expect(screen.getByTestId('roadmap-empty')).toHaveTextContent(
      IDEAS_WORDS.roadmapEmpty.in_progress,
    );
    await fireEvent.press(screen.getByTestId('roadmap-done'));
    expect(screen.getByText('Two-way sync with QuickBooks Online')).toBeTruthy();
    expect(screen.getByText(/^Money · Sep 10, 2026$/)).toBeTruthy();
  });
});

function Unseen() {
  const unseen = useWhatsNewUnseen(DALE);
  return <Text testID="unseen">{String(unseen)}</Text>;
}

describe('What’s new', () => {
  it('shows each entry with the ideas it answers, and marks it read once it has come down', async () => {
    mockApi();
    await render(
      inBusiness(
        <>
          <Unseen />
          <WhatsNew />
        </>,
      ),
    );
    expect(await screen.findByText('QuickBooks Online, both ways')).toBeTruthy();
    expect(screen.getByTestId('whats-new-unseen')).toHaveTextContent(IDEAS_WORDS.newForYou);
    await waitFor(() => expect(sent('/v1/commands/whats_new.mark_seen')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('unseen')).toHaveTextContent('0'));
    await fireEvent.press(screen.getByTestId('whats-new-idea'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${LONE_STAR}/ideas/${QUICKBOOKS}`);
  });

  it('counts what the person hasn’t read, for More', async () => {
    mockApi();
    await render(<Unseen />);
    await waitFor(() => expect(screen.getByTestId('unseen')).toHaveTextContent('2'));
    await act(async () => whatsNewRead());
    expect(screen.getByTestId('unseen')).toHaveTextContent('0');
  });
});
