import { FEEDBACK_WORDS as W, type TeammateFeedbackOut } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { useReplyFeedback, type Coaching } from '@/ai-team/feedback';
import { change, ChangeError, NEEDS_SIGNAL } from '@/changes';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';

import { ReplyFeedback } from '../reply-feedback';

/**
 * Feedback on the AI teammate's replies on the phone (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md), with React
 * Native Testing Library and HandsFreeOS played by stand-ins: a thumbs up, and what others said; a thumbs down's sheet,
 * then the AI reading it, its quick question and the rule it suggests, saved; a rule that goes against what it knows,
 * kept or used; someone who can't save one told who can; nothing to learn, and Try again; no signal; and in a test,
 * the run, what the customer said, and "Retry with the fix".
 */

jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  return { change: jest.fn(), ChangeError: actual.ChangeError, NEEDS_SIGNAL: actual.NEEDS_SIGNAL };
});
jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));
jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true, lastOnlineAt: 0 }) }));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MSG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MINE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LESSON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DALE = '11111111-1111-4111-8111-111111111111';
const DANA = '22222222-2222-4222-8222-222222222222';
const REPLY = 'Sure, we can come out Sunday at 10.';
const AT = '2026-10-15T14:00:00.000Z';

const feedback = (over: Partial<TeammateFeedbackOut> = {}): TeammateFeedbackOut => ({
  id: MINE,
  runId: RUN,
  messageId: MSG,
  isTest: false,
  rating: 'bad',
  betterReply: 'We’re closed Sundays. Monday at 10?',
  note: 'We don’t work Sundays',
  learn: 'reading',
  learnWhy: null,
  question: null,
  choices: [],
  answer: null,
  lesson: null,
  mine: true,
  by: { id: DALE, name: 'Dale Porter' },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});
const lesson = (over: Partial<NonNullable<TeammateFeedbackOut['lesson']>> = {}) => ({
  id: LESSON,
  line: 'We don’t work Sundays: offer Monday instead.',
  why: null,
  status: 'open' as const,
  conflict: null,
  ...over,
});

/** What HandsFreeOS has: the feedback on the replies asked about, and whether this person may save a rule. */
let mockServer: { feedback: TeammateFeedbackOut[]; canSaveRules: boolean } = {
  feedback: [],
  canSaveRules: true,
};
const post = api.POST as unknown as jest.Mock;
const said = (output: unknown) => ({ id: 'cmd', queued: false, output });
/** HandsFreeOS keeps the feedback given (or answered) and answers with it. */
const keeps = (f: TeammateFeedbackOut) =>
  jest.mocked(change).mockImplementationOnce(async () => {
    mockServer.feedback = [f];
    return said({ feedback: f }) as never;
  });

function Harness({
  test = false,
  onRetry,
}: {
  /** The test console's reply: by run, with what the customer said, and Retry with the fix. */
  test?: boolean;
  onRetry?: (c: Coaching) => void;
}) {
  const state = useReplyFeedback(WS, test ? { runIds: [RUN] } : { messageIds: [MSG] });
  return test ? (
    <ReplyFeedback
      state={state}
      reply={REPLY}
      runId={RUN}
      asked="Can you come Sunday?"
      onRetry={onRetry}
    />
  ) : (
    <ReplyFeedback state={state} reply={REPLY} messageId={MSG} align="end" />
  );
}

