import { SAVED_REPLY_WORDS, SUPPORT_TEAM_WORDS } from '@hfos/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { cachedStaff } from '@/admin/staff';
import { REPLIES_PHONE_WORDS, TEAM_PHONE_WORDS } from '@/admin/team-words';
import { DESK_PHONE_WORDS } from '@/admin/words';
import SavedReplies from '@/app/app/admin/replies';
import SupportPeople from '@/app/app/admin/staff';
import { toast } from '@/components/ui/toast';
import { setTestOffline } from '@/lib/network';

import {
  ADMIN_PERMISSIONS,
  agent,
  RILEY,
  SAM,
  lastBody,
  sent,
  showDesk,
  type Answers,
} from './kit';

/**
 * Saved replies and Support people on the phone's Support desk (the web's /admin/replies and /admin/staff): reading
 * them, every change with the same body the web sends, asking first before deleting or removing, and only the people
 * the API lets change them seeing the controls. All of it is live, so with no signal it says so.
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

const REPLY = '55555555-5555-4555-8555-555555555555';
const OTHER_REPLY = '56565656-5656-4565-8565-565656565656';
const JO = '99999999-9999-4999-8999-999999999999';
const INVITE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const REPLIES = {
  replies: [
    {
      id: REPLY,
      title: 'Texting registration',
      bodyText: 'Your texting registration needs renewing.',
      updatedAt: '2026-09-29T15:00:00.000Z',
    },
    {
      id: OTHER_REPLY,
      title: 'Resetting a password',
      bodyText: 'Press Forgot password on the sign-in page.',
      updatedAt: '2026-09-28T15:00:00.000Z',
    },
  ],
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
      createdAt: '2026-08-01T15:00:00.000Z',
    },
    {
      userId: RILEY,
      fullName: 'Riley Chen',
      email: 'riley@handsfreeos.test',
      displayName: '',
      role: 'agent',
      status: 'active',
      openTicketCount: 1,
      createdAt: '2026-08-02T15:00:00.000Z',
    },
    {
      userId: JO,
      fullName: '',
      email: 'jo@handsfreeos.test',
      displayName: '',
      role: 'lead',
      status: 'suspended',
      openTicketCount: 0,
      createdAt: '2026-08-03T15:00:00.000Z',
    },
  ],
  invitations: [
    {
      id: INVITE,
      email: 'pat@handsfreeos.test',
      role: 'lead',
      invitedByName: 'Sam Carter',
      sentAt: '2026-09-29T15:00:00.000Z',
      expiresAt: '2026-10-06T15:00:00.000Z',
      createdAt: '2026-09-29T15:00:00.000Z',
    },
  ],
};

let myName = 'Sam';
const me = () => ({
  staff: {
    userId: SAM,
    role: 'admin',
    displayName: myName,
    signature: '— Sam at HandsFreeOS',
    permissions: ADMIN_PERMISSIONS,
    founder: false,
  },
});

let answers: Answers;

beforeEach(() => {
  jest.clearAllMocks();
  setTestOffline(false);
  mockParams = {};
  myName = 'Sam';
  answers = {
    '/v1/queries/support.canned_reply.list': REPLIES,
    '/v1/commands/support.canned_reply.save': { id: REPLY },
    '/v1/commands/support.canned_reply.delete': { id: REPLY },
    '/v1/queries/support.staff.list': STAFF,
    '/v1/queries/platform.me': me,
    '/v1/commands/support.staff.save_profile': (body: { displayName: string }) => {
      myName = body.displayName;
      return { userId: SAM };
    },
    '/v1/commands/support.staff.invite': { invitationId: INVITE },
    '/v1/commands/support.staff.resend_invitation': { invitationId: INVITE },
    '/v1/commands/support.staff.revoke_invitation': { invitationId: INVITE },
    '/v1/commands/support.staff.set_role': { userId: RILEY },
    '/v1/commands/support.staff.remove': { userId: RILEY },
  };
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('saved replies', () => {
  it('lists them, their words in full', async () => {
    await showDesk(<SavedReplies />, () => answers);
    expect(await screen.findByText('Texting registration')).toBeTruthy();
    expect(screen.getByText('Your texting registration needs renewing.')).toBeTruthy();
    expect(screen.getByText('Resetting a password')).toBeTruthy();
    expect(screen.getByText(SAVED_REPLY_WORDS.intro)).toBeTruthy();
    expect(screen.getByTestId('reply-new')).toBeTruthy();
  });

  it('adds one, with the words trimmed as the web sends them', async () => {
    await showDesk(<SavedReplies />, () => answers);
    await fireEvent.press(await screen.findByTestId('reply-new'));
    expect(screen.getByTestId('reply-save')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('reply-title'), '  Card declined ');
    await fireEvent.changeText(screen.getByTestId('reply-body'), ' Ask them to try another card. ');
    await fireEvent.press(screen.getByTestId('reply-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.canned_reply.save')).toEqual({
        title: 'Card declined',
        bodyText: 'Ask them to try another card.',
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(REPLIES_PHONE_WORDS.saved);
    await waitFor(() => expect(sent('/v1/queries/support.canned_reply.list')).toHaveLength(2));
  });

  it('changes one, and says why when it can’t', async () => {
    answers['/v1/commands/support.canned_reply.save'] = null;
    await showDesk(<SavedReplies />, () => answers);
    await fireEvent.press(await screen.findByTestId(`reply-edit-${REPLY}`));
    expect(screen.getByTestId('reply-title').props.value).toBe('Texting registration');
    await fireEvent.changeText(
      screen.getByTestId('reply-body'),
      'Your texting registration has lapsed.',
    );
    await fireEvent.press(screen.getByTestId('reply-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.canned_reply.save')).toEqual({
        id: REPLY,
        title: 'Texting registration',
        bodyText: 'Your texting registration has lapsed.',
      }),
    );
    expect(await screen.findByText('No signal. Try again when you’re back online.')).toBeTruthy();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('asks before deleting one, and Keep it deletes nothing', async () => {
    await showDesk(<SavedReplies />, () => answers);
    await fireEvent.press(await screen.findByTestId(`reply-edit-${REPLY}`));
    await fireEvent.press(screen.getByTestId('reply-delete'));
    expect(screen.getByText(REPLIES_PHONE_WORDS.deleteTitle)).toBeTruthy();
    expect(sent('/v1/commands/support.canned_reply.delete')).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('reply-delete-keep'));
    expect(screen.getByTestId('reply-title')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('reply-delete'));
    await fireEvent.press(screen.getByTestId('reply-delete-confirm'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.canned_reply.delete')).toEqual({ id: REPLY }),
    );
    expect(toast.show).toHaveBeenCalledWith(REPLIES_PHONE_WORDS.deleted);
  });

  it('shows an agent the replies but nothing to change them with', async () => {
    await showDesk(<SavedReplies />, () => answers, agent);
    expect(await screen.findByText('Texting registration')).toBeTruthy();
    expect(screen.queryByTestId('reply-new')).toBeNull();
    expect(screen.queryByTestId(`reply-edit-${REPLY}`)).toBeNull();
    expect(screen.getByText(REPLIES_PHONE_WORDS.whoKeeps)).toBeTruthy();
  });

  it('says when there are none yet', async () => {
    answers['/v1/queries/support.canned_reply.list'] = { replies: [] };
    await showDesk(<SavedReplies />, () => answers);
    expect(await screen.findByTestId('replies-empty')).toHaveTextContent(
      `${SAVED_REPLY_WORDS.emptyTitle}${SAVED_REPLY_WORDS.emptyBody}`,
    );
  });

  it('says it needs a signal, asks again when it has one, and Try again asks once more', async () => {
    answers['/v1/queries/support.canned_reply.list'] = null;
    setTestOffline(true);
    await showDesk(<SavedReplies />, () => answers);
    await screen.findByTestId('replies-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
    // Back in signal, it asks by itself; this time the API still can't answer, so it says the API's words.
    await act(async () => setTestOffline(false));
    expect(await screen.findByText('No signal. Try again when you’re back online.')).toBeTruthy();
    expect(sent('/v1/queries/support.canned_reply.list')).toHaveLength(2);
    answers['/v1/queries/support.canned_reply.list'] = REPLIES;
    await fireEvent.press(screen.getByTestId('desk-retry'));
    expect(await screen.findByText('Texting registration')).toBeTruthy();
  });
});

describe('support people', () => {
  it('lists who answers, with their roles and open tickets, and who is invited', async () => {
    await showDesk(<SupportPeople />, () => answers);
    const sam = await screen.findByTestId(`staff-row-${SAM}`);
    expect(sam).toHaveTextContent('Sam · you', { exact: false });
    expect(sam).toHaveTextContent('sam@handsfreeos.test · 2 open tickets', { exact: false });
    expect(screen.getByTestId(`staff-row-${RILEY}`)).toHaveTextContent(
      'riley@handsfreeos.test · 1 open ticket',
      { exact: false },
    );
    expect(screen.getByTestId(`staff-row-${JO}`)).toHaveTextContent(
      'jo@handsfreeos.test · 0 open tickets · suspended',
      { exact: false },
    );
    expect(screen.getByTestId(`staff-role-${RILEY}`)).toHaveTextContent('Support agent');
    const invitation = screen.getByTestId(`staff-invitation-${INVITE}`);
    expect(invitation).toHaveTextContent('pat@handsfreeos.test', { exact: false });
    expect(invitation).toHaveTextContent('Support lead · invited by Sam Carter · link expires', {
      exact: false,
    });
  });

  it('never offers anyone a change to their own role', async () => {
    await showDesk(<SupportPeople />, () => answers);
    await screen.findByTestId(`staff-row-${SAM}`);
    expect(screen.queryByTestId(`staff-role-${SAM}`)).toBeNull();
    expect(screen.queryByTestId(`staff-suspend-${SAM}`)).toBeNull();
    expect(screen.queryByTestId(`staff-remove-${SAM}`)).toBeNull();
    expect(screen.getByTestId(`staff-role-word-${SAM}`)).toHaveTextContent('Support admin');
  });

  it('shows an agent the team, with no invite, role or remove controls', async () => {
    await showDesk(<SupportPeople />, () => answers, agent);
    await screen.findByTestId(`staff-row-${RILEY}`);
    expect(screen.queryByTestId('staff-invite-open')).toBeNull();
    expect(screen.queryByTestId(`staff-role-${RILEY}`)).toBeNull();
    expect(screen.queryByTestId(`staff-suspend-${RILEY}`)).toBeNull();
    expect(screen.queryByTestId(`staff-remove-${RILEY}`)).toBeNull();
    expect(screen.queryByTestId(`invitation-resend-${INVITE}`)).toBeNull();
    expect(screen.queryByTestId(`invitation-revoke-${INVITE}`)).toBeNull();
    expect(screen.getByTestId(`staff-role-word-${RILEY}`)).toHaveTextContent('Support agent');
    // An agent still signs off their own replies.
    expect(await screen.findByTestId('staff-profile')).toBeTruthy();
  });

  it('changes someone’s role', async () => {
    await showDesk(<SupportPeople />, () => answers);
    await fireEvent.press(await screen.findByTestId(`staff-role-${RILEY}`));
    await fireEvent.press(screen.getByTestId('pick-role-lead'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.staff.set_role')).toEqual({
        userId: RILEY,
        role: 'lead',
      }),
    );
    expect(toast.show).toHaveBeenCalledWith(TEAM_PHONE_WORDS.roleChanged);
    await waitFor(() => expect(sent('/v1/queries/support.staff.list')).toHaveLength(2));
  });

  it('asks before suspending someone, and lets a suspended person back in straight away', async () => {
    await showDesk(<SupportPeople />, () => answers);
    await fireEvent.press(await screen.findByTestId(`staff-suspend-${RILEY}`));
    expect(screen.getByText(TEAM_PHONE_WORDS.suspendTitle('Riley Chen'))).toBeTruthy();
    expect(sent('/v1/commands/support.staff.set_role')).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('staff-suspend-confirm'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.staff.set_role')).toEqual({
        userId: RILEY,
        status: 'suspended',
      }),
    );
    expect(screen.getByTestId(`staff-suspend-${JO}`)).toHaveTextContent(
      SUPPORT_TEAM_WORDS.letBackIn,
    );
    await fireEvent.press(screen.getByTestId(`staff-suspend-${JO}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.staff.set_role')).toEqual({
        userId: JO,
        status: 'active',
      }),
    );
  });

  it('asks before removing someone, and Keep them removes nobody', async () => {
    await showDesk(<SupportPeople />, () => answers);
    await fireEvent.press(await screen.findByTestId(`staff-remove-${RILEY}`));
    expect(screen.getByText(TEAM_PHONE_WORDS.removeTitle('Riley Chen'))).toBeTruthy();
    await fireEvent.press(screen.getByTestId('staff-confirm-keep'));
    expect(sent('/v1/commands/support.staff.remove')).toHaveLength(0);
    await fireEvent.press(screen.getByTestId(`staff-remove-${RILEY}`));
    await fireEvent.press(screen.getByTestId('staff-remove-confirm'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.staff.remove')).toEqual({ userId: RILEY }),
    );
    expect(toast.show).toHaveBeenCalledWith(TEAM_PHONE_WORDS.removed);
  });

  it('says what the API said when removing someone is refused', async () => {
    answers['/v1/commands/support.staff.remove'] = null;
    await showDesk(<SupportPeople />, () => answers);
    await fireEvent.press(await screen.findByTestId(`staff-remove-${RILEY}`));
    await fireEvent.press(screen.getByTestId('staff-remove-confirm'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('No signal. Try again when you’re back online.'),
    );
  });

  it('sends an invitation again, or cancels it', async () => {
    await showDesk(<SupportPeople />, () => answers);
    await fireEvent.press(await screen.findByTestId(`invitation-resend-${INVITE}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.staff.resend_invitation')).toEqual({
        invitationId: INVITE,
      }),
    );
    await fireEvent.press(screen.getByTestId(`invitation-revoke-${INVITE}`));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.staff.revoke_invitation')).toEqual({
        invitationId: INVITE,
      }),
    );
  });

  it('invites someone by address and role, and checks the address first', async () => {
    await showDesk(<SupportPeople />, () => answers);
    await fireEvent.press(await screen.findByTestId('staff-invite-open'));
    await fireEvent.changeText(screen.getByTestId('staff-invite-email'), 'not an address');
    await fireEvent.press(screen.getByTestId('staff-invite-send'));
    expect(screen.getByText(SUPPORT_TEAM_WORDS.badEmail)).toBeTruthy();
    expect(sent('/v1/commands/support.staff.invite')).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId('staff-invite-email'), ' dana@handsfreeos.test ');
    await fireEvent.press(screen.getByTestId('staff-invite-role-lead'));
    await fireEvent.press(screen.getByTestId('staff-invite-send'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.staff.invite')).toEqual({
        email: 'dana@handsfreeos.test',
        role: 'lead',
      }),
    );
    const done = await screen.findByTestId('staff-invite-sent');
    expect(done).toHaveTextContent(
      `${SUPPORT_TEAM_WORDS.sentTo} dana@handsfreeos.test. ${SUPPORT_TEAM_WORDS.sevenDays}`,
      { exact: false },
    );
    expect(within(done).getByTestId('staff-invite-done')).toBeTruthy();
    await waitFor(() => expect(sent('/v1/queries/support.staff.list')).toHaveLength(2));
  });

  it('saves how the person signs off, and the desk keeps their new name', async () => {
    await showDesk(<SupportPeople />, () => answers);
    const name = await screen.findByTestId('staff-name');
    expect(name.props.value).toBe('Sam');
    expect(screen.getByTestId('staff-signature').props.value).toBe('— Sam at HandsFreeOS');
    await fireEvent.changeText(name, ' Sam C. ');
    await fireEvent.changeText(screen.getByTestId('staff-signature'), '— Sam C. at HandsFreeOS');
    await fireEvent.press(screen.getByTestId('staff-profile-save'));
    await waitFor(() =>
      expect(lastBody('/v1/commands/support.staff.save_profile')).toEqual({
        displayName: 'Sam C.',
        signature: '— Sam C. at HandsFreeOS',
      }),
    );
    expect(await screen.findByTestId('staff-profile-saved')).toHaveTextContent(
      SUPPORT_TEAM_WORDS.saved,
    );
    // platform.me is asked again, and the phone keeps the new name for the desk's front page.
    await waitFor(() => expect(cachedStaff(SAM)?.staff?.displayName).toBe('Sam C.'));
  });

  it('says it needs a signal, asks again when it has one, and Try again asks once more', async () => {
    answers['/v1/queries/support.staff.list'] = null;
    setTestOffline(true);
    await showDesk(<SupportPeople />, () => answers);
    await screen.findByTestId('staff-error');
    expect(screen.getByText(DESK_PHONE_WORDS.needsSignal)).toBeTruthy();
    await act(async () => setTestOffline(false));
    expect(await screen.findByText('No signal. Try again when you’re back online.')).toBeTruthy();
    expect(sent('/v1/queries/support.staff.list')).toHaveLength(2);
    answers['/v1/queries/support.staff.list'] = STAFF;
    await fireEvent.press(screen.getByTestId('desk-retry'));
    expect(await screen.findByTestId(`staff-row-${RILEY}`)).toBeTruthy();
  });
});
