import {
  FEEDBACK_ANSWER_MAX,
  FEEDBACK_NOTE_MAX,
  FEEDBACK_REPLY_MAX,
  FEEDBACK_WORDS as W,
  feedbackStage,
  INSTRUCTION_MAX,
  othersFeedbackWords,
  type FeedbackStage,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import {
  Check,
  ChevronRight,
  Lightbulb,
  MessageCircleQuestionMark,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import {
  feedbackOn,
  myFeedback,
  type Coaching,
  type ReplyFeedback as Feedback,
  type ReplyFeedbackState,
} from '@/ai-team/feedback';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

/**
 * Thumbs up or down on a reply the AI teammate wrote, in a conversation or the test console, as the web's
 * components/ai-team/reply-feedback.tsx (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md). A thumbs down opens a sheet
 * asking what it should have said and why; once sent, the sheet shows what came of it: the AI working it out, one
 * quick question to tap an answer to, or a rule to save. Under the reply, a line says where it stands and opens the
 * sheet again. The test console adds "Retry with the fix". The words are core's (FEEDBACK_WORDS), as on the web.
 *
 * Everything here needs signal: with none, the command says "This needs signal." and what was typed stays.
 */

const failed = (error: unknown) =>
  toast.error(error instanceof Error ? error.message : String(error));

export function ReplyFeedback({
  state,
  reply,
  runId,
  messageId,
  asked,
  onRetry,
  align = 'start',
}: {
  state: ReplyFeedbackState;
  /** What the AI wrote. */
  reply: string;
  runId?: string | null;
  messageId?: string | null;
  /** A test only: what the customer said. */
  asked?: string | null;
  /** The test console's "Retry with the fix". */
  onRetry?: (c: Coaching) => void;
  /** Under the business's own messages, on the right. */
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<'form' | 'outcome'>('form');
  /** A new form each time it opens, with the person's last words or the reply. */
  const [formKey, setFormKey] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [thanked, setThanked] = React.useState(false);
  const ref = { runId, messageId };
  const mine = myFeedback(state, ref);
  const others = othersFeedbackWords(feedbackOn(state, ref));
  const stage = feedbackStage(mine, state.canSaveRules);
  const rating = mine?.rating ?? null;

  const openForm = () => {
    setView('form');
    setFormKey((k) => k + 1);
    setOpen(true);
  };
  const openOutcome = () => {
    setView('outcome');
    setOpen(true);
  };

  async function give(input: {
    rating: 'good' | 'bad';
    betterReply?: string | null;
    note?: string | null;
  }) {
    setBusy(true);
    try {
      const f = await state.calls.give({
        ...(runId ? { runId } : {}),
        ...(messageId ? { messageId } : {}),
        ...input,
        ...(asked ? { asked } : {}),
      });
      state.put(f);
      setThanked(input.rating === 'good');
      // Words to read: the sheet stays to show what comes of them. A bare thumbs down has nothing to show.
      if (input.rating === 'bad' && f.learn !== 'none') setView('outcome');
      else setOpen(false);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  }
  /** Try again: the same feedback once more, which reads it again. */
  const again = () =>
    mine && void give({ rating: 'bad', betterReply: mine.betterReply, note: mine.note });

  return (
    <View
      className={cn('gap-1.5 px-1', align === 'end' ? 'items-end self-end' : 'items-start')}
      testID="reply-feedback"
    >
      <View className="flex-row items-center gap-0.5">
        <Thumb
          icon={ThumbsUp}
          label={W.good}
          on={rating === 'good'}
          onClass="text-success-text"
          disabled={busy}
          onPress={() => void give({ rating: 'good' })}
          testID="feedback-good"
        />
        <Thumb
          icon={ThumbsDown}
          label={W.bad}
          on={rating === 'bad'}
          onClass="text-danger-text"
          disabled={busy}
          onPress={openForm}
          testID="feedback-bad"
        />
        {others ? (
          <Text className="ml-1 shrink text-xs text-text-3" testID="feedback-others">
            {others}
          </Text>
        ) : null}
      </View>
      {thanked && rating === 'good' ? (
        <Text className="text-xs text-text-3" testID="feedback-thanks">
          {W.thanksGood}
        </Text>
      ) : null}
      {mine && rating === 'bad' ? (
        <StageLine
          stage={stage}
          slow={state.slow}
          align={align}
          onOpen={openOutcome}
          onEdit={openForm}
          onAgain={again}
        />
      ) : null}
      {onRetry && mine?.rating === 'bad' && (mine.betterReply || mine.note) ? (
        <Button
          variant="secondary"
          size="sm"
          icon={RotateCcw}
          onPress={() => onRetry({ reply, better: mine.betterReply, why: mine.note })}
          testID="feedback-retry"
        >
          {W.retry}
        </Button>
      ) : null}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={view === 'form' ? W.bad : sheetTitle(stage)}
        testID="feedback-sheet"
      >
        {view === 'form' ? (
          <FeedbackForm
            key={formKey}
            reply={reply}
            initial={mine?.rating === 'bad' ? mine : null}
            busy={busy}
            onCancel={() => setOpen(false)}
            onSend={(better, note) =>
              void give({
                rating: 'bad',
                betterReply: better && better !== reply.trim() ? better : null,
                note: note || null,
              })
            }
          />
        ) : mine ? (
          <Outcome
            state={state}
            stage={stage}
            feedback={mine}
            busy={busy}
            onAgain={again}
            onEdit={openForm}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

/** A small thumb, with room around it for a finger. */
function Thumb({
  icon,
  label,
  on,
  onClass,
  disabled,
  onPress,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  on: boolean;
  onClass: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      className={cn(
        'size-8 items-center justify-center rounded-full active:bg-card-2',
        disabled && 'opacity-50',
      )}
      testID={testID}
    >
      <Icon
        as={icon}
        className={cn('size-4', on ? onClass : 'text-text-3')}
        strokeWidth={on ? 2 : 1.75}
      />
    </Pressable>
  );
}

function sheetTitle(stage: FeedbackStage): string | undefined {
  if (stage.kind === 'asking') return W.questionTitle;
  if (stage.kind === 'suggested') return W.suggestedTitle;
  return undefined;
}

/** Under the reply: where the person's thumbs down stands, opening the sheet when there's something to do. */
function StageLine({
  stage,
  slow,
  align,
  onOpen,
  onEdit,
  onAgain,
}: {
  stage: FeedbackStage;
  slow: boolean;
  align: 'start' | 'end';
  onOpen: () => void;
  onEdit: () => void;
  onAgain: () => void;
}) {
  const colors = useColors();
  const right = align === 'end' && 'text-right';
  switch (stage.kind) {
    case 'none':
    case 'rated':
      return (
        <Pressable role="button" onPress={onEdit} testID="feedback-need-words">
          <Text className={cn('text-xs text-text-3 underline', right)}>{W.needWords}</Text>
        </Pressable>
      );
    case 'reading':
      return (
        <View className="flex-row items-center gap-1.5" testID="feedback-reading">
          <ActivityIndicator size="small" color={colors.text3} />
          <Text className={cn('shrink text-xs text-text-2', right)}>
            {slow ? W.slow : W.reading}
          </Text>
        </View>
      );
    case 'failed':
      return (
        <View className="flex-row flex-wrap items-center gap-x-1.5" testID="feedback-failed">
          <Text className="text-xs text-text-2">{W.failed}</Text>
          <Pressable
            role="button"
            onPress={onAgain}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            className="h-6 justify-center"
            testID="feedback-try-again"
          >
            <Text className="text-xs font-semibold text-accent-text">{W.tryAgain}</Text>
          </Pressable>
        </View>
      );
    case 'nothing':
      return (
        <Text className={cn('text-xs text-text-2', right)} testID="feedback-nothing">
          {stage.words}
        </Text>
      );
    case 'dropped':
      return (
        <Text className={cn('text-xs text-text-3', right)} testID="feedback-dropped">
          {W.dropped}
        </Text>
      );
    case 'saved':
      return (
        <View className="flex-row items-start gap-1" testID="feedback-saved">
          <Icon as={Check} className="mt-px size-3.5 text-success-text" strokeWidth={2} />
          <Text className={cn('shrink text-xs text-text-2', right)}>{W.saved}</Text>
        </View>
      );
    case 'asking':
      return (
        <OpenLine
          icon={MessageCircleQuestionMark}
          words={`${W.questionTitle}: ${stage.question}`}
          onPress={onOpen}
          testID="feedback-question-line"
        />
      );
    case 'suggested':
      return (
        <OpenLine
          icon={Lightbulb}
          words={W.suggestedTitle}
          onPress={onOpen}
          testID="feedback-suggestion-line"
        />
      );
  }
}

function OpenLine({
  icon,
  words,
  onPress,
  testID,
}: {
  icon: LucideIcon;
  words: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      className="max-w-full flex-row items-center gap-1.5 rounded-control bg-accent-soft px-2.5 py-1.5 active:opacity-80"
      testID={testID}
    >
      <Icon as={icon} className="size-3.5 text-accent-text" strokeWidth={1.75} />
      <Text className="shrink text-[13px] font-medium text-accent-text" numberOfLines={2}>
        {words}
      </Text>
      <Icon as={ChevronRight} className="size-3.5 text-accent-text" />
    </Pressable>
  );
}

/** What it should have said (the reply, to change) and why. */
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
  const keyboard = useKeyboardHeight();
  const [better, setBetter] = React.useState(initial?.betterReply ?? reply);
  const [note, setNote] = React.useState(initial?.note ?? '');
  const said = better.trim() !== reply.trim() || !!note.trim();
  return (
    <View
      style={keyboard ? { paddingBottom: keyboard } : undefined}
      className="mt-3 gap-3"
      testID="feedback-form"
    >
      <View className="gap-1.5">
        <Label>{W.betterLabel}</Label>
        <Input
          value={better}
          onChangeText={setBetter}
          multiline
          maxLength={FEEDBACK_REPLY_MAX}
          textAlignVertical="top"
          accessibilityLabel={W.betterLabel}
          className="h-28 items-stretch"
          style={{ paddingTop: 11, paddingBottom: 11 }}
          testID="feedback-better"
        />
        <Text className="text-[13px] leading-[18px] text-text-3">{W.betterHint}</Text>
      </View>
      <View className="gap-1.5">
        <Label>{W.noteLabel}</Label>
        <Input
          value={note}
          onChangeText={setNote}
          maxLength={FEEDBACK_NOTE_MAX}
          placeholder={W.notePlaceholder}
          accessibilityLabel={W.noteLabel}
          testID="feedback-note"
        />
      </View>
      {!said ? <Text className="text-[13px] leading-[18px] text-text-3">{W.needWords}</Text> : null}
      <View className="gap-2">
        <Button
          loading={busy}
          onPress={() => onSend(better.trim(), note.trim())}
          testID="feedback-send"
        >
          {W.send}
        </Button>
        <Button variant="ghost" onPress={onCancel}>
          {W.cancel}
        </Button>
      </View>
    </View>
  );
}

/** In the sheet, once sent: the AI working it out, its quick question, the rule to save, or how it ended. */
function Outcome({
  state,
  stage,
  feedback,
  busy,
  onAgain,
  onEdit,
  onDone,
}: {
  state: ReplyFeedbackState;
  stage: FeedbackStage;
  feedback: Feedback;
  busy: boolean;
  onAgain: () => void;
  onEdit: () => void;
  onDone: () => void;
}) {
  const colors = useColors();
  const done = (
    <Button variant="secondary" className="mt-4" onPress={onDone} testID="feedback-done">
      Done
    </Button>
  );
  switch (stage.kind) {
    case 'reading':
      return (
        <View className="mt-3" testID="feedback-sheet-reading">
          <View className="flex-row items-center gap-2.5">
            <ActivityIndicator size="small" color={colors.text3} />
            <Text className="min-w-0 flex-1 text-[15px] leading-[21px] text-text-2">
              {state.slow ? W.slow : W.reading}
            </Text>
          </View>
          {done}
        </View>
      );
    case 'asking':
      return (
        <Question
          state={state}
          feedbackId={feedback.id}
          question={stage.question}
          choices={stage.choices}
        />
      );
    case 'suggested':
      return <Suggestion state={state} stage={stage} feedback={feedback} onDone={onDone} />;
    case 'failed':
      return (
        <View className="mt-3" testID="feedback-sheet-failed">
          <Text className="text-[15px] leading-[21px] text-text-2">{W.failed}</Text>
          <Button className="mt-4" loading={busy} onPress={onAgain} testID="feedback-sheet-again">
            {W.tryAgain}
          </Button>
        </View>
      );
    case 'saved':
      return (
        <View className="mt-3">
          <View className="flex-row items-start gap-2">
            <Icon as={Check} className="mt-0.5 size-4 text-success-text" strokeWidth={2} />
            <Text className="min-w-0 flex-1 text-[15px] font-medium leading-[21px]">
              “{stage.line}”
            </Text>
          </View>
          <Text className="mt-1.5 text-[14px] leading-[20px] text-text-2">{W.saved}</Text>
          {done}
        </View>
      );
    case 'dropped':
    case 'nothing':
      return (
        <View className="mt-3">
          <Text className="text-[15px] leading-[21px] text-text-2">
            {stage.kind === 'nothing' ? stage.words : W.dropped}
          </Text>
          {done}
        </View>
      );
    case 'none':
    case 'rated':
      return (
        <View className="mt-3">
          <Text className="text-[15px] leading-[21px] text-text-2">{W.needWords}</Text>
          <Button variant="secondary" className="mt-4" onPress={onEdit}>
            {W.change}
          </Button>
        </View>
      );
  }
}

/** One quick question, with answers to tap or one to write. It asks once, never twice. */
function Question({
  state,
  feedbackId,
  question,
  choices,
}: {
  state: ReplyFeedbackState;
  feedbackId: string;
  question: string;
  choices: readonly string[];
}) {
  const keyboard = useKeyboardHeight();
  const [own, setOwn] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  async function answer(words: string) {
    if (!words.trim() || busy) return;
    setBusy(true);
    try {
      state.put(await state.calls.answer(feedbackId, words.trim()));
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View
      style={keyboard ? { paddingBottom: keyboard } : undefined}
      className="mt-2 gap-3"
      testID="feedback-question"
    >
      <Text className="text-[15px] leading-[21px]">{question}</Text>
      {choices.length ? (
        <View className="flex-row flex-wrap gap-2">
          {choices.map((c, i) => (
            <Button
              key={c}
              variant="secondary"
              size="md"
              disabled={busy}
              onPress={() => void answer(c)}
              testID={`feedback-choice-${i}`}
            >
              {c}
            </Button>
          ))}
        </View>
      ) : null}
      <Input
        value={own}
        onChangeText={setOwn}
        maxLength={FEEDBACK_ANSWER_MAX}
        placeholder={W.answerPlaceholder}
        accessibilityLabel={W.answerPlaceholder}
        returnKeyType="send"
        onSubmitEditing={() => void answer(own)}
        testID="feedback-own-answer"
      />
      <Button
        loading={busy}
        disabled={!own.trim()}
        onPress={() => void answer(own)}
        testID="feedback-answer"
      >
        {W.answer}
      </Button>
    </View>
  );
}

/** The rule it suggests: save it (changed first, if need be) or not, or, for someone who can't, who can. */
function Suggestion({
  state,
  stage,
  feedback,
  onDone,
}: {
  state: ReplyFeedbackState;
  stage: Extract<FeedbackStage, { kind: 'suggested' }>;
  feedback: Feedback;
  onDone: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const [editing, setEditing] = React.useState(false);
  const [line, setLine] = React.useState(stage.line);
  const [busy, setBusy] = React.useState<'save' | 'drop' | null>(null);
  const decided = (status: 'applied' | 'dismissed', words = stage.line) =>
    state.put({
      ...feedback,
      lesson: feedback.lesson ? { ...feedback.lesson, status, line: words } : null,
    });
  async function save() {
    setBusy('save');
    try {
      const out = await state.calls.saveRule(stage.lessonId, {
        ...(line.trim() !== stage.line ? { line: line.trim() } : {}),
        ...(stage.clash ? { replace: true } : {}),
      });
      decided('applied', out.line);
      toast.show(out.replaced ? `${W.saved} ${out.replaced.where} changed to match.` : W.saved);
      onDone();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
    }
  }
  async function drop() {
    setBusy('drop');
    try {
      await state.calls.dropRule(stage.lessonId);
      decided('dismissed');
      onDone();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
    }
  }
  return (
    <View
      style={keyboard ? { paddingBottom: keyboard } : undefined}
      className="mt-2 gap-3"
      testID="feedback-suggestion"
    >
      {editing ? (
        <Input
          value={line}
          onChangeText={setLine}
          multiline
          autoFocus
          maxLength={INSTRUCTION_MAX}
          textAlignVertical="top"
          accessibilityLabel={W.suggestedTitle}
          className="h-24 items-stretch"
          style={{ paddingTop: 11, paddingBottom: 11 }}
          testID="feedback-rule-input"
        />
      ) : (
        <Text className="text-[16px] font-medium leading-[23px]" testID="feedback-rule">
          “{line}”
        </Text>
      )}
      {stage.clash ? (
        <Text
          className="rounded-menu bg-warning-soft px-3 py-2 text-[13.5px] leading-[19px] text-warning-text"
          testID="feedback-clash"
        >
          {stage.clash.explain}
        </Text>
      ) : null}
      {stage.canSave ? (
        <View className="gap-2">
          <Button
            loading={busy === 'save'}
            disabled={!!busy || !line.trim()}
            onPress={() => void save()}
            testID="feedback-save"
          >
            {stage.clash ? W.useNew : W.save}
          </Button>
          {!editing ? (
            <Button
              variant="secondary"
              disabled={!!busy}
              onPress={() => setEditing(true)}
              testID="feedback-edit-rule"
            >
              {W.edit}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            loading={busy === 'drop'}
            disabled={!!busy}
            onPress={() => void drop()}
            testID="feedback-drop"
          >
            {stage.clash ? W.keepOld : W.notNow}
          </Button>
        </View>
      ) : (
        <>
          <Text className="text-[14px] leading-[20px] text-text-2" testID="feedback-manager-saves">
            {W.managerSaves}
          </Text>
          <Button variant="secondary" onPress={onDone} testID="feedback-done">
            Done
          </Button>
        </>
      )}
    </View>
  );
}