beforeEach(() => {
  mockServer = { feedback: [], canSaveRules: true };
  post.mockReset();
  post.mockImplementation(async () => ({
    data: {
      feedback: mockServer.feedback,
      messageRuns: [{ messageId: MSG, runId: RUN }],
      canSaveRules: mockServer.canSaveRules,
    },
    response: { ok: true },
  }));
  jest.mocked(change).mockReset();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('a reply in a conversation', () => {
  it('asks for the feedback on its message, shows what others said, and thanks a thumbs up', async () => {
    mockServer.feedback = [
      feedback({
        id: '33333333-3333-4333-8333-333333333333',
        mine: false,
        rating: 'good',
        by: { id: DANA, name: 'Dana' },
      }),
    ];
    await render(<Harness />);
    expect(await screen.findByTestId('feedback-others')).toHaveTextContent('Thumbs up from Dana');
    expect(post).toHaveBeenCalledWith('/v1/queries/ai_teammate.feedback', {
      body: { workspaceId: WS, runIds: [], messageIds: [MSG] },
    });

    keeps(feedback({ rating: 'good', betterReply: null, note: null, learn: 'none' }));
    await fireEvent.press(screen.getByTestId('feedback-good'));
    expect(change).toHaveBeenCalledWith('ai_teammate.give_feedback', {
      workspaceId: WS,
      messageId: MSG,
      rating: 'good',
    });
    expect(await screen.findByTestId('feedback-thanks')).toHaveTextContent(W.thanksGood);
    expect(screen.getByTestId('feedback-good').props.accessibilityState).toMatchObject({
      selected: true,
    });
  });

  it('takes a thumbs down with the better reply and why, then its quick question, then saves the rule', async () => {
    await render(<Harness />);
    await waitFor(() => expect(post).toHaveBeenCalled());

    await fireEvent.press(screen.getByTestId('feedback-bad'));
    // The reply, to change into what it should have said.
    expect(screen.getByTestId('feedback-better').props.value).toBe(REPLY);
    await fireEvent.changeText(
      screen.getByTestId('feedback-better'),
      'We’re closed Sundays. Monday at 10?',
    );
    await fireEvent.changeText(screen.getByTestId('feedback-note'), 'We don’t work Sundays');
    keeps(feedback());
    await fireEvent.press(screen.getByTestId('feedback-send'));
    expect(change).toHaveBeenCalledWith('ai_teammate.give_feedback', {
      workspaceId: WS,
      messageId: MSG,
      rating: 'bad',
      betterReply: 'We’re closed Sundays. Monday at 10?',
      note: 'We don’t work Sundays',
    });
    // The sheet stays, and so does the line under the reply, while the AI works it out.
    expect(await screen.findByTestId('feedback-sheet-reading')).toHaveTextContent(W.reading, {
      exact: false,
    });
    expect(screen.getByTestId('feedback-reading')).toHaveTextContent(W.reading);

    // Asked again a moment later: it has one quick question.
    mockServer.feedback = [
      feedback({
        learn: 'asking',
        question: 'All customers, or just this one?',
        choices: ['All customers', 'Just this one'],
      }),
    ];
    expect(await screen.findByTestId('feedback-question', {}, { timeout: 5000 })).toHaveTextContent(
      'All customers, or just this one?',
      { exact: false },
    );
    // Its line under the reply opens the sheet again, for someone who closed it.
    expect(screen.getByTestId('feedback-question-line')).toHaveTextContent(
      `${W.questionTitle}: All customers, or just this one?`,
    );
    keeps(feedback({ learn: 'suggested', answer: 'All customers', lesson: lesson() }));
    await fireEvent.press(screen.getByTestId('feedback-choice-0'));
    expect(change).toHaveBeenLastCalledWith('ai_teammate.answer_feedback', {
      workspaceId: WS,
      feedbackId: MINE,
      answer: 'All customers',
    });

    expect(await screen.findByTestId('feedback-rule')).toHaveTextContent(
      '“We don’t work Sundays: offer Monday instead.”',
    );
    jest.mocked(change).mockResolvedValueOnce(
      said({
        lessonId: LESSON,
        line: 'We don’t work Sundays: offer Monday instead.',
        instructionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        replaced: null,
      }),
    );
    await fireEvent.press(screen.getByTestId('feedback-save'));
    expect(change).toHaveBeenLastCalledWith('teammate_lesson.apply', {
      workspaceId: WS,
      lessonId: LESSON,
    });
    expect(toast.show).toHaveBeenLastCalledWith(W.saved);
    expect(await screen.findByTestId('feedback-saved')).toHaveTextContent(W.saved);
  }, 15_000);

  it('saves a rule as the person changed it', async () => {
    mockServer.feedback = [feedback({ learn: 'suggested', lesson: lesson() })];
    await render(<Harness />);
    await fireEvent.press(await screen.findByTestId('feedback-suggestion-line'));
    await fireEvent.press(screen.getByTestId('feedback-edit-rule'));
    await fireEvent.changeText(
      screen.getByTestId('feedback-rule-input'),
      'We’re closed Sundays. Offer Monday.',
    );
    jest.mocked(change).mockResolvedValueOnce(
      said({
        lessonId: LESSON,
        line: 'We’re closed Sundays. Offer Monday.',
        instructionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        replaced: null,
      }),
    );
    await fireEvent.press(screen.getByTestId('feedback-save'));
    expect(change).toHaveBeenCalledWith('teammate_lesson.apply', {
      workspaceId: WS,
      lessonId: LESSON,
      line: 'We’re closed Sundays. Offer Monday.',
    });
  });

  it('asks which is right when the rule goes against what it knows', async () => {
    const conflict = {
      place: 'policies' as const,
      itemId: null,
      where: 'Policies',
      existing: 'We work weekends.',
      replacement: 'We don’t work Sundays.',
      explain: 'Policies say you work weekends.',
    };
    mockServer.feedback = [feedback({ learn: 'suggested', lesson: lesson({ conflict }) })];
    const { unmount } = await render(<Harness />);
    await fireEvent.press(await screen.findByTestId('feedback-suggestion-line'));
    expect(screen.getByTestId('feedback-clash')).toHaveTextContent(
      'Policies say you work weekends.',
    );
    expect(screen.getByTestId('feedback-save')).toHaveTextContent(W.useNew);
    // Keep what's there: the rule is dropped, and nothing changes in what it knows.
    jest.mocked(change).mockResolvedValueOnce(said({ lessonId: LESSON }));
    await fireEvent.press(screen.getByTestId('feedback-drop'));
    expect(change).toHaveBeenCalledWith('teammate_lesson.dismiss', {
      workspaceId: WS,
      lessonId: LESSON,
    });
    expect(await screen.findByTestId('feedback-dropped')).toHaveTextContent(W.dropped);
    await unmount();

    // Use the new rule: its words take the old ones' place.
    await render(<Harness />);
    await fireEvent.press(await screen.findByTestId('feedback-suggestion-line'));
    jest.mocked(change).mockResolvedValueOnce(
      said({
        lessonId: LESSON,
        line: 'We don’t work Sundays: offer Monday instead.',
        instructionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        replaced: {
          where: 'Policies',
          before: 'We work weekends.',
          after: 'We don’t work Sundays.',
        },
      }),
    );
    await fireEvent.press(screen.getByTestId('feedback-save'));
    expect(change).toHaveBeenLastCalledWith('teammate_lesson.apply', {
      workspaceId: WS,
      lessonId: LESSON,
      replace: true,
    });
    expect(toast.show).toHaveBeenLastCalledWith(`${W.saved} Policies changed to match.`);
  });

  it('tells someone who can’t save a rule who can', async () => {
    mockServer = {
      feedback: [feedback({ learn: 'suggested', lesson: lesson() })],
      canSaveRules: false,
    };
    await render(<Harness />);
    await fireEvent.press(await screen.findByTestId('feedback-suggestion-line'));
    expect(screen.getByTestId('feedback-manager-saves')).toHaveTextContent(W.managerSaves);
    expect(screen.queryByTestId('feedback-save')).toBeNull();
  });

  it('says when there’s nothing to learn, and Try again sends the same feedback when the read failed', async () => {
    mockServer.feedback = [
      feedback({ learn: 'nothing', learnWhy: 'It already has a rule for this.' }),
    ];
    const { unmount } = await render(<Harness />);
    expect(await screen.findByTestId('feedback-nothing')).toHaveTextContent(
      'Nothing new to learn: it already has a rule for this.',
    );
    await unmount();

    mockServer.feedback = [feedback({ learn: 'failed' })];
    await render(<Harness />);
    expect(await screen.findByTestId('feedback-failed')).toHaveTextContent(W.failed, {
      exact: false,
    });
    keeps(feedback());
    await fireEvent.press(screen.getByTestId('feedback-try-again'));
    expect(change).toHaveBeenCalledWith('ai_teammate.give_feedback', {
      workspaceId: WS,
      messageId: MSG,
      rating: 'bad',
      betterReply: 'We’re closed Sundays. Monday at 10?',
      note: 'We don’t work Sundays',
    });
    expect(await screen.findByTestId('feedback-reading')).toBeTruthy();
  });

  it('asks for words after a bare thumbs down', async () => {
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId('feedback-bad'));
    expect(screen.getByText(W.needWords)).toBeTruthy();
    keeps(feedback({ betterReply: null, note: null, learn: 'none' }));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    expect(change).toHaveBeenCalledWith('ai_teammate.give_feedback', {
      workspaceId: WS,
      messageId: MSG,
      rating: 'bad',
      betterReply: null,
      note: null,
    });
    expect(await screen.findByTestId('feedback-need-words')).toHaveTextContent(W.needWords);
  });

  it('says it needs signal, and keeps what was written', async () => {
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId('feedback-bad'));
    await fireEvent.changeText(screen.getByTestId('feedback-note'), 'Too pushy');
    jest.mocked(change).mockRejectedValueOnce(new ChangeError('needs-signal', NEEDS_SIGNAL));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NEEDS_SIGNAL));
    expect(screen.getByTestId('feedback-note').props.value).toBe('Too pushy');
    expect(screen.getByTestId('feedback-send')).toBeTruthy();
  });
});

