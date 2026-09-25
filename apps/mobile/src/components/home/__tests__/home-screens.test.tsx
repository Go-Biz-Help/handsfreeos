import type { AttentionItemOut, ApprovalFacts } from '@hfos/core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';
import { Pressable, Text } from 'react-native';

import { WorkflowApprovalCard } from '@/components/home/approval-card';
import { AttentionCard } from '@/components/home/attention-card';
import { HomeEnvProvider, type HomeEnv } from '@/components/home/home-context';
import { DismissSheet, ItemSheet } from '@/components/home/item-sheets';
import { BusinessProvider } from '@/components/shell/business-context';
import { toast } from '@/components/ui/toast';
import { change, ChangeError, changes, NEEDS_SIGNAL } from '@/changes';
import type { OutboxRow } from '@/changes/outbox';
import { startCall } from '@/inbox/calls';
import type { Me } from '@/lib/businesses';
import { useHomeActions, type HomeActions } from '@/home/actions';

/**
 * Home's cards and sheets with React Native Testing Library: a card's words and buttons (Call needs signal; Let
 * HandsFreeOS Handle is off on approvals), a refused change coming back with the API's words, the ⋯ sheet's Snooze and
 * Assign, Dismiss this?, Home's commands going through `change()` with the item's row changed at once, a lesson from
 * correcting the AI added in one tap, and a workflow approval's Approve and send.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return {
    change: jest.fn(async () => ({ id: 'change-1', queued: true })),
    changes: { discard: jest.fn(async () => undefined) },
    ChangeError: actual.ChangeError,
    NEEDS_SIGNAL: actual.NEEDS_SIGNAL,
  };
});
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
jest.mock('@/inbox/calls', () => ({ startCall: jest.fn() }));
const mockDb = { getOptional: jest.fn(async () => null) };
jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
  usePowerSync: () => mockDb,
}));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DALE = '11111111-1111-4111-8111-111111111111';
const PRIYA = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-09-15T15:00:00.000Z');

const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
  businesses: [
    {
      id: WS,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: 'America/Chicago',
    },
  ],
  organizations: [],
  fetchedAt: 0,
};

function item(over: Partial<AttentionItemOut> = {}): AttentionItemOut {
  return {
    id: 'item-1',
    kind: 'hot_lead',
    state: 'open',
    subject: { type: 'lead', id: 'lead-1' },
    personId: 'person-1',
    leadId: 'lead-1',
    conversationId: null,
    appointmentId: null,
    startsAt: null,
    reach: 'sms',
    callable: false,
    title: 'Maria Lopez · New AC install',
    detail: 'Asked for a price and how soon someone can come out.',
    valueCents: 1_850_000,
    valueIsEstimate: false,
    reasons: [
      { code: 'value', label: '$18,500', text: '$18,500' },
      {
        code: 'waiting',
        label: 'waiting 11 min',
        text: 'waiting 11 min',
        since: new Date(NOW - 11 * 60_000).toISOString(),
      },
      { code: 'qualified', label: 'qualified', text: 'qualified' },
    ],
    urgent: true,
    score: 400,
    urgency: 3,
    since: null,
    urgentFrom: null,
    dueAt: null,
    openedAt: new Date(NOW).toISOString(),
    assignee: { id: DALE, fullName: 'Dale Porter' },
    snoozedUntil: null,
    dismissedAt: null,
    dismissReason: null,
    handled: null,
    auto: { action: null, state: null, scheduledFor: null, doneAt: null, skipReason: null },
    letHandleMode: 'ask',
    handleLabel: 'Call',
    actions: { handle: true, letHandle: true, assign: true, snooze: true, dismiss: true },
    ...over,
  };
}

function fakeActions(): jest.Mocked<HomeActions> {
  return {
    handle: jest.fn(),
    call: jest.fn(),
    letHandle: jest.fn(),
    more: jest.fn(),
    snooze: jest.fn(),
    pickTime: jest.fn(),
    dismiss: jest.fn(),
    dismissNow: jest.fn(),
    assign: jest.fn(),
    cancelAuto: jest.fn(),
    open: jest.fn(),
  };
}

function envOf(over: Partial<HomeEnv> = {}): HomeEnv {
  return {
    workspaceId: WS,
    timeZone: 'America/Chicago',
    now: NOW,
    myUserId: DALE,
    members: [
      { id: DALE, fullName: 'Dale Porter', role: 'owner' },
      { id: PRIYA, fullName: 'Priya Shah', role: 'member' },
    ],
    teammateName: 'Ava',
    online: true,
    drafts: new Map(),
    refused: new Map(),
    handing: new Set(),
    highlightId: null,
    act: fakeActions(),
    ...over,
  };
}

const wrap = (node: React.ReactNode, env: HomeEnv = envOf()) => (
  <BusinessProvider
    value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
  >
    <HomeEnvProvider value={env}>{node}</HomeEnvProvider>
  </BusinessProvider>
);

beforeEach(() => {
  mockOnline = true;
  jest.mocked(change).mockClear();
  jest.mocked(changes.discard).mockClear();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('a card on Home', () => {
  it('says what it is, why it ranks, and fits its main button to the item', async () => {
    const env = envOf();
    await render(wrap(<AttentionCard item={item()} />, env));
    expect(screen.getByTestId('attention-title')).toHaveTextContent('Maria Lopez · New AC install');
    expect(screen.getByText('Hot lead')).toBeOnTheScreen();
    expect(screen.getByText('$18,500')).toBeOnTheScreen();
    expect(screen.getByText('Waiting 11 min')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Call Maria' }));
    expect(env.act.handle).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }));
    await fireEvent.press(screen.getByTestId('attention-let-handle'));
    expect(env.act.letHandle).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('attention-more'));
    expect(env.act.more).toHaveBeenCalledTimes(1);
  });

  it('with no signal, Call waits for it and says Let HandsFreeOS Handle still works', async () => {
    const env = envOf({ online: false });
    await render(wrap(<AttentionCard item={item()} />, env));
    expect(screen.getByRole('button', { name: 'Call Maria' })).toBeDisabled();
    expect(
      screen.getByText('Calls need signal. Let HandsFreeOS Handle still works.'),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('attention-let-handle'));
    expect(env.act.letHandle).toHaveBeenCalledTimes(1);
  });

  it('keeps Let HandsFreeOS Handle off on an approval, as the web does', async () => {
    const env = envOf();
    await render(
      wrap(
        <AttentionCard
          item={item({
            kind: 'ai_approval',
            title: 'Angela Brooks · Workflow: Reschedule',
            letHandleMode: 'none',
            reasons: [{ code: 'approval', label: 'workflow approval', text: 'workflow approval' }],
            actions: { handle: true, letHandle: false, assign: true, snooze: true, dismiss: true },
          })}
        />,
        env,
      ),
    );
    await fireEvent.press(screen.getByTestId('attention-let-handle'));
    expect(env.act.letHandle).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Review' })).toBeOnTheScreen();
  });

  it('brings a refused change back with the API’s words, and OK clears it', async () => {
    const row = {
      id: 'change-9',
      state: 'refused',
      reason: 'That item isn’t there anymore.',
    } as OutboxRow;
    const env = envOf({
      refused: new Map([
        ['item-1', { row, name: 'attention.snooze', itemId: 'item-1', input: {} }],
      ]),
    });
    await render(wrap(<AttentionCard item={item()} />, env));
    expect(screen.getByTestId('attention-refused-text')).toHaveTextContent(
      'Snooze didn’t go through: That item isn’t there anymore.',
    );
    await fireEvent.press(screen.getByTestId('attention-refused-ok'));
    expect(changes.discard).toHaveBeenCalledWith(['change-9']);
  });
});

describe('the ⋯ sheet', () => {
  it('snoozes for an hour, and assigns from the team', async () => {
    const env = envOf();
    await render(wrap(<ItemSheet item={item()} onClose={() => undefined} />, env));
    expect(screen.getByText('Hot lead · assigned to you')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('snooze-hour'));
    expect(env.act.snooze).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item-1' }),
      expect.any(Number),
    );
    await fireEvent.press(screen.getByTestId('attention-assign'));
    expect(screen.getByText('Assign Maria Lopez to')).toBeOnTheScreen();
    expect(screen.getByText('This makes them the lead’s owner too.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId(`assign-${PRIYA}`));
    expect(env.act.assign).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }), PRIYA);
  });

  it('asks why before dismissing, and keeps the reason', async () => {
    const env = envOf();
    await render(wrap(<DismissSheet item={item()} onClose={() => undefined} />, env));
    expect(screen.getByText('Maria Lopez · New AC install · $18,500')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('radio', { name: 'Not a real lead' }));
    await fireEvent.changeText(screen.getByTestId('dismiss-note'), 'spam form');
    await fireEvent.press(screen.getByTestId('dismiss-confirm'));
    expect(env.act.dismissNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item-1' }),
      'Not a real lead: spam form',
    );
  });
});

describe('Home’s commands', () => {
  function Buttons({ it: target }: { it: AttentionItemOut }) {
    const act = useHomeActions({
      workspaceId: WS,
      timeZone: 'America/Chicago',
      myUserId: DALE,
      members: [{ id: PRIYA, fullName: 'Priya Shah' }],
      open: () => undefined,
    });
    return (
      <>
        <Pressable onPress={() => act.snooze(target, NOW + 3_600_000)} testID="snooze">
          <Text>Snooze</Text>
        </Pressable>
        <Pressable onPress={() => act.assign(target, PRIYA)} testID="assign">
          <Text>Assign</Text>
        </Pressable>
        <Pressable onPress={() => act.call(target)} testID="call">
          <Text>Call</Text>
        </Pressable>
        <Pressable onPress={() => act.handle(target)} testID="handle">
          <Text>Handle</Text>
        </Pressable>
      </>
    );
  }

  it('go through change(), with the item’s row changed at once, and say so when there’s no signal', async () => {
    mockOnline = false;
    await render(wrap(<Buttons it={item()} />));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('snooze'));
    });
    expect(change).toHaveBeenCalledWith(
      'attention.snooze',
      { workspaceId: WS, itemId: 'item-1', until: new Date(NOW + 3_600_000).toISOString() },
      { optimistic: expect.any(Function) },
    );
    const tx = {
      execute: jest.fn(async (_sql: string, _params?: unknown[]) => undefined),
      getAll: jest.fn(async () => []),
      getOptional: jest.fn(async () => null),
    };
    await jest.mocked(change).mock.calls[0]![2]!.optimistic!(tx);
    expect(tx.execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE attention_items SET state = 'snoozed', snoozed_until = ?"),
      [new Date(NOW + 3_600_000).toISOString(), expect.any(String), 'item-1'],
    );
    expect(toast.show).toHaveBeenCalledWith(
      expect.stringMatching(/^Snoozed until .* It goes as soon as HandsFreeOS can be reached\.$/),
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );

    await act(async () => {
      await fireEvent.press(screen.getByTestId('assign'));
    });
    expect(change).toHaveBeenLastCalledWith(
      'attention.assign',
      { workspaceId: WS, itemId: 'item-1', assigneeUserId: PRIYA },
      { optimistic: expect.any(Function) },
    );
    expect(toast.show).toHaveBeenLastCalledWith(
      'Assigned to Priya. Priya is now the lead’s owner. It goes as soon as HandsFreeOS can be reached.',
    );

    await fireEvent.press(screen.getByTestId('call'));
    expect(startCall).toHaveBeenCalledWith({ personId: 'person-1' });
  });

  it('add a lesson from correcting the AI in one tap, or put the new words in place of the old', async () => {
    const lesson = (clash: boolean) =>
      item({
        id: 'item-7',
        kind: 'ai_corrections',
        subject: { type: 'lesson', id: 'lesson-1' },
        personId: null,
        leadId: null,
        reasons: [
          ...(clash
            ? [
                {
                  code: 'knows_otherwise' as const,
                  label: 'Policies says “Saturday visits cost the same.”',
                  text: 'Policies says “Saturday visits cost the same.”',
                },
              ]
            : []),
          {
            code: 'corrected',
            label: 'Corrected once · “Saturday visits cost extra.”',
            text: 'Corrected once · “Saturday visits cost extra.”',
          },
        ],
      });
    const sent = (replaced: { where: string; before: string; after: string } | null) => ({
      id: 'change-7',
      queued: false,
      output: { lessonId: 'lesson-1', line: 'Saturday visits cost extra.', replaced },
    });

    jest.mocked(change).mockResolvedValueOnce(sent(null) as never);
    const view = await render(wrap(<Buttons it={lesson(false)} />));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('handle'));
    });
    expect(change).toHaveBeenLastCalledWith('teammate_lesson.apply', {
      workspaceId: WS,
      lessonId: 'lesson-1',
    });
    expect(toast.show).toHaveBeenLastCalledWith('Added to what the AI knows.');

    jest.mocked(change).mockResolvedValueOnce(
      sent({
        where: 'Policies',
        before: 'Saturday visits cost the same.',
        after: 'Saturday visits cost extra.',
      }) as never,
    );
    await view.rerender(wrap(<Buttons it={lesson(true)} />));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('handle'));
    });
    expect(change).toHaveBeenLastCalledWith('teammate_lesson.apply', {
      workspaceId: WS,
      lessonId: 'lesson-1',
      replace: true,
    });
    expect(toast.show).toHaveBeenLastCalledWith('Changed Policies to the new words.');

    // It never waits on the phone: with no signal, it says so and nothing changes.
    jest.mocked(change).mockRejectedValueOnce(new ChangeError('needs-signal', NEEDS_SIGNAL));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('handle'));
    });
    expect(toast.error).toHaveBeenLastCalledWith(NEEDS_SIGNAL);
  });
});

describe('a workflow approval', () => {
  const approval: ApprovalFacts = {
    id: 'approval-1',
    workflow: { id: 'wf-1', name: 'New lead follow-up' },
    runId: 'run-1',
    status: 'pending',
    approvers: [],
    preview: {
      fields: { message: 'Hi Maria, we can come Thursday.' },
      channel: 'sms',
      asked: 'Can you come?',
    },
    edits: null,
    reason: null,
    decidedBy: null,
    decidedAt: null,
    via: null,
    expiresAt: new Date(NOW + 2 * 3_600_000).toISOString(),
    createdAt: new Date(NOW - 12 * 60_000).toISOString(),
    person: { id: 'person-1', fullName: 'Maria Lopez' },
    canDecide: true,
  };

  it('approves with the edit, through change()', async () => {
    await render(wrap(<WorkflowApprovalCard a={approval} workspaceId={WS} now={NOW} />));
    expect(screen.getByTestId('approval-title')).toHaveTextContent(
      'An AI-written text for Maria Lopez',
    );
    expect(
      screen.getByText('New lead follow-up · for owners and admins · waiting 12 min'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Maria’s latest message')).toBeOnTheScreen();
    await fireEvent.changeText(
      screen.getByTestId('approval-field-message'),
      'Hi Maria, Thursday at 9?',
    );
    expect(screen.getByText('Edited: your version is what goes out.')).toBeOnTheScreen();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('approval-approve'));
    });
    expect(change).toHaveBeenCalledWith(
      'workflow.decide_approval',
      {
        workspaceId: WS,
        approvalId: 'approval-1',
        decision: 'approve',
        edits: { message: 'Hi Maria, Thursday at 9?' },
      },
      { optimistic: expect.any(Function) },
    );
    expect(toast.show).toHaveBeenCalledWith('Approved. It goes out now.');
  });
});
