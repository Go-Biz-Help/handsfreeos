import { conversationOf, groupByCustomer, mailMoves, type ConversationListRow } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import Inbox from '@/app/app/w/[workspaceId]/(tabs)/inbox';
import MyCell from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/my-cell';
import { Composer } from '@/components/inbox/composer';
import {
  ActionsSheet,
  PrivateBanner,
  StatusBanner,
  type SenderActions,
} from '@/components/inbox/conversation-parts';
import { LinkPersonSheet } from '@/components/inbox/link-person-sheet';
import { PEOPLE_SQL } from '@/calendar/queries';
import { ConversationRow } from '@/components/inbox/conversation-row';
import { LaneSwitcher } from '@/components/inbox/lane-switcher';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { change } from '@/changes';
import { CONVERSATIONS_SQL } from '@/inbox/queries';
import type { Me } from '@/lib/businesses';

import HfosPhone from '../../../../modules/hfos-phone';

/**
 * The inbox's screens with React Native Testing Library: a row in the list, the list's boxes (email's Other mail and
 * Spam, and My mail, M19), the conversation's Details and actions (a row's action runs once the sheet is gone; moving
 * email between folders, sharing one's own, and an owner's Delete for good…), the composer (offline words, the From line, photos, a note that turns
 * the box off), and My cell phone (Verify my cell, the press of 1 arriving through the copy, the contacts card with
 * Add to Contacts).
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  // The top bar's mark reads the screen it's on, so the question carries the record (M10 step 17).
  usePathname: () => '/',
}));
jest.mock('@/components/shell/status-strip', () => ({ StatusStrip: () => null }));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return { change: jest.fn(), ChangeError: actual.ChangeError, NEEDS_SIGNAL: actual.NEEDS_SIGNAL };
});
let mockOnline = true;
jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: mockOnline }) }));
let mockParams: Record<string, string> = {};

const DALE = '11111111-1111-4111-8111-111111111111';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
  businesses: [
    {
      id: LONE_STAR,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
    },
  ],
  organizations: [{ id: 'org', name: 'Lone Star HVAC & Roofing', role: 'owner' }],
  fetchedAt: 0,
};

const wrap = (node: React.ReactNode) => (
  <BusinessProvider
    value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
  >
    {node}
  </BusinessProvider>
);

beforeEach(() => {
  mockOnline = true;
  mockParams = {};
  jest.mocked(change).mockReset();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('a row in the list', () => {
  const row: ConversationListRow = {
    id: 'c1',
    channel: 'sms',
    counterpart: '+17135550168',
    status: 'open',
    person_id: null,
    assignee_user_id: null,
    unread_count: 1,
    last_message_at: '2026-09-17T12:50:00.000Z',
    last_preview: 'Thursday works. I have 1:00 PM or 3:00 PM.',
    last_direction: 'inbound',
    awaiting_reply_since: '2026-09-17T12:30:00.000Z',
    snoozed_until: null,
    created_at: '2026-09-17T12:00:00.000Z',
    handled_by: 'ai',
    ai_teammate_id: 't1',
    teammate_name: 'Ava',
    needs_person_since: null,
    handoff_reason: null,
    handoff_note: null,
    taken_over_by: null,
  };

  it('shows the number, the latest message, and Ava is handling with New number', async () => {
    const onPress = jest.fn();
    await render(
      <ConversationRow
        c={conversationOf(row)}
        myUserId={DALE}
        waitThreshold={10}
        timeZone="America/Chicago"
        draftWaiting={false}
        now={Date.parse('2026-09-17T13:04:00.000Z')}
        onPress={onPress}
      />,
    );
    expect(screen.getByTestId('conversation-row-name')).toHaveTextContent('(713) 555-0168');
    expect(screen.getByTestId('conversation-row-preview')).toHaveTextContent(
      'Thursday works. I have 1:00 PM or 3:00 PM.',
    );
    expect(screen.getByTestId('ai-tag')).toHaveTextContent('Ava is handling');
    expect(screen.getByText('New number')).toBeTruthy();
    expect(screen.getByTestId('wait-chip')).toHaveTextContent('Waiting 34 min');
    await fireEvent.press(screen.getByTestId('conversation-row-c1'));
    expect(onPress).toHaveBeenCalledWith('c1');
  });

  it('marks a client’s portal thread Portal, by the client’s name (board 92)', async () => {
    await render(
      <ConversationRow
        c={conversationOf({
          ...row,
          id: 'c-ann',
          channel: 'portal',
          counterpart: 'portal:p-ann:deal-1',
          person_id: 'p-ann',
          first_name: 'Ann',
          last_name: 'Smith',
          handled_by: 'none',
          last_preview: 'Is the roof something we should push on?',
        })}
        myUserId={DALE}
        waitThreshold={60}
        timeZone="America/Chicago"
        draftWaiting={false}
        now={Date.parse('2026-09-17T13:04:00.000Z')}
        onPress={jest.fn()}
      />,
    );
    expect(screen.getByTestId('conversation-row-name')).toHaveTextContent('Ann Smith');
    expect(screen.getByTestId('conversation-row-portal')).toHaveTextContent('Portal');
    expect(screen.queryByText('New number')).toBeNull();
  });

  it('is one row for a customer who texts and emails, as on the web, with a way between them (0089)', async () => {
    const mike = { ...row, person_id: 'p-mike', first_name: 'Mike', last_name: 'Johnson' };
    const [one, ...more] = groupByCustomer(
      [
        { conversation: conversationOf({ ...mike, id: 'c-text', unread_count: 1 }) },
        {
          conversation: conversationOf({
            ...mike,
            id: 'c-mail',
            channel: 'email',
            counterpart: 'mike@example.com',
            unread_count: 2,
            last_message_at: '2026-09-17T12:40:00.000Z',
            line_address: 'info@lonestarhvac.com',
          }),
        },
      ],
      { box: 'all', status: 'open' },
      DALE,
    );
    expect(more).toHaveLength(0);
    await render(
      <ConversationRow
        c={one!.conversation}
        myUserId={DALE}
        waitThreshold={10}
        timeZone="America/Chicago"
        draftWaiting={false}
        now={Date.parse('2026-09-17T13:04:00.000Z')}
        onPress={() => undefined}
      />,
    );
    expect(screen.getByText('Text · Email')).toBeTruthy();
    expect(screen.getByLabelText('3 unread')).toBeTruthy();

    const onPick = jest.fn();
    const onAll = jest.fn();
    const lanes = one!.conversation.lanes!;
    await render(
      <LaneSwitcher lanes={lanes} currentId="c-text" all={false} onPick={onPick} onAll={onAll} />,
    );
    expect(screen.getByTestId('lane-c-mail')).toHaveTextContent('info@lonestarhvac.com2');
    await fireEvent.press(screen.getByTestId('lane-c-mail'));
    expect(onPick).toHaveBeenCalledWith('c-mail');
    await fireEvent.press(screen.getByTestId('lane-all'));
    expect(onAll).toHaveBeenCalledTimes(1);

    // Reading all of them: "All lines" is the one picked, and either line leads back to answering.
    await render(
      <LaneSwitcher lanes={lanes} currentId="c-text" all onPick={onPick} onAll={onAll} />,
    );
    expect(screen.getByTestId('lane-all')).toBeSelected();
    expect(screen.getByTestId('lane-c-text')).not.toBeSelected();
    await fireEvent.press(screen.getByTestId('lane-c-text'));
    expect(onPick).toHaveBeenLastCalledWith('c-text');
  });
});

describe('the list', () => {
  const base = {
    channel: 'sms',
    status: 'open',
    assignee_user_id: null,
    last_direction: 'inbound',
    awaiting_reply_since: null,
    snoozed_until: null,
    created_at: '2026-01-01T12:00:00.000Z',
    handled_by: 'none',
    ai_teammate_id: null,
    teammate_name: null,
    needs_person_since: null,
    handoff_reason: null,
    handoff_note: null,
    taken_over_by: null,
    draft_waiting: 0,
  };
  beforeEach(() => {
    jest.mocked(useQuery).mockImplementation(((sql: string) => ({
      data:
        sql === CONVERSATIONS_SQL
          ? [
              {
                ...base,
                id: 'c-new',
                counterpart: '+17135550101',
                person_id: 'p-new',
                first_name: 'Kim',
                last_name: 'Alvarez',
                unread_count: 0,
                last_message_at: '2026-09-25T12:00:00.000Z',
                last_preview: 'Thanks, see you then.',
              },
              {
                ...base,
                id: 'c-old',
                counterpart: '+17135550102',
                person_id: 'p-old',
                first_name: 'Ghayas',
                last_name: 'Ahmed',
                unread_count: 1,
                last_message_at: '2026-01-08T22:43:00.000Z',
                last_preview: 'Following up on the quote.',
              },
            ]
          : [],
      isLoading: false,
      isFetching: false,
    })) as never);
  });

  it('narrows to the customers with something unread, however far down they are', async () => {
    await render(wrap(<Inbox />));
    expect(screen.getByTestId('conversation-row-c-new')).toBeTruthy();
    // Email's folders are always there; My mail only for someone with mail of their own.
    expect(screen.getByTestId('box-other')).toHaveTextContent('Other mail');
    expect(screen.getByTestId('box-spam')).toHaveTextContent('Spam');
    expect(screen.queryByTestId('box-my-mail')).toBeNull();
    expect(screen.getByTestId('filter-unread')).toHaveTextContent('Unread · 1');
    await fireEvent.press(screen.getByTestId('filter-unread'));
    expect(screen.queryByTestId('conversation-row-c-new')).toBeNull();
    expect(screen.getByTestId('conversation-row-c-old')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('filter-unread'));
    expect(screen.getByTestId('conversation-row-c-new')).toBeTruthy();
  });

  it('says so when nothing is unread', async () => {
    await render(wrap(<Inbox />));
    await fireEvent.press(screen.getByTestId('box-mine'));
    await fireEvent.press(screen.getByTestId('filter-unread'));
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(/Nothing unread/);
  });
});

describe('email’s boxes and My mail (M19)', () => {
  const base = {
    status: 'open',
    person_id: null,
    assignee_user_id: null,
    unread_count: 0,
    last_direction: 'inbound',
    last_preview: 'Hello',
    awaiting_reply_since: null,
    snoozed_until: null,
    created_at: '2026-01-01T12:00:00.000Z',
    last_message_at: '2026-09-25T12:00:00.000Z',
    handled_by: 'none',
    ai_teammate_id: null,
    teammate_name: null,
    needs_person_since: null,
    handoff_reason: null,
    handoff_note: null,
    taken_over_by: null,
    draft_waiting: 0,
  };
  const email = (id: string, over: Record<string, unknown> = {}) => ({
    ...base,
    id,
    channel: 'email',
    counterpart: `${id}@example.com`,
    ...over,
  });
  beforeEach(() => {
    jest.mocked(useQuery).mockImplementation(((sql: string) => ({
      data:
        sql === CONVERSATIONS_SQL
          ? [
              {
                ...base,
                id: 'c-kim',
                channel: 'sms',
                counterpart: '+17135550101',
                person_id: 'p-kim',
                first_name: 'Kim',
                last_name: 'Alvarez',
              },
              email('c-deals', { folder: 'other', unread_count: 1 }),
              email('c-prize', { folder: 'spam' }),
              email('c-mom', { private_to: DALE, unread_count: 2 }),
              email('c-news', { private_to: DALE, folder: 'other' }),
            ]
          : [],
      isLoading: false,
      isFetching: false,
    })) as never);
  });

  it('keeps Other mail and Spam out of the team’s Inbox, each a box of its own', async () => {
    await render(wrap(<Inbox />));
    expect(screen.getByTestId('box-all')).toHaveTextContent('All · 1');
    expect(screen.getByTestId('conversation-row-c-kim')).toBeTruthy();
    expect(screen.queryByTestId('conversation-row-c-deals')).toBeNull();
    expect(screen.getByTestId('box-other')).toHaveTextContent('Other mail · 1');
    expect(screen.getByTestId('box-spam')).toHaveTextContent('Spam · 1');
    await fireEvent.press(screen.getByTestId('box-other'));
    expect(screen.getByTestId('box-other')).toBeSelected();
    expect(screen.getByTestId('conversation-row-c-deals')).toBeTruthy();
    expect(screen.queryByTestId('conversation-row-c-kim')).toBeNull();
    expect(screen.getByTestId('filter-unread')).toHaveTextContent('Unread · 1');
    await fireEvent.press(screen.getByTestId('box-spam'));
    expect(screen.getByTestId('conversation-row-c-prize')).toBeTruthy();
    // Pressed again, back to the Inbox.
    await fireEvent.press(screen.getByTestId('box-spam'));
    expect(screen.getByTestId('conversation-row-c-kim')).toBeTruthy();
  });

  it('opens the person’s own mail, with its own Inbox, Other mail and Spam, and goes back to the team’s', async () => {
    await render(wrap(<Inbox />));
    expect(screen.getByTestId('box-my-mail')).toHaveTextContent('My mail · 1');
    await fireEvent.press(screen.getByTestId('box-my-mail'));
    expect(screen.getByTestId('my-mail')).toHaveTextContent(/^My mail · only you see it/);
    expect(screen.getByTestId('mail-back')).toHaveTextContent('Team inbox');
    expect(screen.queryByTestId('box-mine')).toBeNull();
    expect(screen.queryByTestId('box-other')).toBeNull();
    expect(screen.getByTestId('mail-inbox')).toBeSelected();
    expect(screen.getByTestId('conversation-row-c-mom')).toBeTruthy();
    expect(screen.queryByTestId('conversation-row-c-kim')).toBeNull();
    expect(screen.getByTestId('filter-unread')).toHaveTextContent('Unread · 1');
    await fireEvent.press(screen.getByTestId('mail-other'));
    expect(screen.getByTestId('conversation-row-c-news')).toBeTruthy();
    expect(screen.queryByTestId('conversation-row-c-deals')).toBeNull();
    await fireEvent.press(screen.getByTestId('mail-spam'));
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(/No spam/);
    await fireEvent.press(screen.getByTestId('mail-back'));
    expect(screen.getByTestId('box-mine')).toHaveTextContent('Mine · 0');
    expect(screen.getByTestId('box-all')).toBeSelected();
    expect(screen.getByTestId('conversation-row-c-kim')).toBeTruthy();
  });
});

describe('Details and actions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const row: ConversationListRow = {
    id: 'c1',
    channel: 'sms',
    counterpart: '+17135550168',
    status: 'open',
    person_id: 'p1',
    assignee_user_id: null,
    unread_count: 0,
    last_message_at: '2026-09-17T12:50:00.000Z',
    last_preview: 'Thursday works.',
    last_direction: 'inbound',
    awaiting_reply_since: null,
    snoozed_until: null,
    created_at: '2026-09-17T12:00:00.000Z',
    handled_by: 'human',
    ai_teammate_id: null,
    teammate_name: null,
    needs_person_since: null,
    handoff_reason: null,
    handoff_note: null,
    taken_over_by: null,
  };

  /** The conversation page's wiring: the sheet closes itself, and a row picks the next sheet. */
  function Page({
    onAssign,
    onClose,
    c = conversationOf(row),
    more = {},
  }: {
    onAssign: (() => void) | null;
    onClose: () => void;
    c?: ReturnType<typeof conversationOf>;
    more?: Partial<React.ComponentProps<typeof ActionsSheet>>;
  }) {
    const [open, setOpen] = React.useState(true);
    return (
      <ActionsSheet
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        c={c}
        canCall={false}
        canHandToAi={false}
        teammateName="Ava"
        assigneeShort={null}
        onCall={jest.fn()}
        onAssign={onAssign}
        onHandToAi={jest.fn()}
        onSnooze={jest.fn()}
        onCloseConversation={jest.fn()}
        onReopen={jest.fn()}
        onMarkUnread={jest.fn()}
        onNote={jest.fn()}
        onEditPerson={jest.fn()}
        onTags={jest.fn()}
        onStage={null}
        onNextAction={null}
        onAddPerson={null}
        stageName={null}
        {...more}
      />
    );
  }

  // Assign opens another sheet, which iOS would drop while this one's modal is still being dismissed: the row waits
  // for the sheet to be gone. Close conversation and Mark as unread only ever worked because they open nothing.
  it('runs a row once the sheet is gone, so the next sheet can show', async () => {
    const onAssign = jest.fn();
    const onClose = jest.fn();
    await render(<Page onAssign={onAssign} onClose={onClose} />);
    const dismiss = screen.root!.props.onDismiss as () => void;
    await fireEvent.press(screen.getByTestId('sheet-assign'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAssign).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(screen.queryByTestId('sheet-assign')).not.toBeOnTheScreen();
    expect(onAssign).not.toHaveBeenCalled();
    await act(async () => dismiss());
    expect(onAssign).toHaveBeenCalledTimes(1);
  });

  // Deleting for good (the Deleted bin, 20261027000400): last, for whoever may, and only once the sheet is gone.
  it('offers Delete for good… last, to whoever may delete', async () => {
    const onDelete = jest.fn();
    await render(<Page onAssign={jest.fn()} onClose={jest.fn()} more={{ onDelete }} />);
    const dismiss = screen.root!.props.onDismiss as () => void;
    expect(screen.getByTestId('sheet-delete')).toHaveTextContent('Delete for good…');
    await fireEvent.press(screen.getByTestId('sheet-delete'));
    await act(async () => jest.advanceTimersByTime(1_000));
    expect(onDelete).not.toHaveBeenCalled();
    await act(async () => dismiss());
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('leaves Delete for good… out for everyone else', async () => {
    await render(<Page onAssign={jest.fn()} onClose={jest.fn()} />);
    expect(screen.queryByTestId('sheet-delete')).toBeNull();
  });

  it('moves email between the Inbox, Other mail and Spam, once or for the sender (M19)', async () => {
    const onMove = jest.fn();
    const mail = conversationOf({
      ...row,
      channel: 'email',
      counterpart: 'deals@shop.example',
      folder: 'spam',
    });
    await render(
      <Page
        onAssign={jest.fn()}
        onClose={jest.fn()}
        c={mail}
        more={{ moves: mailMoves(mail.folder, false), onMove }}
      />,
    );
    const dismiss = screen.root!.props.onDismiss as () => void;
    expect(screen.getByTestId('sheet-move-other')).toHaveTextContent('Not spam');
    expect(screen.getByTestId('sheet-move-inbox')).toHaveTextContent('Move to Inbox');
    expect(screen.getByTestId('sheet-always-other')).toHaveTextContent(
      'Always put their mail in Other mail',
    );
    expect(screen.getByTestId('sheet-always-inbox')).toBeTruthy();
    expect(screen.queryByTestId('sheet-move-spam')).toBeNull();
    expect(screen.queryByTestId('sheet-share')).toBeNull();
    await fireEvent.press(screen.getByTestId('sheet-always-inbox'));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => dismiss());
    expect(onMove).toHaveBeenCalledWith({
      folder: 'inbox',
      remember: true,
      label: 'Always put their mail in the Inbox',
    });
  });

  it('keeps someone’s own mail theirs: Share with the team, and no Assign or sender rules (M19)', async () => {
    const onShare = jest.fn();
    const own = conversationOf({
      ...row,
      channel: 'email',
      person_id: null,
      counterpart: 'mom@example.com',
      private_to: DALE,
    });
    await render(
      <Page
        onAssign={null}
        onClose={jest.fn()}
        c={own}
        more={{ moves: mailMoves(own.folder, own.private), onMove: jest.fn(), onShare }}
      />,
    );
    const dismiss = screen.root!.props.onDismiss as () => void;
    expect(screen.queryByTestId('sheet-assign')).toBeNull();
    expect(screen.getByTestId('sheet-move-other')).toHaveTextContent('Move to Other mail');
    expect(screen.getByTestId('sheet-move-spam')).toBeTruthy();
    expect(screen.queryByTestId('sheet-always-spam')).toBeNull();
    await fireEvent.press(screen.getByTestId('sheet-share'));
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => dismiss());
    expect(onShare).toHaveBeenCalledTimes(1);

    // Under the top bar: whose it is, and the same way to share it.
    const share = jest.fn();
    await render(<PrivateBanner onShare={share} busy={false} />);
    expect(screen.getByTestId('thread-private-badge')).toHaveTextContent('Only you');
    expect(screen.getByTestId('thread-private')).toHaveTextContent(
      /Only you can see this\. Share it with the team to hand it to them\./,
    );
    await fireEvent.press(screen.getByTestId('banner-share'));
    expect(share).toHaveBeenCalledTimes(1);
  });

  it('runs nothing when the sheet is just put away', async () => {
    const onAssign = jest.fn();
    await render(<Page onAssign={onAssign} onClose={jest.fn()} />);
    const dismiss = screen.root!.props.onDismiss as () => void;
    await fireEvent.press(
      screen.getByTestId('conversation-actions-scrim', { includeHiddenElements: true }),
    );
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => dismiss());
    expect(onAssign).not.toHaveBeenCalled();
  });
});

