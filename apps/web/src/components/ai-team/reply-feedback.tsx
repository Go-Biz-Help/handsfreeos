'use client';
/**
 * Thumbs up or down on a reply the AI teammate wrote, in a test or for real
 * (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md). A thumbs down asks what it should have said and why; then the AI
 * suggests one rule to save, asks one quick question, or says there's nothing to learn. The test console adds "Retry
 * with the fix". The words are core's (FEEDBACK_WORDS), as on the phone.
 */
import {
  FEEDBACK_WORDS as W,
  feedbackStage,
  othersFeedbackWords,
  type FeedbackStage,
} from '@hfos/core';
import {
  Check,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  Lightbulb,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { FeedbackActions, ReplyFeedback as Feedback } from '@/lib/ai-team/feedback';
import { errorMessage } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/** What "Retry with the fix" sends the test console. */
export interface Coaching {
  readonly reply: string;
  readonly better: string | null;
  readonly why: string | null;
}

export function ReplyFeedback({
  workspaceId,
  actions,
  reply,
  runId,
  messageId,
  asked,
  mine,
  all = [],
  canSaveRules,
  slow,
  onChange,
  onRetry,
  align = 'start',
  className,
}: {
  workspaceId: string;
  actions: FeedbackActions;
  /** What the AI wrote. */
  reply: string;
  runId?: string | null;
  messageId?: string | null;
  /** A test only: what the customer said. */
  asked?: string | null;
  /** This person's feedback on it, if any. */
  mine: Feedback | null;
  /** Everyone's, to say what others thought. */
  all?: readonly Feedback[];
  canSaveRules: boolean;
  /** The read is taking longer than it should. */
  slow?: boolean;
  onChange: (f: Feedback) => void;
  /** The test console's "Retry with the fix". */
  onRetry?: (c: Coaching) => void;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [thanked, setThanked] = useState(false);
  const stage = feedbackStage(mine, canSaveRules);
  const others = othersFeedbackWords(all);
  const ids = { ...(runId ? { runId } : {}), ...(messageId ? { messageId } : {}) };

  async function give(input: {
    rating: 'good' | 'bad';
    betterReply?: string | null;
    note?: string | null;
  }) {
    setBusy(true);
    try {
      const f = await actions.give({ ...ids, ...input, ...(asked ? { asked } : {}) });
      onChange(f);
      setOpen(false);
      setThanked(input.rating === 'good');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const rating = mine?.rating ?? null;
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5',
        align === 'end' ? 'items-end' : 'items-start',
        className,
      )}
      data-testid="reply-feedback"
    >
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label={W.good}
          title={W.good}
          aria-pressed={rating === 'good'}
          disabled={busy}
          data-testid="feedback-good"
          className={cn('h-7 w-7', rating === 'good' && 'text-success-text')}
          onClick={() => void give({ rating: 'good' })}
        >
          <ThumbsUp className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={W.bad}
          title={W.bad}
          aria-pressed={rating === 'bad'}
          aria-expanded={open}
          disabled={busy}
          data-testid="feedback-bad"
          className={cn('h-7 w-7', rating === 'bad' && 'text-danger-text')}
          onClick={() => setOpen((o) => !o)}
        >
          <ThumbsDown className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Button>
        {others ? <span className="ml-1 text-[11.5px] text-text-3">{others}</span> : null}
      </div>
      {thanked && rating === 'good' && !open ? (
        <p className="text-[12px] text-text-3">{W.thanksGood}</p>
      ) : null}
      {open ? (
        <FeedbackForm
          reply={reply}
          initial={mine?.rating === 'bad' ? mine : null}
          busy={busy}
          onCancel={() => setOpen(false)}
          onSend={(better, note) =>
            void give({
              rating: 'bad',
              betterReply: better && better.trim() !== reply.trim() ? better : null,
              note: note || null,
            })
          }
        />
      ) : null}
      {!open && mine && rating === 'bad' ? (
        <Outcome
          workspaceId={workspaceId}
          actions={actions}
          stage={stage}
          feedback={mine}
          slow={!!slow}
          onChange={onChange}
          onAgain={() =>
            void give({ rating: 'bad', betterReply: mine.betterReply, note: mine.note })
          }
          onEdit={() => setOpen(true)}
        />
      ) : null}
      {onRetry && !open && mine?.rating === 'bad' && (mine.betterReply || mine.note) ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid="feedback-retry"
          onClick={() => onRetry({ reply, better: mine.betterReply, why: mine.note })}
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
          {W.retry}
        </Button>
      ) : null}
    </div>
  );
}

