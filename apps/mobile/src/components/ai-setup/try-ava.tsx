import {
  AI_SETUP_FIELD_WORDS as W,
  AI_SETUP_OUTCOME_WORDS,
  AI_SETUP_WORDS,
  aiSetupChatSnippet,
  aiSetupWentToPerson,
  withAiName,
  type TestOutcome,
} from '@hfos/core';
import * as Linking from 'expo-linking';
import * as React from 'react';
import { Share, View } from 'react-native';

import type { AiSetupCalls } from '@/ai-setup/calls';
import { AI_SETUP_PHONE_WORDS as P } from '@/ai-setup/words';
import { streamTest, TestConsoleError } from '@/ai-team/test-stream';
import {
  Check,
  ExternalLink,
  MessageSquare,
  Send,
  Share as ShareIcon,
  TriangleAlert,
  UserRound,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { errorMessage } from '@/lib/api';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';

import { TextArea } from './fields';

/**
 * The last screen of quick setup on the phone (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4 screen 12, §8),
 * as the web's components/ai-setup/try-ava.tsx: what Save couldn't finish, the chat's code when it added one, then a
 * test chat that asks the teammate the questions made from the business. Each answer shows as it's written; one that
 * went to a person gets "Add the answer", which saves an answer to Knowledge and asks again. Then "Turn on with
 * training wheels".
 *
 * The test is the test console's (`streamTest`, the worker's POST /v1/ai-team/test) with the saved settings: look-ups
 * are real, nothing is sent, and it never counts toward training wheels.
 */

interface Asked {
  readonly id: number;
  readonly question: string;
  readonly state: 'waiting' | 'asking' | 'done' | 'error';
  readonly reply: string;
  readonly outcome: TestOutcome | null;
  readonly error: string | null;
}

const asked = (id: number, question: string): Asked => ({
  id,
  question,
  state: 'waiting',
  reply: '',
  outcome: null,
  error: null,
});

/** It didn't answer itself: the question is worth an answer in Knowledge. */
const unanswered = (a: Asked) => a.state === 'done' && aiSetupWentToPerson(a.outcome);

/** Why a question couldn't be asked, in the words the phone says it. */
function failureWords(e: unknown): string {
  if (!(e instanceof TestConsoleError)) return errorMessage(e);
  // Not in this build, or not on this server yet: the web has it.
  return e.failure === 'not_configured' || e.failure === 'gone' ? P.testNotHere : e.message;
}

export function TryAva({
  workspaceId,
  name,
  questions,
  teammate,
  notes,
  chat,
  pageUrl = null,
  calls,
  onDone,
}: {
  workspaceId: string;
  name: string;
  /** The questions the test starts with. */
  questions: readonly string[];
  teammate: { id: string; status: 'off' | 'training' | 'automatic'; approvals: number };
  /** What Save couldn't finish. */
  notes: readonly string[];
  /** The website chat Save added. */
  chat: { publicKey: string } | null;
  /** The business's simple page, when the chat went on it because there's no website: nothing to paste then. */
  pageUrl?: string | null;
  calls: AiSetupCalls;
  /** Turned on, or "Not yet". */
  onDone: (turnedOn: boolean) => void;
}) {
  const [list, setList] = React.useState<readonly Asked[]>(() =>
    questions.map((q, i) => asked(i, q)),
  );
  const [own, setOwn] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [turning, setTurning] = React.useState(false);
  const [turnError, setTurnError] = React.useState<string | null>(null);
  const nextId = React.useRef(questions.length);
  const abort = React.useRef<AbortController | null>(null);
  const update = (id: number, patch: Partial<Asked>) =>
    setList((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  // Leaving stops the answer being written.
  React.useEffect(() => () => abort.current?.abort(), []);

  /** Asks one question, as a new customer writing in, and shows the answer as it's written. */
  async function ask(a: Pick<Asked, 'id' | 'question'>): Promise<boolean> {
    const stop = new AbortController();
    abort.current = stop;
    update(a.id, { state: 'asking', reply: '', outcome: null, error: null });
    let failed: string | null = null;
    try {
      await streamTest(
        {
          workspaceId,
          channel: 'sms',
          messages: [{ from: 'customer', text: a.question }],
        },
        (e) => {
          if (e.type === 'delta')
            setList((l) => l.map((x) => (x.id === a.id ? { ...x, reply: x.reply + e.text } : x)));
          else if (e.type === 'done')
            update(a.id, { state: 'done', outcome: e.outcome, reply: e.reply ?? '' });
          else if (e.type === 'error') failed = e.message;
        },
        stop.signal,
      );
    } catch (e) {
      failed = failureWords(e);
    }
    if (stop.signal.aborted) return false;
    if (failed) update(a.id, { state: 'error', error: failed });
    return !failed;
  }

  async function askAll() {
    setBusy(true);
    try {
      for (const a of list.filter((x) => x.state === 'waiting' || x.state === 'error'))
        if (!(await ask(a))) break;
    } finally {
      setBusy(false);
    }
  }

  async function askOwn() {
    const question = own.trim();
    if (!question) return;
    const a = asked(nextId.current++, question);
    setList((l) => [...l, a]);
    setOwn('');
    setBusy(true);
    try {
      await ask(a);
    } finally {
      setBusy(false);
    }
  }

  async function turnOn() {
    setTurning(true);
    setTurnError(null);
    try {
      await calls.turnOn(teammate.id);
      onDone(true);
    } catch (e) {
      setTurnError(errorMessage(e));
      setTurning(false);
    }
  }

  const done = list.filter((a) => a.state === 'done');
  const gaps = done.filter(unanswered);
  const waiting = list.some((a) => a.state === 'waiting' || a.state === 'error');
  const on = teammate.status !== 'off';

  return (
    <View className="gap-5" testID="ai-setup-try">
      {notes.map((n) => (
        <View
          key={n}
          className="flex-row items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-3"
          role="alert"
        >
          <Icon as={TriangleAlert} className="mt-0.5 size-4 text-warning-text" />
          <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-warning-text">{n}</Text>
        </View>
      ))}
      {chat && pageUrl ? (
        <ChatOnPage name={name} pageUrl={pageUrl} />
      ) : chat ? (
        <ChatCode workspaceId={workspaceId} publicKey={chat.publicKey} calls={calls} />
      ) : null}

      <View className="gap-3">
        <View className="flex-row items-center gap-2">
          <Icon as={MessageSquare} className="size-4 text-text-2" />
          <Text className="text-base font-semibold">{withAiName(W.reportTitle, name)}</Text>
        </View>
        {waiting ? (
          <Button
            onPress={() => void askAll()}
            loading={busy}
            disabled={busy}
            testID="ai-setup-ask-all"
          >
            {withAiName(W.askThese, name)}
          </Button>
        ) : null}
        <View className="gap-3" testID="ai-setup-test">
          {list.map((a) => (
            <TestRow
              key={a.id}
              a={a}
              name={name}
              busy={busy}
              onAnswer={async (answer) => {
                await calls.addAnswer(a.question, answer);
                setBusy(true);
                try {
                  await ask(a);
                } finally {
                  setBusy(false);
                }
              }}
            />
          ))}
        </View>
        {done.length && !waiting ? (
          <Text
            className={cn(
              'text-[13.5px] leading-[19px]',
              gaps.length ? 'text-warning-text' : 'text-success-text',
            )}
            testID="ai-setup-report"
          >
            {gaps.length ? W.reportGaps(gaps.length) : withAiName(W.reportAllKnown, name)}
          </Text>
        ) : null}
        <View className="flex-row items-center gap-2">
          <Input
            className="flex-1"
            value={own}
            onChangeText={setOwn}
            placeholder={W.askOwn}
            accessibilityLabel={W.askOwn}
            maxLength={2000}
            returnKeyType="send"
            onSubmitEditing={() => void askOwn()}
            testID="ai-setup-ask-own"
          />
          <Button
            variant="secondary"
            icon={Send}
            disabled={busy || !own.trim()}
            onPress={() => void askOwn()}
            accessibilityLabel={W.ask}
            testID="ai-setup-ask-own-send"
          >
            {W.ask}
          </Button>
        </View>
        <Text className="text-[13px] leading-[18px] text-text-3">
          {withAiName(W.textTip, name)}
        </Text>
      </View>

      <View className="gap-2.5 border-t border-border pt-4">
        {on ? (
          <>
            <View className="flex-row items-center gap-2" testID="ai-setup-on">
              <Icon as={Check} className="size-4 text-success-text" strokeWidth={2} />
              <Text className="min-w-0 flex-1 text-[14px] text-success-text">
                {withAiName(W.isOn, name)}
              </Text>
            </View>
            <Button onPress={() => onDone(false)} testID="ai-setup-done">
              {AI_SETUP_WORDS.done}
            </Button>
          </>
        ) : (
          <>
            <Button onPress={() => void turnOn()} loading={turning} testID="ai-setup-turn-on">
              {AI_SETUP_WORDS.turnOn}
            </Button>
            <FieldError testID="ai-setup-turn-on-error">{turnError}</FieldError>
            <Text className="text-[12.5px] leading-[17px] text-text-3">
              {withAiName(W.turnedOn(teammate.approvals), name)}
            </Text>
            <Button
              variant="ghost"
              disabled={turning}
              onPress={() => onDone(false)}
              testID="ai-setup-not-yet"
            >
              {AI_SETUP_WORDS.notYet}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="md"
          icon={ExternalLink}
          onPress={() => void openWeb(`/app/w/${workspaceId}/ai-team`)}
          testID="ai-setup-more-settings"
        >
          {AI_SETUP_WORDS.moreSettings}
        </Button>
      </View>
    </View>
  );
}

function TestRow({
  a,
  name,
  busy,
  onAnswer,
}: {
  a: Asked;
  name: string;
  busy: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [answer, setAnswer] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const gap = unanswered(a);
  const save = async () => {
    if (!answer.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onAnswer(answer.trim());
      setOpen(false);
      setAnswer('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="gap-2 p-3.5" testID={`ai-setup-test-${a.id}`}>
      <View className="flex-row items-start gap-2">
        <Icon as={UserRound} className="mt-0.5 size-4 text-text-3" />
        <Text className="min-w-0 flex-1 font-medium">{a.question}</Text>
        {a.state === 'done' && a.outcome ? (
          <Badge variant={gap ? 'pending' : 'ok'} testID={`ai-setup-test-${a.id}-outcome`}>
            {AI_SETUP_OUTCOME_WORDS[a.outcome]}
          </Badge>
        ) : null}
      </View>
      {a.state === 'asking' && !a.reply ? (
        <Text className="pl-6 text-[13.5px] text-text-3">{W.asking}</Text>
      ) : a.reply ? (
        <View className="rounded-[10px] bg-card-2 px-3 py-2">
          <Text
            className="text-[14px] leading-[20px]"
            accessibilityLabel={`${name}: ${a.reply}`}
            testID={`ai-setup-test-${a.id}-reply`}
          >
            {a.reply}
          </Text>
        </View>
      ) : null}
      <FieldError testID={`ai-setup-test-${a.id}-error`}>{a.error}</FieldError>
      {gap && !open ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={busy}
          onPress={() => setOpen(true)}
          testID={`ai-setup-test-${a.id}-add`}
        >
          {W.addAnswer}
        </Button>
      ) : null}
      {gap && open ? (
        <View className="gap-2">
          <TextArea
            value={answer}
            onChangeText={setAnswer}
            placeholder={withAiName(W.addAnswerHint, name)}
            accessibilityLabel={W.answer}
            maxLength={5000}
            className="h-24"
            testID={`ai-setup-test-${a.id}-answer`}
          />
          <FieldError>{error}</FieldError>
          <View className="flex-row gap-2">
            <Button
              size="sm"
              loading={saving}
              disabled={!answer.trim()}
              onPress={() => void save()}
              testID={`ai-setup-test-${a.id}-save`}
            >
              {W.addAnswer}
            </Button>
            <Button variant="ghost" size="sm" onPress={() => setOpen(false)}>
              {AI_SETUP_WORDS.cancel}
            </Button>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/** The chat Save put on the business's simple page: it's already there, so only a way to see it. */
function ChatOnPage({ name, pageUrl }: { name: string; pageUrl: string }) {
  return (
    <Card className="gap-2.5 p-3.5" testID="ai-setup-chat-on-page">
      <Text className="text-base font-semibold">{withAiName(W.chatOnPage, name)}</Text>
      <Text className="text-[13px] leading-[18px] text-text-2">{W.chatOnPageHint}</Text>
      <Button
        variant="ghost"
        size="md"
        icon={ExternalLink}
        className="self-start"
        onPress={() => void Linking.openURL(pageUrl)}
        testID="ai-setup-chat-open-page"
      >
        {W.chatOnPageOpen}
      </Button>
    </Card>
  );
}

/**
 * The website chat Save added: the code to paste, shared from the phone (to email it to whoever looks after the
 * website), and the full instructions on the web.
 */
function ChatCode({
  workspaceId,
  publicKey,
  calls,
}: {
  workspaceId: string;
  publicKey: string;
  calls: AiSetupCalls;
}) {
  const [origin, setOrigin] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    void calls.chatOrigin().then((o) => alive && setOrigin(o));
    return () => {
      alive = false;
    };
  }, [calls]);
  const snippet = origin ? aiSetupChatSnippet(origin, publicKey) : null;
  return (
    <Card className="gap-2.5 p-3.5" testID="ai-setup-chat-code">
      <Text className="text-base font-semibold">{W.chatCode}</Text>
      <Text className="text-[13px] leading-[18px] text-text-2">{W.chatCodeHint}</Text>
      {snippet ? (
        <>
          <View className="rounded-[10px] bg-card-2 px-3 py-2.5">
            <Text
              variant="mono"
              selectable
              className="text-[12.5px] leading-[18px]"
              testID="ai-setup-chat-snippet"
            >
              {snippet}
            </Text>
          </View>
          <Button
            variant="secondary"
            icon={ShareIcon}
            onPress={() => void Share.share({ message: snippet })}
            testID="ai-setup-chat-share"
          >
            {P.shareCode}
          </Button>
        </>
      ) : null}
      <Button
        variant="ghost"
        size="md"
        icon={ExternalLink}
        className="self-start"
        onPress={() => void openWeb(`/app/w/${workspaceId}/settings/website-chat`)}
        testID="ai-setup-chat-more"
      >
        {W.chatMoreWays}
      </Button>
    </Card>
  );
}