describe('adding or linking whoever emailed (2026-10-29)', () => {
  const email: ConversationListRow = {
    id: 'c-greg',
    channel: 'email',
    counterpart: 'grlyons1010@gmail.com',
    status: 'open',
    person_id: null,
    assignee_user_id: null,
    unread_count: 0,
    last_message_at: '2026-10-28T00:39:00.000Z',
    last_preview: 'Click on the link to join the meeting.',
    last_direction: 'inbound',
    awaiting_reply_since: null,
    snoozed_until: null,
    created_at: '2026-10-28T00:17:00.000Z',
    handled_by: 'none',
    ai_teammate_id: null,
    teammate_name: null,
    needs_person_since: null,
    handoff_reason: null,
    handoff_note: null,
    taken_over_by: null,
  };
  const sender = (known: SenderActions['known'] = null): SenderActions => ({
    known,
    onAdd: jest.fn(),
    onLink: jest.fn(),
    onLinkKnown: jest.fn(),
  });

  it('offers Add to Contacts and Link right on their email', async () => {
    const s = sender();
    await render(
      <StatusBanner
        c={conversationOf(email)}
        who="them"
        timeZone="America/Chicago"
        onReopen={jest.fn()}
        sender={s}
      />,
    );
    expect(screen.getByTestId('not-customer-banner')).toHaveTextContent(
      /grlyons1010@gmail\.com isn’t a customer yet\. Add them, or link the address to someone you already have\./,
    );
    await fireEvent.press(screen.getByTestId('sender-add'));
    expect(s.onAdd).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('sender-link'));
    expect(s.onLink).toHaveBeenCalledTimes(1);
  });

  it('links the customer who already has the address in one tap', async () => {
    const s = sender({ id: 'p-greg', name: 'Gregory Lyons' });
    await render(
      <StatusBanner
        c={conversationOf(email)}
        who="them"
        timeZone="America/Chicago"
        onReopen={jest.fn()}
        sender={s}
      />,
    );
    expect(screen.getByTestId('not-customer-banner')).toHaveTextContent(
      /^Gregory Lyons already has this email address\.Link to Gregory Lyons$/,
    );
    expect(screen.queryByTestId('sender-add')).toBeNull();
    await fireEvent.press(screen.getByTestId('sender-link-known'));
    expect(s.onLinkKnown).toHaveBeenCalledWith({ id: 'p-greg', name: 'Gregory Lyons' });
  });

  it('keeps your own mail to Share first: Add and Link come once it’s the team’s', async () => {
    const share = jest.fn();
    await render(<PrivateBanner onShare={share} busy={false} />);
    expect(screen.queryByTestId('sender-add')).toBeNull();
    expect(screen.queryByTestId('sender-link')).toBeNull();
    await fireEvent.press(screen.getByTestId('banner-share'));
    expect(share).toHaveBeenCalledTimes(1);
    // Shared, it's a team thread nobody has linked, and the strip offers both.
    await render(
      <StatusBanner
        c={conversationOf(email)}
        who="them"
        timeZone="America/Chicago"
        onReopen={jest.fn()}
        sender={sender()}
      />,
    );
    expect(screen.getByTestId('sender-add')).toBeTruthy();
    expect(screen.getByTestId('sender-link')).toBeTruthy();
  });

  it('finds the customer to link by name, with whoever has the address first', async () => {
    jest.mocked(useQuery).mockImplementation(((sql: string) => ({
      data:
        sql === PEOPLE_SQL
          ? [
              { id: 'p-amy', first_name: 'Amy', last_name: 'Adams', email: 'amy@example.com' },
              {
                id: 'p-greg',
                first_name: 'Greg',
                last_name: 'Lyons',
                email: 'greg@lyons.example',
                other_emails: JSON.stringify([{ email: 'grlyons1010@gmail.com' }]),
              },
            ]
          : [],
      isLoading: false,
    })) as never);
    const onPick = jest.fn(async () => true);
    const onClose = jest.fn();
    await render(
      wrap(
        <LinkPersonSheet
          open
          onClose={onClose}
          counterpart="grlyons1010@gmail.com"
          onPick={onPick}
        />,
      ),
    );
    const rows = screen.getAllByTestId(/^link-person-p-/);
    expect(rows.map((r) => r.props.testID)).toEqual(['link-person-p-greg', 'link-person-p-amy']);
    await fireEvent.changeText(screen.getByTestId('link-person-search'), 'amy');
    expect(screen.queryByTestId('link-person-p-greg')).toBeNull();
    await fireEvent.press(screen.getByTestId('link-person-p-amy'));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-amy', name: 'Amy Adams' }),
    );
    await fireEvent.changeText(screen.getByTestId('link-person-search'), 'zed');
    expect(screen.getByTestId('link-person-nobody')).toHaveTextContent('No one matches “zed”.');
  });
});

