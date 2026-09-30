import { DESK_WORDS } from '@hfos/core';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import { DESK_PHONE_WORDS } from '@/admin/words';
import Ticket from '@/app/app/admin/tickets/[ticketId]';
import Tickets from '@/app/app/admin/tickets';
import { toast } from '@/components/ui/toast';
import { setTestOffline } from '@/lib/network';

import { agent, LONE_STAR, RILEY, SAM, lastBody, sent, showDesk, type Answers } from './kit';

/**
 * Tickets on the phone's Support desk (the web's /admin/tickets): the queue with its tabs and search, one ticket with
 * its conversation and the AI's draft, writing back or leaving a note, and changing its status, priority and who has
 * it. All of it is live, so with no signal it says so.
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

const TICKET = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const REPLY = '55555555-5555-4555-8555-555555555555';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  id: TICKET,
  number: 1042,
  subject: 'Texts not going out',
  status: 'open',
  priority: 'high',
  channel: 'in_app',
  requester: { userId: null, name: 'Dale Ramsey', email: 'dale@lonestarhvac.test' },
  business: { workspaceId: LONE_STAR, name: 'Lone Star HVAC', organizationId: null },
  assignee: null,
  tags: [],
  preview: 'Since this morning none of our reminders have gone.',
  waitingSince: minutesAgo(40),
  snoozeUntil: null,
  firstResponseAt: null,
  createdAt: minutesAgo(40),
  updatedAt: minutesAgo(40),
  ...over,
});

const SUMMARY = {
  unanswered: 3,
  mine: 1,
  unassigned: 2,
  waitingOnCustomer: 4,
  solvedToday: 6,
  oldestWaitingMinutes: 125,
};

const FULL = {
  ticket: row(),
  messages: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      author: 'customer',
      internal: false,
      authorName: 'Dale Ramsey',
      bodyText: 'Since this morning none of our reminders have gone.',
      bodyHtml: null,
      attachments: [],
      createdAt: minutesAgo(40),
    },
    {
      id: '77777777-7777-4777-8777-777777777777',
      author: 'staff',
      internal: true,
      authorName: 'Riley',
      bodyText: 'Their number’s registration lapsed.',
      bodyHtml: null,
      attachments: [],
      createdAt: minutesAgo(20),
    },
  ],
  events: [
    {
      id: '88888888-8888-4888-8888-888888888888',
      kind: 'opened',
      actorName: 'Dale Ramsey',
      data: {},
      createdAt: minutesAgo(40),
    },
  ],
  draft: {
    bodyText: 'Hi Dale, your texting registration needs renewing.',
    sources: [{ kind: 'canned_reply', title: 'Texting registration', id: null }],
    model: 'claude',
    createdAt: minutesAgo(10),
    stale: false,
  },
  business: {
    workspaceId: LONE_STAR,
    name: 'Lone Star HVAC',
    organizationName: 'Lone Star Group',
    createdAt: '2026-08-01T15:00:00.000Z',
    memberCount: 4,
    openTicketCount: 1,
  },
  alsoFrom: [{ id: OTHER, number: 998, subject: 'Invoice question', status: 'solved' }],
};

const STAFF = {
  staff: [
    {
      userId: SAM,
      fullName: 'Sam Carter',
      email: 'sam@handsfreeos.test',
      displayName: 'Sam',
      role: 'admin',
      status: 'active',
      openTicketCount: 2,
      createdAt: minutesAgo(9000),
    },
    {
      userId: RILEY,
      fullName: 'Riley Chen',
      email: 'riley@handsfreeos.test',
      displayName: '',
      role: 'agent',
      status: 'active',
      openTicketCount: 1,
      createdAt: minutesAgo(9000),
    },
  ],
  invitations: [],
};

const REPLIES = {
  replies: [
    {
      id: REPLY,
      title: 'Texting registration',
      bodyText: 'Your texting registration needs renewing.',
      updatedAt: minutesAgo(900),
    },
  ],
};

let answers: Answers;

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
  mockParams = { ticketId: TICKET };
  answers = {
    '/v1/queries/support.queue.summary': SUMMARY,
    '/v1/queries/support.ticket.list': { tickets: [row()], nextCursor: null },
    '/v1/queries/support.ticket.get': FULL,
    '/v1/queries/support.staff.list': STAFF,
    '/v1/queries/support.canned_reply.list': REPLIES,
    '/v1/commands/support.ticket.reply': { messageId: REPLY },
    '/v1/commands/support.ticket.set_status': { ticketId: TICKET },
    '/v1/commands/support.ticket.set_priority': { ticketId: TICKET },
    '/v1/commands/support.ticket.assign': { ticketId: TICKET },
    '/v1/commands/support.ticket.request_draft': { ticketId: TICKET },
    '/v1/commands/support.ticket.dismiss_draft': { ticketId: TICKET },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('the queue', () => {
  it('opens on Needs an answer, with the counts beside the tabs and the day’s line at the top', async () => {
    await showDesk(<Tickets />, () => answers);
    expect(await screen.findByText('Texts not going out')).toBeTruthy();
    expect(lastBody('/v1/queries/support.ticket.list')).toEqual({
      status: ['new', 'open'],
      assignee: 'anyone',
      limit: 25,
    });
    expect(screen.getByText('6 solved in the last day · oldest unanswered 2 hours')).toBeTruthy();
    expect(screen.getByTestId('queue-filter-unanswered')).toHaveTextContent('Needs an answer3');
    // Nobody has it yet, it's high, and who and which business it's from are on the row.
    expect(screen.getByTestId('ticket-row-1042')).toHaveTextContent(DESK_WORDS.nobodyYet, {
      exact: false,
    });
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Dale Ramsey · Lone Star HVAC · Open')).toBeTruthy();
  });

  it('asks for what each tab means, and searches a moment after the typing stops', async () => {
    await showDesk(<Tickets />, () => answers);
    await screen.findByText('Texts not going out');
    await fireEvent.press(screen.getByTestId('queue-filter-mine'));
    await waitFor(() =>
      expect(lastBody('/v1/queries/support.ticket.list')).toEqual({
        status: ['new', 'open', 'waiting_on_customer'],
        assignee: 'mine',
        limit: 25,
      }),
    );
    answers['/v1/queries/support.ticket.list'] = { tickets: [], nextCursor: null };
    await fireEvent.changeText(screen.getByTestId('ticket-search'), '#1042');
    await waitFor(() =>
      expect(lastBody('/v1/queries/support.ticket.list')).toMatchObject({ search: '#1042' }),
    );
    expect(await screen.findByText(DESK_WORDS.queueEmptyFiltered)).toBeTruthy();
  });

  it('opens a ticket from its row', async () => {
    await showDesk(<Tickets />, () => answers);
    await fireEvent.press(await screen.findByTestId('ticket-row-1042'));
    expect(router.push).toHaveBeenCalledWith(`/app/admin/tickets/${TICKET}`);
  });

  it('says it needs a signal, and Try again asks once more', async () => {
    answers['/v1/queries/support.ticket.list'] = null;
    setTestOffline(true);
    await showDesk(<Tickets />, () => answers);
    await screen.findByTestId('tickets-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
    answers['/v1/queries/support.ticket.list'] = { tickets: [row()], nextCursor: null };
    setTestOffline(false);
    await fireEvent.press(screen.getByTestId('desk-retry'));
    expect(await screen.findByText('Texts not going out')).toBeTruthy();
  });
});

describe('one ticket', () => {
  it('shows the conversation, the internal note marked, the draft and what the web has beside it', async () => {
    await showDesk(<Ticket />, () => answers);
    expect(await screen.findByTestId('ticket-subject')).toHaveTextContent('Texts not going out');
    expect(screen.getByText('Riley · internal note')).toBeTruthy();
    expect(screen.getByTestId('ticket-draft')).toHaveTextContent('From: Texting registration', {
      exact: false,
    });
    expect(screen.getByTestId('ticket-business')).toHaveTextContent('Lone Star Group · 4 people', {
      exact: false,
    });
    expect(screen.getByText('#998 Invoice question · Solved')).toBeTruthy();
    expect(screen.getByTestId('ticket-events')).toHaveTextContent('Opened', { exact: false });
  });

  it('writes back with a saved reply, and asks for the ticket again once it has gone', async () => {
    await showDesk(<Ticket />, () => answers);
    await fireEvent.press(await screen.findByTestId('reply-open'));
    await fireEvent.press(screen.getByTestId(`saved-reply-${REPLY}`));
    expect(screen.getByTestId('reply-box').props.value).toBe(
      'Your texting registration needs renewing.',
    );
    await fireEvent.press(screen.getByTestId('reply-send'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.ticket.reply')).toEqual({
        ticketId: TICKET,
        body: 'Your texting registration needs renewing.',
        internal: false,
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(DESK_PHONE_WORDS.sent);
    await waitFor(() => expect(sent('/v1/queries/support.ticket.get')).toHaveLength(2));
  });

  it('leaves an internal note, and says what went wrong when it can’t', async () => {
    answers['/v1/commands/support.ticket.reply'] = null;
    await showDesk(<Ticket />, () => answers);
    await fireEvent.press(await screen.findByTestId('note-open'));
    await fireEvent.changeText(screen.getByTestId('reply-box'), 'Checked their A2P status.');
    await fireEvent.press(screen.getByTestId('reply-send'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.ticket.reply')).toMatchObject({ internal: true }),
    );
    expect(await screen.findByText('No signal. Try again when you’re back online.')).toBeTruthy();
  });

  it('puts the draft in the box, or turns it down', async () => {
    await showDesk(<Ticket />, () => answers);
    await fireEvent.press(await screen.findByTestId('draft-use'));
    expect(screen.getByTestId('reply-box').props.value).toBe(
      'Hi Dale, your texting registration needs renewing.',
    );
    await fireEvent.press(screen.getByTestId('draft-dismiss'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.ticket.dismiss_draft')).toEqual({ ticketId: TICKET }),
    );
  });

  it('changes its status and priority, and gives it to somebody', async () => {
    await showDesk(<Ticket />, () => answers);
    await fireEvent.press(await screen.findByTestId('ticket-status'));
    await fireEvent.press(screen.getByTestId('pick-status-solved'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.ticket.set_status')).toEqual({
        ticketId: TICKET,
        status: 'solved',
      }),
    );
    await fireEvent.press(screen.getByTestId('ticket-priority'));
    await fireEvent.press(screen.getByTestId('pick-priority-urgent'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.ticket.set_priority')).toEqual({
        ticketId: TICKET,
        priority: 'urgent',
      }),
    );
    await fireEvent.press(screen.getByTestId('ticket-assignee'));
    expect(screen.getByText('Sam (me)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`pick-assignee-${RILEY}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.ticket.assign')).toEqual({
        ticketId: TICKET,
        assigneeUserId: RILEY,
      }),
    );
  });

  it('lets only a lead or an admin give it to somebody', async () => {
    await showDesk(<Ticket />, () => answers, agent);
    await fireEvent.press(await screen.findByTestId('ticket-assignee'));
    expect(screen.queryByTestId('pick-assignee')).toBeNull();
    expect(sent('/v1/queries/support.staff.list')).toHaveLength(0);
  });

  it('opens their account page here, and looking at the business on the web', async () => {
    const { openWeb } = jest.requireMock('@/lib/open-web') as { openWeb: jest.Mock };
    await showDesk(<Ticket />, () => answers);
    await fireEvent.press(await screen.findByTestId('ticket-open-business'));
    expect(router.push).toHaveBeenCalledWith(`/app/admin/businesses/${LONE_STAR}`);
    await fireEvent.press(screen.getByTestId('ticket-look-on-web'));
    expect(openWeb).toHaveBeenCalledWith(`/admin/tickets/${TICKET}`);
  });
});
