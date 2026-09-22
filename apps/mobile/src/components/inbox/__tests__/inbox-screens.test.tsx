import { conversationOf, type ConversationListRow } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import MyCell from '@/app/app/w/[workspaceId]/(tabs)/(more)/settings/my-cell';
import { Composer } from '@/components/inbox/composer';
import { ActionsSheet } from '@/components/inbox/conversation-parts';
import { ConversationRow } from '@/components/inbox/conversation-row';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { change } from '@/changes';
import type { Me } from '@/lib/businesses';

import HfosPhone from '../../../../modules/hfos-phone';

/**
 * The inbox's screens with React Native Testing Library: a row in the list, the conversation's Details and actions
 * (a row's action runs once the sheet is gone), the composer (offline words, the From line, photos, a note that turns
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
  function Page({ onAssign, onClose }: { onAssign: () => void; onClose: () => void }) {
    const [open, setOpen] = React.useState(true);
    return (
      <ActionsSheet
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        c={conversationOf(row)}
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