describe('the composer', () => {
  const props = {
    userId: DALE,
    mode: 'sms' as const,
    modes: ['sms', 'email'] as const,
    onMode: jest.fn(),
    body: '',
    onBody: jest.fn(),
    subject: '',
    onSubject: jest.fn(),
    showSubject: false,
    photos: [],
    onAddPhoto: jest.fn(),
    onRemovePhoto: jest.fn(),
    canPhoto: true,
    note: null,
    off: false,
    first: 'Mike',
    phoneDisplay: '(713) 555-0142',
    fromNumber: '(713) 555-0100',
    fromEmail: null,
    elsewhere: null,
    handover: null,
    online: true,
    editing: false,
    onCancelEdit: jest.fn(),
    busy: false,
    onSend: jest.fn(),
  };

  it('writes to Mike from the business number, and sends only once there are words', async () => {
    const view = await render(<Composer {...props} />);
    expect(screen.getByTestId('composer-from')).toHaveTextContent('From (713) 555-0100');
    expect(screen.getByLabelText('Text Mike…')).toBeTruthy();
    expect(screen.getByTestId('composer-send')).toBeDisabled();
    expect(screen.queryByTestId('composer-offline')).toBeNull();
    await view.rerender(<Composer {...props} body="On my way" online={false} />);
    expect(screen.getByTestId('composer-send')).not.toBeDisabled();
    expect(screen.getByTestId('composer-offline')).toHaveTextContent(
      'Texts written with no signal go out on their own within 30 minutes. After that, the phone asks first.',
    );
    await fireEvent.press(screen.getByTestId('composer-send'));
    expect(props.onSend).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('composer-mode-email'));
    expect(props.onMode).toHaveBeenCalledWith('email');
  });

  it('shows photos going to Mike’s files, and a note that turns the box off', async () => {
    const photo = { fileId: 'f1', localName: 'p.jpg', sizeBytes: 1, width: 1, height: 1 };
    const view = await render(<Composer {...props} photos={[photo]} body="Here it is" />);
    expect(screen.getByTestId('photos-saved')).toHaveTextContent(
      'Photos you send are saved to Mike’s files too.',
    );
    await fireEvent.press(screen.getByTestId('composer-photo-remove-1'));
    expect(props.onRemovePhoto).toHaveBeenCalledWith(photo);
    await view.rerender(
      <Composer
        {...props}
        off
        note={{
          tone: 'danger',
          icon: 'alert',
          parts: [
            'Texting is off for Mike. They can text ',
            { strong: 'START' },
            ' to turn it back on.',
          ],
          placeholder: 'You can’t text Mike right now',
        }}
      />,
    );
    expect(screen.getByTestId('composer-note')).toHaveTextContent(
      'Texting is off for Mike. They can text START to turn it back on.',
    );
    expect(screen.getByLabelText('You can’t text Mike right now')).toBeTruthy();
    expect(screen.queryByTestId('composer-attach')).toBeNull();
  });

  it('replies in a client’s portal, never by text: no switch, no photos (board 92)', async () => {
    const view = await render(
      <Composer
        {...props}
        mode="portal"
        modes={null}
        canPhoto={false}
        first="Ann"
        fromNumber={null}
        body="I’ll send you the draft tonight to look over."
      />,
    );
    expect(screen.getByLabelText('Reply in Ann’s portal…')).toBeTruthy();
    expect(screen.getByTestId('composer-portal')).toHaveTextContent(
      'Replies go back to the portal, where Ann wrote. Not by text.',
    );
    expect(screen.queryByTestId('composer-mode-sms')).toBeNull();
    expect(screen.queryByTestId('composer-attach')).toBeNull();
    expect(screen.getByLabelText('Send')).toBeTruthy();
    await view.rerender(
      <Composer
        {...props}
        mode="portal"
        modes={null}
        canPhoto={false}
        first="Ann"
        online={false}
      />,
    );
    expect(screen.getByTestId('composer-offline')).toHaveTextContent(
      'Replies written with no signal go out on their own within 30 minutes. After that, the phone asks first.',
    );
  });
});