function FeedbackForm({
  reply,
  initial,
  busy,
  onCancel,
  onSend,
}: {
  reply: string;
  initial: Feedback | null;
  busy: boolean;
  onCancel: () => void;
  onSend: (better: string, note: string) => void;
}) {
  const id = useId();
  const [better, setBetter] = useState(initial?.betterReply ?? reply);
  const [note, setNote] = useState(initial?.note ?? '');
  const said = better.trim() !== reply.trim() || !!note.trim();
  return (
    <form
      className="flex w-full min-w-[260px] max-w-[440px] flex-col gap-2.5 rounded-card border border-border bg-card p-3 text-left shadow-1"
      data-testid="feedback-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSend(better.trim(), note.trim());
      }}
    >
      <div>
        <Label htmlFor={`${id}-better`}>{W.betterLabel}</Label>
        <Textarea
          id={`${id}-better`}
          value={better}
          maxLength={2000}
          onChange={(e) => setBetter(e.target.value)}
          className="min-h-[72px] text-sm"
          data-testid="feedback-better"
        />
        <p className="mt-1 text-[12px] text-text-3">{W.betterHint}</p>
      </div>
      <div>
        <Label htmlFor={`${id}-note`}>{W.noteLabel}</Label>
        <Input
          id={`${id}-note`}
          value={note}
          maxLength={500}
          placeholder={W.notePlaceholder}
          onChange={(e) => setNote(e.target.value)}
          inputSize="sm"
          data-testid="feedback-note"
        />
      </div>
      {!said ? <p className="text-[12px] text-text-3">{W.needWords}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy} data-testid="feedback-send">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {W.send}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {W.cancel}
        </Button>
      </div>
    </form>
  );
}

/** What came of a thumbs down: the read, the question, the rule to save, or nothing to learn. */
function Outcome({
  workspaceId,
  actions,
  stage,
  feedback,
  slow,
  onChange,
  onAgain,
  onEdit,
}: {
  workspaceId: string;
  actions: FeedbackActions;
  stage: FeedbackStage;
  feedback: Feedback;
  slow: boolean;
  onChange: (f: Feedback) => void;
  onAgain: () => void;
  onEdit: () => void;
}) {
  const box =
    'w-full max-w-[440px] rounded-card border border-border bg-card-2 p-3 text-left text-[13px]';
  switch (stage.kind) {
    case 'none':
    case 'rated':
      return (
        <button
          type="button"
          className="text-[12px] text-text-3 underline-offset-2 hover:underline"
          onClick={onEdit}
        >
          {W.needWords}
        </button>
      );
    case 'reading':
      return (
        <p
          className="flex items-center gap-1.5 text-[12.5px] text-text-2"
          data-testid="feedback-reading"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {slow ? W.slow : W.reading}
        </p>
      );
    case 'failed':
      return (
        <div className={box} data-testid="feedback-failed">
          <p className="text-text-2">{W.failed}</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={onAgain}>
            {W.tryAgain}
          </Button>
        </div>
      );
    case 'nothing':
      return (
        <p className="text-[12.5px] text-text-2" data-testid="feedback-nothing">
          {stage.words}
        </p>
      );
    case 'dropped':
      return <p className="text-[12.5px] text-text-3">{W.dropped}</p>;
    case 'saved':
      return (
        <div className={box} data-testid="feedback-saved">
          <p className="flex items-start gap-1.5 text-text">
            <Check className="mt-0.5 h-3.5 w-3.5 flex-none text-success-text" strokeWidth={2} />
            <span>“{stage.line}”</span>
          </p>
          <p className="mt-1 text-text-2">
            {W.saved}{' '}
            <Link
              href={`/app/w/${workspaceId}/ai-team/instructions`}
              className="text-accent-text underline-offset-2 hover:underline"
            >
              {W.seeInstructions}
            </Link>
          </p>
        </div>
      );
    case 'asking':
      return (
        <Question
          className={box}
          actions={actions}
          feedbackId={feedback.id}
          question={stage.question}
          choices={stage.choices}
          onChange={onChange}
        />
      );
    case 'suggested':
      return (
        <Suggestion
          className={box}
          actions={actions}
          stage={stage}
          feedback={feedback}
          onChange={onChange}
        />
      );
  }
}

