import { ASSISTANT_WORDS, type AssistantCard } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { AssistantComposer } from '../composer';
import { ConsentStep } from '../consent-step';
import { ConfirmCard } from '../confirm-card';
import { EmptyChat, MessageRow } from '../message-list';
import { NoticeCard } from '../notices';
import type { AnswerMessage, CallState, QuestionMessage } from '@/assistant/chat';

/**
 * Ask HandsFreeOS's parts with React Native Testing Library: the consent step before the first question, the
 * confirmation that asks before anything reaches a customer (and what it says once it's answered), the composer, and
 * the card the canvas shows when the phone has no signal.
 */

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));

const mockConfirm = jest.fn();
const mockCancel = jest.fn();
jest.mock('@/assistant/stream', () => {
  const actual = jest.requireActual('@/assistant/stream') as object;
  return {
    ...actual,
    confirmToolCall: (...args: unknown[]) => mockConfirm(...args),
    cancelToolCall: (...args: unknown[]) => mockCancel(...args),
    undoToolCall: jest.fn(),
  };
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CALL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const textCard = (over: Partial<Extract<AssistantCard, { type: 'confirm' }>> = {}) =>
  ({
    type: 'confirm',
    toolCallId: CALL,
    tool: 'send_text',
    personId: null,
    conversationId: null,
    title: 'Text Robert Chen',
    fields: [
      { label: 'To', value: 'Robert Chen · (713) 555-0110' },
      { label: 'From', value: '(713) 555-0100' },
    ],
    body: 'Hi Robert, this is Dale at Lone Star HVAC & Roofing.',
    stageFrom: null,
    stageTo: null,
    warnings: [],
    reasons: [],
    confirmLabel: 'Send text',
    editable: true,
    ...over,
  }) as Extract<AssistantCard, { type: 'confirm' }>;

beforeEach(() => {
  mockConfirm.mockReset();
  mockCancel.mockReset();
});

describe('the consent step', () => {
  it('asks before the first question, in the canvas’s words', async () => {
    await render(<ConsentStep onAccept={jest.fn(async () => undefined)} onDecline={jest.fn()} />);
    expect(screen.getByText('The Assistant uses Anthropic’s Claude')).toBeTruthy();
    expect(
      screen.getByText('What you ask about is sent to Anthropic’s Claude to answer you.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Nothing goes to a customer, and nothing is booked or changed, until you say OK.',
      ),
    ).toBeTruthy();
  });

  it('OK, continue keeps the OK; Not now closes it and it asks again', async () => {
    const onAccept = jest.fn(async () => undefined);
    const onDecline = jest.fn();
    await render(<ConsentStep onAccept={onAccept} onDecline={onDecline} />);
    fireEvent.press(screen.getByTestId('assistant-consent-ok'));
    await waitFor(() => expect(onAccept).toHaveBeenCalled());
    fireEvent.press(screen.getByTestId('assistant-consent-not-now'));
    expect(onDecline).toHaveBeenCalled();
  });
});

describe('a confirmation', () => {
  const card = textCard();
  const renderCard = (state?: CallState, setCall = jest.fn()) =>
    render(<ConfirmCard card={card} workspaceId={WS} state={state} setCall={setCall} />);

  it('says it needs your OK, and shows what would go, to whom and from where', async () => {
    await renderCard();
    expect(screen.getByTestId('assistant-needs-ok')).toHaveTextContent('Needs your OK');
    expect(screen.getByTestId('assistant-confirm-title')).toHaveTextContent('Text Robert Chen');
    expect(screen.getByText('Robert Chen · (713) 555-0110')).toBeTruthy();
    expect(screen.getByText(card.body!)).toBeTruthy();
    expect(screen.getByTestId('assistant-confirm')).toHaveTextContent('Send text');
    expect(screen.getByTestId('assistant-cancel')).toHaveTextContent('Cancel');
  });

  it('sends nothing until the button is pressed, and only then', async () => {
    const setCall = jest.fn();
    mockConfirm.mockResolvedValue({
      id: CALL,
      tool: 'send_text',
      status: 'confirmed',
      outcome: 'Sent to Robert Chen',
      href: null,
      error: null,
    });
    await renderCard(undefined, setCall);
    expect(mockConfirm).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('assistant-confirm'));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledWith(CALL, WS, undefined));
    expect(setCall).toHaveBeenCalledWith(
      CALL,
      expect.objectContaining({ status: 'confirmed', outcome: 'Sent to Robert Chen' }),
    );
  });

  it('records a no, and says nothing went to them', async () => {
    const setCall = jest.fn();
    mockCancel.mockResolvedValue({
      id: CALL,
      tool: 'send_text',
      status: 'cancelled',
      outcome: null,
      href: null,
      error: null,
    });
    await renderCard(undefined, setCall);
    fireEvent.press(screen.getByTestId('assistant-cancel'));
    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith(CALL, WS));
    expect(setCall).toHaveBeenCalledWith(CALL, expect.objectContaining({ status: 'cancelled' }));
  });

  it('shows the worker’s own outcome once it is done, and where it landed', async () => {
    await renderCard({
      status: 'confirmed',
      tool: 'send_text',
      outcome: 'Sent to Robert Chen',
      error: null,
      href: `/app/w/${WS}/inbox/cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
    });
    expect(screen.getByText('Sent to Robert Chen')).toBeTruthy();
    expect(screen.getByText('Open conversation')).toBeTruthy();
    expect(screen.queryByTestId('assistant-confirm')).toBeNull();
  });

  it('says in its own words that nothing went to them', async () => {
    await renderCard({
      status: 'cancelled',
      tool: 'send_text',
      outcome: null,
      error: null,
      href: null,
    });
    expect(screen.getByText('Not sent. Nothing went to Robert.')).toBeTruthy();
  });

  it('a card a rule stops has nothing to confirm, only the reason and Close', async () => {
    await render(
      <ConfirmCard
        card={textCard({
          confirmLabel: '',
          warnings: [{ kind: 'blocked', text: 'Robert opted out of texts.' }],
        })}
        workspaceId={WS}
        state={undefined}
        setCall={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('assistant-confirm')).toBeNull();
    expect(screen.getByTestId('assistant-cancel')).toHaveTextContent('Close');
    expect(screen.getByTestId('assistant-warning-blocked')).toHaveTextContent(
      'Robert opted out of texts.',
    );
  });

  it('cancelling an appointment keeps it, in its own words', async () => {
    await render(
      <ConfirmCard
        card={textCard({
          tool: 'cancel_appointment',
          title: 'Cancel Thursday’s tune-up?',
          confirmLabel: 'Cancel the appointment',
          body: null,
        })}
        workspaceId={WS}
        state={undefined}
        setCall={jest.fn()}
      />,
    );
    expect(screen.getByTestId('assistant-cancel')).toHaveTextContent('Keep it');
  });
});

describe('with no signal', () => {
  it('says the Assistant needs signal, offers Ask again, and says what still works', async () => {
    const onRetry = jest.fn();
    await render(
      <NoticeCard
        notice={{ code: 'no_signal', message: ASSISTANT_WORDS.offline.body }}
        businessName="Lone Star HVAC"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByTestId('assistant-offline')).toHaveTextContent('The Assistant needs signal');
    expect(screen.getByText(ASSISTANT_WORDS.offline.body)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_WORDS.offline.works)).toBeTruthy();
    fireEvent.press(screen.getByTestId('assistant-ask-again'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('the day’s limit names the business and says everything else still works', async () => {
    await render(
      <NoticeCard
        notice={{ code: 'budget_reached', message: 'ignored' }}
        businessName="Lone Star HVAC"
      />,
    );
    expect(screen.getByText('That’s today’s Assistant limit for Lone Star HVAC')).toBeTruthy();
  });
});

describe('the composer', () => {
  const composer = (props: Partial<React.ComponentProps<typeof AssistantComposer>>) => (
    <AssistantComposer
      value=""
      onChange={jest.fn()}
      onSend={jest.fn()}
      onStop={jest.fn()}
      running={false}
      off={null}
      {...props}
    />
  );

  it('sends nothing while nothing has been typed', async () => {
    const onSend = jest.fn();
    await render(composer({ onSend }));
    fireEvent.press(screen.getByTestId('assistant-send'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends what was typed', async () => {
    const onSend = jest.fn();
    await render(composer({ value: 'Who still owes us money?', onSend }));
    fireEvent.press(screen.getByTestId('assistant-send'));
    expect(onSend).toHaveBeenCalled();
  });

  it('Stop takes Send’s place while an answer comes in', async () => {
    const onStop = jest.fn();
    await render(composer({ value: 'Who still owes us money?', running: true, onStop }));
    expect(screen.queryByTestId('assistant-send')).toBeNull();
    fireEvent.press(screen.getByTestId('assistant-stop'));
    expect(onStop).toHaveBeenCalled();
  });

  it('says why it can’t take a question when the day’s limit is spent', async () => {
    await render(
      composer({ off: { text: ASSISTANT_WORDS.paused.text, hint: ASSISTANT_WORDS.paused.hint } }),
    );
    expect(screen.getByText('The Assistant is paused for today')).toBeTruthy();
    expect(screen.queryByTestId('assistant-send')).toBeNull();
  });
});

describe('the chat itself', () => {
  const answer = (over: Partial<AnswerMessage> = {}): AnswerMessage => ({
    key: 'a1',
    role: 'assistant',
    text: 'Four invoices are waiting to be paid, $6,565.14 in all.',
    cards: [],
    steps: [],
    live: false,
    notice: null,
    question: 'Who still owes us money?',
    createdAt: '2026-09-17T08:30:00.000Z',
    ...over,
  });

  const row = (message: AnswerMessage | QuestionMessage, onRetry = jest.fn()) => (
    <MessageRow
      message={message}
      businessName="Lone Star HVAC"
      workspaceId={WS}
      calls={{}}
      setCall={jest.fn()}
      onRetry={onRetry}
    />
  );

  it('shows the question that was asked', async () => {
    await render(
      row({
        key: 'q1',
        role: 'user',
        text: 'Who still owes us money?',
        createdAt: '2026-09-17T08:30:00.000Z',
      }),
    );
    expect(screen.getByText('Who still owes us money?')).toBeTruthy();
  });

  it('shows the answer under it', async () => {
    await render(row(answer()));
    expect(
      screen.getByText('Four invoices are waiting to be paid, $6,565.14 in all.'),
    ).toBeTruthy();
  });

  it('Ask again asks the question that had no signal', async () => {
    const onRetry = jest.fn();
    await render(
      row(
        answer({ text: '', notice: { code: 'no_signal', message: ASSISTANT_WORDS.offline.body } }),
        onRetry,
      ),
    );
    fireEvent.press(screen.getByTestId('assistant-ask-again'));
    expect(onRetry).toHaveBeenCalledWith('a1');
  });

  it('says what the Assistant is for before anything is asked', async () => {
    await render(<EmptyChat />);
    expect(screen.getByText(ASSISTANT_WORDS.emptyTitle)).toBeTruthy();
  });
});