describe('My cell phone', () => {
  let cell: Record<string, unknown> | null = null;
  function mockQueries() {
    jest.mocked(useQuery).mockImplementation(((sql: string) => ({
      data: sql.includes('user_phones')
        ? cell
          ? [cell]
          : []
        : sql.includes('phone_numbers')
          ? [{ e164: '+17135550100', status: 'active' }]
          : sql.includes('FROM conversations')
            ? [{ first_name: 'Mike', last_name: 'Johnson', counterpart: '+17135550142' }]
            : [],
      isLoading: false,
      isFetching: false,
    })) as never);
  }
  beforeEach(() => {
    cell = null;
    mockQueries();
  });

  it('verifies the cell: the call goes out, and the press of 1 arrives through the copy', async () => {
    mockParams = { callConversation: 'c1' };
    jest.mocked(change).mockResolvedValue({
      id: 'x',
      queued: false,
      output: {
        userPhoneId: 'up1',
        e164: '+15125550142',
        status: 'calling',
        callerId: '+17135550100',
      },
    } as never);
    const view = await render(wrap(<MyCell />));
    expect(screen.getByTestId('verify-first')).toHaveTextContent(
      'Verify your cell to call Mike Johnson. HandsFreeOS rings it first, then connects them.',
    );
    expect(screen.getByTestId('my-cell-calls-from')).toHaveTextContent(
      'The call comes from Lone Star HVAC & Roofing’s number, (713) 555-0100. It only proves the phone is yours.',
    );
    await fireEvent.changeText(screen.getByTestId('my-cell-input'), '512 555 0142');
    expect(screen.getByTestId('my-cell-hint')).toHaveTextContent(
      'We’ll call (512) 555-0142. Press 1 when you answer.',
    );
    await fireEvent.press(screen.getByTestId('verify-my-cell'));
    expect(change).toHaveBeenCalledWith('user_phone.start_verification', {
      workspaceId: LONE_STAR,
      phone: '+15125550142',
    });
    cell = { id: 'up1', e164: '+15125550142', verified_at: null, last_verification_at: 'now' };
    await view.rerender(wrap(<MyCell />));
    expect(screen.getByTestId('my-cell-status')).toHaveTextContent('Waiting for you to press 1…');
    cell = { ...cell, verified_at: '2026-09-21T15:00:00.000Z' };
    await view.rerender(wrap(<MyCell />));
    expect(screen.getByTestId('my-cell-status')).toHaveTextContent(/^Verified \w{3}, Sep 2\d$/);
    expect(toast.show).toHaveBeenCalledWith('(512) 555-0142 is verified');
    // The call it was opened for, and the contacts card.
    expect(screen.getByTestId('my-cell-call')).toHaveTextContent('Call Mike Johnson');
    expect(screen.getByTestId('contact-card')).toHaveTextContent(
      /Add Lone Star HVAC & Roofing’s number to your contacts/,
    );
    await fireEvent.press(screen.getByTestId('contact-add'));
    expect(HfosPhone.addContact).toHaveBeenCalledWith('Lone Star HVAC & Roofing', '+17135550100');
    expect(toast.show).toHaveBeenCalledWith('Lone Star HVAC & Roofing is in your contacts');
    // The card says it was added and stays put: a contact deleted later, or a second phone, needs the button again.
    expect(screen.getByTestId('contact-added')).toHaveTextContent(
      'Lone Star HVAC & Roofing is in your contacts',
    );
    expect(screen.getByTestId('contact-add')).toBeTruthy();
    expect(screen.queryByTestId('contact-not-now')).toBeNull();
  });

  it('needs signal to verify', async () => {
    mockOnline = false;
    await render(wrap(<MyCell />));
    expect(screen.getByTestId('verify-my-cell')).toBeDisabled();
    expect(screen.getByTestId('my-cell-hint')).toHaveTextContent('This needs signal.');
  });
});