function Question({
  className,
  actions,
  feedbackId,
  question,
  choices,
  onChange,
}: {
  className: string;
  actions: FeedbackActions;
  feedbackId: string;
  question: string;
  choices: readonly string[];
  onChange: (f: Feedback) => void;
}) {
  const id = useId();
  const [own, setOwn] = useState('');
  const [busy, setBusy] = useState(false);
  async function answer(words: string) {
    if (!words.trim()) return;
    setBusy(true);
    try {
      onChange(await actions.answer(feedbackId, words.trim()));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={className} data-testid="feedback-question">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-3">
        <MessageCircleQuestion className="h-3.5 w-3.5" strokeWidth={1.75} />
        {W.questionTitle}
      </p>
      <p className="mt-1 text-text">{question}</p>
      {choices.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {choices.map((c) => (
            <Button
              key={c}
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void answer(c)}
            >
              {c}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void answer(own);
        }}
      >
        <label htmlFor={`${id}-own`} className="sr-only">
          {W.answerPlaceholder}
        </label>
        <Input
          id={`${id}-own`}
          value={own}
          maxLength={300}
          placeholder={W.answerPlaceholder}
          inputSize="sm"
          onChange={(e) => setOwn(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || !own.trim()}>
          {W.answer}
        </Button>
      </form>
    </div>
  );
}

function Suggestion({
  className,
  actions,
  stage,
  feedback,
  onChange,
}: {
  className: string;
  actions: FeedbackActions;
  stage: Extract<FeedbackStage, { kind: 'suggested' }>;
  feedback: Feedback;
  onChange: (f: Feedback) => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [line, setLine] = useState(stage.line);
  const [busy, setBusy] = useState(false);
  const lesson = (status: 'applied' | 'dismissed', words = stage.line) =>
    onChange({
      ...feedback,
      lesson: feedback.lesson ? { ...feedback.lesson, status, line: words } : null,
    });
  async function save() {
    setBusy(true);
    try {
      const out = await actions.saveRule(stage.lessonId, {
        ...(line.trim() !== stage.line ? { line: line.trim() } : {}),
        ...(stage.clash ? { replace: true } : {}),
      });
      lesson('applied', out.line);
      toast.success(out.replaced ? `${W.saved} ${out.replaced.where} changed to match.` : W.saved);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function drop() {
    setBusy(true);
    try {
      await actions.dropRule(stage.lessonId);
      lesson('dismissed');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={className} data-testid="feedback-suggestion">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-text-3">
        <Lightbulb className="h-3.5 w-3.5" strokeWidth={1.75} />
        {W.suggestedTitle}
      </p>
      {editing ? (
        <>
          <label htmlFor={`${id}-line`} className="sr-only">
            The rule
          </label>
          <Textarea
            id={`${id}-line`}
            value={line}
            maxLength={300}
            onChange={(e) => setLine(e.target.value)}
            className="mt-1.5 min-h-[56px] text-sm"
          />
        </>
      ) : (
        <p className="mt-1 text-[14px] font-medium text-text">“{line}”</p>
      )}
      {stage.clash ? (
        <p className="mt-1.5 rounded-control bg-warning-soft px-2 py-1.5 text-[12.5px] text-warning-text">
          {stage.clash.explain}
        </p>
      ) : null}
      {stage.canSave ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            disabled={busy || !line.trim()}
            onClick={() => void save()}
            data-testid="feedback-save"
          >
            {stage.clash ? W.useNew : W.save}
          </Button>
          {!editing ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
              {W.edit}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void drop()}>
            {stage.clash ? W.keepOld : W.notNow}
          </Button>
        </div>
      ) : (
        <p className="mt-1.5 text-[12.5px] text-text-2">{W.managerSaves}</p>
      )}
    </div>
  );
}