describe('a reply in the test console', () => {
  it('names the run and what the customer said, and offers Retry with the fix', async () => {
    const onRetry = jest.fn();
    await render(<Harness test onRetry={onRetry} />);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/queries/ai_teammate.feedback', {
        body: { workspaceId: WS, runIds: [RUN], messageIds: [] },
      }),
    );
    expect(screen.queryByTestId('feedback-retry')).toBeNull();

    await fireEvent.press(screen.getByTestId('feedback-bad'));
    await fireEvent.changeText(screen.getByTestId('feedback-note'), 'We don’t work Sundays');
    keeps(feedback({ messageId: null, isTest: true, betterReply: null }));
    await fireEvent.press(screen.getByTestId('feedback-send'));
    expect(change).toHaveBeenCalledWith('ai_teammate.give_feedback', {
      workspaceId: WS,
      runId: RUN,
      rating: 'bad',
      betterReply: null,
      note: 'We don’t work Sundays',
      asked: 'Can you come Sunday?',
    });
    await fireEvent.press(await screen.findByTestId('feedback-done'));
    await fireEvent.press(screen.getByTestId('feedback-retry'));
    expect(onRetry).toHaveBeenCalledWith({
      reply: REPLY,
      better: null,
      why: 'We don’t work Sundays',
    });
  });
});
