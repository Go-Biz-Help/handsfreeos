import { IDEA_AREAS_WORDS, IDEAS_TEAM_WORDS, WHATS_NEW_TEAM_WORDS } from '@hfos/core';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import { IDEAS_DESK_WORDS } from '@/admin/ideas-words';
import { DESK_PHONE_WORDS } from '@/admin/words';
import DeskIdea from '@/app/app/admin/ideas/[ideaId]';
import DeskIdeaAreas from '@/app/app/admin/ideas/areas';
import DeskIdeas from '@/app/app/admin/ideas';
import DeskWhatsNew from '@/app/app/admin/ideas/whats-new';
import { toast } from '@/components/ui/toast';
import { setTestOffline } from '@/lib/network';

import { agent, LONE_STAR, RILEY, SAM, lastBody, sent, showDesk, type Answers } from './kit';

/**
 * Ideas on the phone's Support desk (the web's /admin/ideas): the team's list with its tabs, sort, area and search,
 * one idea with who is behind it and everything the team does to it, the areas, and writing What's new. Every
 * support role answers, merges and takes down; only leads and admins move an idea, keep the areas and write What's
 * new. All of it is live, so with no signal it says so.
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
  useFocusEffect: () => undefined,
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/lib/open-web', () => ({ openWeb: jest.fn(async () => true) }));
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const IDEA = '33333333-3333-4333-8333-333333333333';
const TWIN = '44444444-4444-4444-8444-444444444444';
const COMMENT = '55555555-5555-4555-8555-555555555555';
const GONE_COMMENT = '66666666-6666-4666-8666-666666666666';
const UPDATE = '77777777-7777-4777-8777-777777777777';
const DRAFT = '88888888-8888-4888-8888-888888888888';
const SHIPPED = '99999999-9999-4999-8999-999999999999';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const AREAS = {
  areas: [
    {
      id: 'invoices',
      name: 'Invoices',
      description: 'Getting paid',
      sort: 10,
      archived: false,
      openCount: 4,
    },
    { id: 'texting', name: 'Texting', description: '', sort: 20, archived: true, openCount: 0 },
    {
      id: 'other',
      name: 'Something else',
      description: '',
      sort: 1000,
      archived: false,
      openCount: 1,
    },
  ],
};

const COUNTS = { under_review: 3, planned: 2, in_progress: 1, done: 7, not_planned: 1, hidden: 2 };

const row = (over: Record<string, unknown> = {}) => ({
  id: IDEA,
  number: 14,
  title: 'Send invoices by text',
  excerpt: 'With a pay link.',
  areaId: 'invoices',
  status: 'under_review',
  voteCount: 12,
  commentCount: 2,
  author: { userId: RILEY, name: 'Dale Ramsey', email: 'dale@lonestarhvac.test' },
  business: { id: LONE_STAR, name: 'Lone Star HVAC' },
  businessCount: 5,
  hidden: false,
  mergedInto: null,
  createdAt: minutesAgo(60 * 24 * 3),
  statusChangedAt: null,
  ...over,
});

const IDEA_FULL = (over: Record<string, unknown> = {}) => ({
  idea: {
    id: IDEA,
    number: 14,
    title: 'Send invoices by text',
    excerpt: 'With a pay link.',
    areaId: 'invoices',
    status: 'under_review',
    voteCount: 12,
    commentCount: 2,
    author: { name: 'Dale R.', you: false },
    voted: false,
    createdAt: minutesAgo(60 * 24 * 3),
    statusChangedAt: null,
    body: 'With a pay link.',
    following: false,
    canEdit: false,
    votingOpen: true,
    mergedInto: null,
    hidden: false,
    ...over,
  },
  comments: [
    {
      id: COMMENT,
      body: 'We would use this every day.',
      author: { name: 'Pat K.', you: false, team: false },
      hidden: false,
      createdAt: minutesAgo(120),
    },
    {
      id: GONE_COMMENT,
      body: 'Buy cheap watches',
      author: { name: 'Spam B.', you: false, team: false },
      hidden: true,
      createdAt: minutesAgo(90),
    },
  ],
  updates: [
    {
      id: UPDATE,
      kind: 'status',
      fromStatus: 'under_review',
      toStatus: 'planned',
      note: 'Pencilled in for spring.',
      other: null,
      whatsNew: null,
      by: 'Riley',
      createdAt: minutesAgo(60),
    },
  ],
  shipped: [],
});

const TEAM = {
  author: { userId: RILEY, name: 'Dale Ramsey', email: 'dale@lonestarhvac.test' },
  business: { id: LONE_STAR, name: 'Lone Star HVAC' },
  businessCount: 2,
  voters: [
    {
      userId: RILEY,
      name: 'Dale Ramsey',
      email: 'dale@lonestarhvac.test',
      business: { id: LONE_STAR, name: 'Lone Star HVAC' },
      votedAt: minutesAgo(60 * 24 * 3),
    },
    {
      userId: SAM,
      name: '',
      email: 'pat@coolair.test',
      business: null,
      votedAt: minutesAgo(60 * 24),
    },
  ],
  followerCount: 3,
};

const SIMILAR = {
  ideas: [
    {
      id: TWIN,
      number: 9,
      title: 'Text invoices to customers',
      status: 'planned',
      voteCount: 30,
      voted: false,
    },
  ],
};

const entry = (over: Record<string, unknown> = {}) => ({
  id: DRAFT,
  title: 'Invoices by text',
  body: 'Send an invoice as a text with a pay link.',
  kind: 'new',
  areaId: 'invoices',
  publishedAt: null,
  ideas: [
    { id: IDEA, number: 14, title: 'Send invoices by text', voteCount: 12, status: 'planned' },
  ],
  unseen: false,
  updatedAt: minutesAgo(30),
  ...over,
});

const WHATS_NEW = {
  entries: [
    entry(),
    entry({
      id: SHIPPED,
      title: 'QuickBooks sync',
      body: '',
      kind: 'improved',
      areaId: null,
      publishedAt: '2026-09-09T12:00:00.000Z',
      ideas: [],
    }),
  ],
  nextCursor: null,
};

let answers: Answers;

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
  mockParams = { ideaId: IDEA };
  answers = {
    '/v1/queries/idea.triage': { ideas: [row()], nextCursor: null, counts: COUNTS },
    '/v1/queries/idea.areas': AREAS,
    '/v1/queries/idea.get': IDEA_FULL(),
    '/v1/queries/idea.team_view': TEAM,
    '/v1/queries/idea.similar': SIMILAR,
    '/v1/queries/whats_new.list': WHATS_NEW,
    '/v1/commands/idea.set_status': { ideaId: IDEA, status: 'planned', updateId: UPDATE },
    '/v1/commands/idea.comment': { commentId: COMMENT },
    '/v1/commands/idea.edit': { ideaId: IDEA },
    '/v1/commands/idea.merge': {
      ideaId: IDEA,
      intoIdeaId: TWIN,
      movedVotes: 12,
      movedFollowers: 3,
    },
    '/v1/commands/idea.set_hidden': { ideaId: IDEA, hidden: true },
    '/v1/commands/idea.set_comment_hidden': { commentId: COMMENT, hidden: true },
    '/v1/commands/idea_area.save': { id: 'service_plans', created: true },
    '/v1/commands/whats_new.save': { id: DRAFT, created: true },
    '/v1/commands/whats_new.publish': { id: DRAFT, publishedAt: minutesAgo(0), ideasDone: 1 },
    '/v1/commands/whats_new.unpublish': { id: SHIPPED },
    '/v1/commands/whats_new.delete': { id: DRAFT },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('the list', () => {
  it('opens on Under review, with the counts beside the tabs and the line at the top', async () => {
    await showDesk(<DeskIdeas />, () => answers);
    expect(await screen.findByText('Send invoices by text')).toBeTruthy();
    expect(lastBody('/v1/queries/idea.triage')).toEqual({
      show: 'board',
      status: 'under_review',
      sort: 'top',
    });
    expect(screen.getByText('3 waiting for an answer · 2 planned · 1 being built')).toBeTruthy();
    expect(screen.getByTestId('triage-tab-under_review')).toHaveTextContent('Under review3');
    expect(screen.getByTestId('triage-tab-hidden')).toHaveTextContent('Taken down2');
    // How many businesses want it, and who shared it from where.
    expect(screen.getByText('Invoices · 5 businesses · 2 comments')).toBeTruthy();
    expect(screen.getByTestId('triage-row-14')).toHaveTextContent('Dale Ramsey · Lone Star HVAC', {
      exact: false,
    });
    expect(screen.getByTestId('admin-whats-new')).toBeTruthy();
    expect(screen.getByTestId('admin-idea-areas')).toBeTruthy();
  });

  it('asks for what each tab, sort, area and search means', async () => {
    await showDesk(<DeskIdeas />, () => answers);
    await screen.findByText('Send invoices by text');
    await fireEvent.press(screen.getByTestId('triage-tab-hidden'));
    await waitFor(() =>
      expect(lastBody('/v1/queries/idea.triage')).toEqual({
        show: 'hidden',
        status: 'all',
        sort: 'top',
      }),
    );
    await fireEvent.press(screen.getByTestId('triage-tab-planned'));
    await fireEvent.press(screen.getByTestId('triage-sort-trending'));
    await waitFor(() =>
      expect(lastBody('/v1/queries/idea.triage')).toEqual({
        show: 'board',
        status: 'planned',
        sort: 'trending',
      }),
    );
    await fireEvent.press(screen.getByTestId('triage-area'));
    await fireEvent.press(screen.getByTestId('pick-area-invoices'));
    await waitFor(() =>
      expect(lastBody('/v1/queries/idea.triage')).toMatchObject({ areaId: 'invoices' }),
    );
    answers['/v1/queries/idea.triage'] = { ideas: [], nextCursor: null, counts: COUNTS };
    await fireEvent.changeText(screen.getByTestId('triage-search'), 'invoice');
    await waitFor(() =>
      expect(lastBody('/v1/queries/idea.triage')).toEqual({
        show: 'board',
        status: 'planned',
        sort: 'trending',
        areaId: 'invoices',
        search: 'invoice',
      }),
    );
    expect(await screen.findByText(IDEAS_TEAM_WORDS.emptyFiltered)).toBeTruthy();
  });

  it('shows the next page after this one', async () => {
    answers['/v1/queries/idea.triage'] = (body: Record<string, unknown>) =>
      body.cursor
        ? {
            ideas: [row({ id: TWIN, number: 9, title: 'Text invoices to customers' })],
            nextCursor: null,
            counts: COUNTS,
          }
        : { ideas: [row()], nextCursor: '30', counts: COUNTS };
    await showDesk(<DeskIdeas />, () => answers);
    await fireEvent.press(await screen.findByTestId('triage-more'));
    expect(await screen.findByText('Text invoices to customers')).toBeTruthy();
    expect(lastBody('/v1/queries/idea.triage')).toMatchObject({ cursor: '30' });
    expect(screen.getByText('Send invoices by text')).toBeTruthy();
  });

  it('opens an idea from its row, and What’s new from the top', async () => {
    await showDesk(<DeskIdeas />, () => answers);
    await fireEvent.press(await screen.findByTestId('triage-row-14'));
    expect(router.push).toHaveBeenCalledWith(`/app/admin/ideas/${IDEA}`);
    await fireEvent.press(screen.getByTestId('admin-whats-new'));
    expect(router.push).toHaveBeenCalledWith('/app/admin/ideas/whats-new');
  });

  it('leaves the areas out for somebody who can only answer ideas', async () => {
    await showDesk(<DeskIdeas />, () => answers, agent);
    await screen.findByText('Send invoices by text');
    expect(screen.getByTestId('admin-whats-new')).toBeTruthy();
    expect(screen.queryByTestId('admin-idea-areas')).toBeNull();
  });

  it('says it needs a signal, and Try again asks once more', async () => {
    answers['/v1/queries/idea.triage'] = null;
    setTestOffline(true);
    await showDesk(<DeskIdeas />, () => answers);
    await screen.findByTestId('triage-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
    answers['/v1/queries/idea.triage'] = { ideas: [row()], nextCursor: null, counts: COUNTS };
    await fireEvent.press(screen.getByTestId('desk-retry'));
    expect(await screen.findByText('Send invoices by text')).toBeTruthy();
  });

  it('asks again on its own when the signal comes back', async () => {
    answers['/v1/queries/idea.triage'] = null;
    setTestOffline(true);
    await showDesk(<DeskIdeas />, () => answers);
    await screen.findByTestId('triage-error');
    answers['/v1/queries/idea.triage'] = { ideas: [row()], nextCursor: null, counts: COUNTS };
    await act(() => setTestOffline(false));
    expect(await screen.findByText('Send invoices by text')).toBeTruthy();
  });
});

describe('one idea', () => {
  it('shows who is behind it, every voter, what happened and every comment', async () => {
    await showDesk(<DeskIdea />, () => answers);
    expect(await screen.findByTestId('idea-title')).toHaveTextContent('Send invoices by text');
    expect(screen.getByTestId('idea-behind')).toHaveTextContent('Shared by Dale Ramsey', {
      exact: false,
    });
    expect(screen.getByTestId('idea-support')).toHaveTextContent(
      '2 votes from 2 businesses · 3 following',
    );
    expect(screen.getByText('pat@coolair.test')).toBeTruthy();
    expect(screen.getByTestId('idea-updates')).toHaveTextContent('Under review → Planned', {
      exact: false,
    });
    expect(screen.getByText('Pencilled in for spring.')).toBeTruthy();
    expect(screen.getByTestId(`idea-comment-toggle-${COMMENT}`)).toHaveTextContent(
      IDEAS_TEAM_WORDS.takeDown,
    );
    expect(screen.getByTestId(`idea-comment-toggle-${GONE_COMMENT}`)).toHaveTextContent(
      IDEAS_TEAM_WORDS.putBack,
    );
    await fireEvent.press(screen.getByTestId('idea-business'));
    expect(router.push).toHaveBeenCalledWith(`/app/admin/businesses/${LONE_STAR}`);
  });

  it('moves it along the roadmap with a note, and asks for the idea again', async () => {
    await showDesk(<DeskIdea />, () => answers);
    await fireEvent.press(await screen.findByTestId('idea-status-pick'));
    await fireEvent.press(screen.getByTestId('idea-status-planned'));
    expect(screen.getByTestId('idea-status-save')).toHaveTextContent('Move to Planned');
    await fireEvent.changeText(screen.getByTestId('idea-status-note'), '  Pencilled in.  ');
    await fireEvent(screen.getByTestId('idea-status-notify'), 'checkedChange', false);
    await fireEvent.press(screen.getByTestId('idea-status-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea.set_status')).toEqual({
        ideaId: IDEA,
        status: 'planned',
        note: 'Pencilled in.',
        notify: false,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(IDEAS_DESK_WORDS.moved('planned'));
    await waitFor(() => expect(sent('/v1/queries/idea.get')).toHaveLength(2));
  });

  it('posts an update without moving it, once there is a note', async () => {
    await showDesk(<DeskIdea />, () => answers);
    await fireEvent.press(await screen.findByTestId('idea-post-update'));
    expect(screen.getByTestId('idea-status-save')).toHaveTextContent(IDEAS_TEAM_WORDS.postUpdate);
    expect(screen.getByTestId('idea-status-save').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.changeText(screen.getByTestId('idea-status-note'), 'Still reading these.');
    await fireEvent.press(screen.getByTestId('idea-status-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea.set_status')).toEqual({
        ideaId: IDEA,
        status: 'under_review',
        note: 'Still reading these.',
        notify: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(IDEAS_DESK_WORDS.updatePosted);
  });

  it('answers as the team', async () => {
    await showDesk(<DeskIdea />, () => answers);
    await fireEvent.press(await screen.findByTestId('team-answer-open'));
    await fireEvent.changeText(screen.getByTestId('team-answer'), ' Which invoices? ');
    await fireEvent.press(screen.getByTestId('team-answer-post'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea.comment')).toEqual({
        ideaId: IDEA,
        body: 'Which invoices?',
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(IDEAS_DESK_WORDS.answerPosted);
  });

  it('says what went wrong when an answer can’t go', async () => {
    answers['/v1/commands/idea.comment'] = null;
    await showDesk(<DeskIdea />, () => answers);
    await fireEvent.press(await screen.findByTestId('team-answer-open'));
    await fireEvent.changeText(screen.getByTestId('team-answer'), 'Which invoices?');
    await fireEvent.press(screen.getByTestId('team-answer-post'));
    expect(await screen.findByText('No signal. Try again when you’re back online.')).toBeTruthy();
  });

  it('tidies its words and moves it to another area', async () => {
    await showDesk(<DeskIdea />, () => answers);
    await fireEvent.press(await screen.findByTestId('idea-tidy'));
    await fireEvent.changeText(screen.getByTestId('idea-edit-title'), 'Send invoices by text ');
    await fireEvent.changeText(screen.getByTestId('idea-edit-body'), 'With a pay link, please.');
    expect(screen.getByText('Texting (archived)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('idea-edit-area-other'));
    await fireEvent.press(screen.getByTestId('idea-edit-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea.edit')).toEqual({
        ideaId: IDEA,
        title: 'Send invoices by text',
        body: 'With a pay link, please.',
        areaId: 'other',
      }),
    );
  });

  it('takes it off the board, and takes a comment down or puts one back', async () => {
    await showDesk(<DeskIdea />, () => answers);
    await fireEvent.press(await screen.findByTestId('idea-hide'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea.set_hidden')).toEqual({ ideaId: IDEA, hidden: true }),
    );
    expect(toast.show).toHaveBeenCalledWith(IDEAS_DESK_WORDS.hidden);
    await fireEvent.press(screen.getByTestId(`idea-comment-toggle-${COMMENT}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea.set_comment_hidden')).toEqual({
        commentId: COMMENT,
        hidden: true,
      }),
    );
    await fireEvent.press(screen.getByTestId(`idea-comment-toggle-${GONE_COMMENT}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea.set_comment_hidden')).toEqual({
        commentId: GONE_COMMENT,
        hidden: false,
      }),
    );
  });

  it('merges a duplicate into the idea it repeats, with a note for its followers', async () => {
    await showDesk(<DeskIdea />, () => answers);
    await fireEvent.press(await screen.findByTestId('idea-merge-9'));
    expect(lastBody('/v1/queries/idea.similar')).toEqual({
      text: 'Send invoices by text',
      excludeIdeaId: IDEA,
    });
    expect(screen.getByText(IDEAS_TEAM_WORDS.mergeQuestion(14, 9))).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('idea-merge-note'), 'Same idea, more votes.');
    await fireEvent.press(screen.getByTestId('idea-merge-confirm'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea.merge')).toEqual({
        ideaId: IDEA,
        intoIdeaId: TWIN,
        note: 'Same idea, more votes.',
        notify: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(IDEAS_DESK_WORDS.merged(9));
  });

  it('lets only a lead or an admin move it along the roadmap', async () => {
    await showDesk(<DeskIdea />, () => answers, agent);
    await screen.findByTestId('idea-title');
    expect(screen.queryByTestId('idea-status-form')).toBeNull();
    expect(screen.queryByTestId('idea-status-sheet')).toBeNull();
    // Answering, tidying, merging and taking down are every support role's.
    expect(screen.getByTestId('team-answer-open')).toBeTruthy();
    expect(screen.getByTestId('idea-tidy')).toBeTruthy();
    expect(screen.getByTestId('idea-hide')).toBeTruthy();
    expect(await screen.findByTestId('idea-merge-9')).toBeTruthy();
  });

  it('points a merged idea at where it went, with nothing left to answer or merge', async () => {
    answers['/v1/queries/idea.get'] = IDEA_FULL({
      mergedInto: { id: TWIN, number: 9, title: 'Text invoices to customers' },
    });
    await showDesk(<DeskIdea />, () => answers);
    await fireEvent.press(await screen.findByTestId('idea-merged'));
    expect(router.push).toHaveBeenCalledWith(`/app/admin/ideas/${TWIN}`);
    expect(screen.queryByTestId('team-answer-open')).toBeNull();
    expect(screen.queryByTestId('idea-duplicate')).toBeNull();
    expect(screen.queryByTestId('idea-status-form')).toBeNull();
    expect(sent('/v1/queries/idea.similar')).toHaveLength(0);
  });

  it('says it needs a signal', async () => {
    answers['/v1/queries/idea.get'] = null;
    setTestOffline(true);
    await showDesk(<DeskIdea />, () => answers);
    await screen.findByTestId('idea-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
  });
});

describe('the areas', () => {
  it('archives an area, or brings one back, and keeps Something else', async () => {
    await showDesk(<DeskIdeaAreas />, () => answers);
    expect(await screen.findByText('Getting paid · 4 open')).toBeTruthy();
    expect(screen.queryByTestId('idea-area-archive-other')).toBeNull();
    await fireEvent.press(screen.getByTestId('idea-area-archive-invoices'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea_area.save')).toEqual({
        id: 'invoices',
        name: 'Invoices',
        description: 'Getting paid',
        sort: 10,
        archived: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(IDEA_AREAS_WORDS.saved);
    expect(screen.getByTestId('idea-area-archive-texting')).toHaveTextContent(
      IDEA_AREAS_WORDS.bringBack,
    );
  });

  it('adds one after the last, named from its words', async () => {
    await showDesk(<DeskIdeaAreas />, () => answers);
    await fireEvent.press(await screen.findByTestId('idea-area-add'));
    await fireEvent.changeText(screen.getByTestId('idea-area-name'), ' Service plans ');
    await fireEvent.changeText(
      screen.getByTestId('idea-area-description'),
      'Maintenance agreements',
    );
    await fireEvent.press(screen.getByTestId('idea-area-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/idea_area.save')).toEqual({
        id: 'service_plans',
        name: 'Service plans',
        description: 'Maintenance agreements',
        sort: 30,
        archived: false,
      }),
    );
    await waitFor(() => expect(sent('/v1/queries/idea.areas')).toHaveLength(2));
  });

  it('asks for a word or two when the name makes no id', async () => {
    await showDesk(<DeskIdeaAreas />, () => answers);
    await fireEvent.press(await screen.findByTestId('idea-area-add'));
    await fireEvent.changeText(screen.getByTestId('idea-area-name'), '!!');
    await fireEvent.press(screen.getByTestId('idea-area-save'));
    expect(toast.error).toHaveBeenCalledWith(IDEA_AREAS_WORDS.needsName);
    expect(sent('/v1/commands/idea_area.save')).toHaveLength(0);
  });

  it('is only for leads and admins', async () => {
    await showDesk(<DeskIdeaAreas />, () => answers, agent);
    expect(await screen.findByText(IDEAS_DESK_WORDS.areasManageOnly)).toBeTruthy();
    expect(sent('/v1/queries/idea.areas')).toHaveLength(0);
  });
});

describe('What’s new', () => {
  it('shows the drafts first, then what went out, with the ideas each delivers', async () => {
    await showDesk(<DeskWhatsNew />, () => answers);
    expect(await screen.findByText('Invoices by text')).toBeTruthy();
    expect(lastBody('/v1/queries/whats_new.list')).toEqual({ includeDrafts: true, limit: 50 });
    expect(screen.getByTestId(`wn-entry-${DRAFT}`)).toHaveTextContent(WHATS_NEW_TEAM_WORDS.draft, {
      exact: false,
    });
    expect(screen.getByTestId(`wn-entry-${SHIPPED}`)).toHaveTextContent('Published Sep 9, 2026', {
      exact: false,
    });
    expect(screen.getByTestId('wn-idea-14')).toHaveTextContent(
      '#14 Send invoices by text (Planned)',
    );
    await fireEvent.press(screen.getByTestId('wn-idea-14'));
    expect(router.push).toHaveBeenCalledWith(`/app/admin/ideas/${IDEA}`);
  });

  it('writes an entry, linking the idea it delivers', async () => {
    await showDesk(<DeskWhatsNew />, () => answers);
    await fireEvent.press(await screen.findByTestId('whats-new-add'));
    await fireEvent.changeText(screen.getByTestId('wn-title'), ' Invoices by text ');
    await fireEvent.press(screen.getByTestId('wn-kind-improved'));
    await fireEvent.press(screen.getByTestId('wn-area-invoices'));
    await fireEvent.changeText(screen.getByTestId('wn-body'), 'Send one as a text.');
    await fireEvent.changeText(screen.getByTestId('wn-find'), 'text invoices');
    await fireEvent.press(await screen.findByTestId('wn-found-9'));
    expect(lastBody('/v1/queries/idea.similar')).toEqual({ text: 'text invoices' });
    expect(screen.getByTestId('wn-linked-9')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('wn-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/whats_new.save')).toEqual({
        title: 'Invoices by text',
        body: 'Send one as a text.',
        kind: 'improved',
        areaId: 'invoices',
        ideaIds: [TWIN],
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(WHATS_NEW_TEAM_WORDS.savedDraft);
  });

  it('changes a draft, taking an idea off it', async () => {
    await showDesk(<DeskWhatsNew />, () => answers);
    await screen.findByTestId(`wn-entry-${DRAFT}`);
    await fireEvent.press(screen.getAllByTestId('wn-edit')[0]!);
    await fireEvent.press(screen.getByTestId('wn-unlink-14'));
    await fireEvent.press(screen.getByTestId('wn-area-'));
    await fireEvent.press(screen.getByTestId('wn-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/whats_new.save')).toEqual({
        id: DRAFT,
        title: 'Invoices by text',
        body: 'Send an invoice as a text with a pay link.',
        kind: 'new',
        areaId: null,
        ideaIds: [],
      }),
    );
  });

  it('publishes a draft once asked, marking its idea Done unless told not to', async () => {
    await showDesk(<DeskWhatsNew />, () => answers);
    await fireEvent.press(await screen.findByTestId('wn-publish'));
    expect(screen.getByTestId('wn-confirm-question')).toHaveTextContent(
      'Publish “Invoices by text”? Its idea becomes Done and everybody following it is emailed.',
    );
    await fireEvent.press(screen.getByTestId('wn-confirm-yes'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/whats_new.publish')).toEqual({
        id: DRAFT,
        markIdeasDone: true,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(WHATS_NEW_TEAM_WORDS.publishedToast);

    await fireEvent(screen.getByTestId('whats-new-mark-done'), 'checkedChange', false);
    await fireEvent.press(screen.getByTestId('wn-publish'));
    expect(screen.getByTestId('wn-confirm-question')).toHaveTextContent(
      'Publish “Invoices by text” for every business to read?',
    );
    await fireEvent.press(screen.getByTestId('wn-confirm-yes'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/whats_new.publish')).toEqual({
        id: DRAFT,
        markIdeasDone: false,
      }),
    );
  });

  it('takes a published entry back to a draft, and deletes a draft once asked', async () => {
    await showDesk(<DeskWhatsNew />, () => answers);
    await fireEvent.press(await screen.findByTestId('wn-unpublish'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/whats_new.unpublish')).toEqual({ id: SHIPPED }),
    );
    expect(toast.show).toHaveBeenCalledWith(WHATS_NEW_TEAM_WORDS.unpublished);
    await fireEvent.press(screen.getByTestId('wn-delete'));
    expect(screen.getByTestId('wn-confirm-question')).toHaveTextContent(
      'Delete the draft “Invoices by text”?',
    );
    expect(sent('/v1/commands/whats_new.delete')).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('wn-confirm-yes'));
    await waitFor(() => expect(lastBody('/v1/commands/whats_new.delete')).toEqual({ id: DRAFT }));
  });

  it('is read-only for somebody who can only answer ideas', async () => {
    await showDesk(<DeskWhatsNew />, () => answers, agent);
    expect(await screen.findByText('Invoices by text')).toBeTruthy();
    expect(screen.queryByTestId('whats-new-add')).toBeNull();
    expect(screen.queryByTestId('whats-new-mark-done')).toBeNull();
    expect(screen.queryByTestId('wn-publish')).toBeNull();
    expect(screen.queryByTestId('wn-edit')).toBeNull();
    expect(screen.queryByTestId('wn-unpublish')).toBeNull();
  });

  it('says it needs a signal', async () => {
    answers['/v1/queries/whats_new.list'] = null;
    setTestOffline(true);
    await showDesk(<DeskWhatsNew />, () => answers);
    await screen.findByTestId('whats-new-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
  });
});
