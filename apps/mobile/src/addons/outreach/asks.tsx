import {
  ASK_KINDS,
  ASK_KINDS_FOR,
  ASK_REPLIES,
  ASK_SHOWN_STATES,
  ASK_TONES,
  ASK_TYPING_WORDS,
  ASK_WORDS,
  askedWords,
  askNeedsYou,
  askOpen,
  askRepliesFor,
  askWaitingWords,
  cantAskWhy,
  tooOldFor,
  computerNoteWords,
  latestAsk,
  targetOf,
  type AskInput,
  type AskReply,
  type AskShown,
  type AsksOutput,
} from '@hfos/core/addons/outreach/asks';
import { clockWords } from '@hfos/core/addons/outreach/live';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import type { LiveAnswer } from '@/lib/live-answer';

import { Note, Part, useOutreachAnswer, useOutreachContext } from './kit';

/**
 * Asking the extension from the phone (decisions 43 and 44): the buttons on the Groups and Chats screens ask the
 * person's working computer to do something on Facebook (`outreach.ask.make`), the line under each says how it's
 * going, and a step handed to the person has **Carry on** and **Skip** (`outreach.ask.reply`), with **Stop**
 * (`outreach.ask.cancel`). The Live screen lists what was asked; Waiting for you, what needs the person. All of it
 * needs signal. The words and rules are core's (`@hfos/core/addons/outreach/asks`), the web's too.
 */

/** Asked again this often while a screen with asks is open: an ask moves on within seconds. */
export const ASKS_REFETCH_SECONDS = 15;

/** What a screen asked: one tab's kinds, or all of them (the Live screen). */
export function useAsks(
  tab: keyof typeof ASK_KINDS_FOR | null,
  screen: string,
): LiveAnswer<AsksOutput> {
  const ws = useOutreachContext().workspaceId;
  return useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.asks', {
          body: { workspaceId: ws, ...(tab ? { kinds: [...ASK_KINDS_FOR[tab]] } : {}) },
        }),
      ),
    `asks:${ws}:${tab ?? 'all'}`,
    screen,
    { everySeconds: ASKS_REFETCH_SECONDS },
  );
}

/**
 * Calls `reload` when an ask on the screen has just ended done, so what it saved shows: not on the first answer, and
 * once for each.
 */
export function useDoneReload(asks: AsksOutput | null, reload: () => void): void {
  const done = asks
    ? asks.asks
        .filter((a) => a.state === 'done')
        .map((a) => a.askId)
        .join(',')
    : null;
  const seen = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (done === null) return;
    if (seen.current !== null && seen.current !== done) reload();
    seen.current = done;
  }, [done, reload]);
}

/** What the buttons and lines do: ask, answer a step handed over, and stop; `busy` names the one under way. */
export interface AskActions {
  readonly busy: string | null;
  ask(ask: AskInput): void;
  reply(ask: AskShown, reply: AskReply): void;
  stop(ask: AskShown): void;
}

function failed(e: unknown) {
  toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
}

/** The actions, through the phone's changes (online: they go straight to HandsFreeOS), each reloading the screen. */
export function useAskActions(asks: AsksOutput | null, reload: () => void): AskActions {
  const ws = useOutreachContext().workspaceId;
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = React.useCallback(
    async (key: string, act: () => Promise<string | null>) => {
      setBusy(key);
      try {
        const said = await act();
        if (said) toast.show(said);
        reload();
      } catch (e) {
        failed(e);
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );
  return React.useMemo(
    () => ({
      busy,
      ask: (ask) =>
        void run(`ask:${ask.kind}:${targetOf(ask)}`, async () => {
          const made = await change('outreach.ask.make', { workspaceId: ws, ask });
          return asks ? askedWords(made.output, asks, Date.now()) : null;
        }),
      reply: (ask, reply) =>
        void run(`reply:${ask.askId}:${reply}`, async () => {
          await change('outreach.ask.reply', { workspaceId: ws, askId: ask.askId, reply });
          return null;
        }),
      stop: (ask) =>
        void run(`stop:${ask.askId}`, async () => {
          await change('outreach.ask.cancel', { workspaceId: ws, askId: ask.askId });
          return ASK_WORDS.stopped;
        }),
    }),
    [busy, run, ws, asks],
  );
}

/**
 * A button that asks the computer, with the line of its latest ask under it. Disabled while one like it is open (its
 * line has **Stop**), with no computer, and after a warning today for anything on Facebook.
 */
export function AskButton({
  asks,
  ask,
  label,
  actions,
  variant = 'secondary',
  disabled = false,
  showLine = true,
  testID,
}: {
  asks: AsksOutput;
  ask: AskInput;
  label: string;
  actions: AskActions;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  showLine?: boolean;
  testID?: string;
}) {
  const target = targetOf(ask);
  const latest = latestAsk(asks, ask.kind, target);
  const open = latest !== null && askOpen(latest.state);
  const why = cantAskWhy(asks, ask.kind);
  const key = `ask:${ask.kind}:${target}`;
  return (
    <View className="gap-1.5">
      <Button
        size="md"
        variant={variant}
        className="self-start"
        onPress={() => actions.ask(ask)}
        loading={actions.busy === key}
        disabled={disabled || actions.busy !== null || open || why !== null}
        testID={testID}
      >
        {label}
      </Button>
      {/* An older extension can't do this kind: said here, since the screen's note is about the computer. */}
      {asks.computer && tooOldFor(asks.computer.version, ask.kind) ? (
        <Text
          className="text-[13px] leading-[18px] text-warning-text"
          testID="outreach-ask-too-old"
        >
          {why}
        </Text>
      ) : null}
      {showLine && latest ? <AskLine asks={asks} ask={latest} actions={actions} /> : null}
    </View>
  );
}

/**
 * How an ask is going: its state, its line and when; **Carry on** and **Skip** while a step is handed to the person,
 * and **Stop** while it's open. Typing says to type on the computer: HandsFreeOS never sees a password.
 */
export function AskLine({
  asks,
  ask,
  actions,
  named = false,
}: {
  /** The business's clock and the computer, for when and the words while it waits. */
  asks: Pick<AsksOutput, 'timezone' | 'computer' | 'now'>;
  ask: AskShown;
  actions: AskActions;
  /** Say what was asked first, for the Live screen's and Waiting for you's lists. */
  named?: boolean;
}) {
  const open = askOpen(ask.state);
  const replies = ask.state === 'stuck' && ask.reply === null ? askRepliesFor(ask.kind) : [];
  const at = ask.endedAt ?? ask.startedAt ?? ask.askedAt;
  const words =
    ask.state === 'typing'
      ? ASK_TYPING_WORDS
      : (ask.line ??
        (ask.state === 'waiting'
          ? askWaitingWords(asks.computer, asks.timezone, Date.parse(asks.now))
          : null));
  return (
    <Card className="gap-1.5 bg-card-2 px-3 py-2.5" testID="ask-line">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge variant={ASK_TONES[ask.state]} testID="ask-state">
          <Text>{ASK_SHOWN_STATES[ask.state]}</Text>
        </Badge>
        {named ? (
          <Text className="text-[13.5px] font-medium">
            {ASK_KINDS[ask.kind]}
            {ask.about ? ` · ${ask.about}` : ''}
          </Text>
        ) : ask.about ? (
          <Note>{ask.about}</Note>
        ) : null}
        <Text className="text-[12.5px] text-text-3">{clockWords(at, asks.timezone)}</Text>
      </View>
      {words ? (
        <Text
          className={
            askNeedsYou(ask.state)
              ? 'text-[13px] leading-[18px] text-warning-text'
              : 'text-[13px] leading-[18px] text-text-2'
          }
          testID="ask-line-words"
        >
          {words}
        </Text>
      ) : null}
      {ask.state === 'stuck' && ask.reply ? <Note>{ASK_WORDS.youSaid(ask.reply)}</Note> : null}
      {open ? (
        <View className="flex-row flex-wrap gap-2">
          {replies.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === 'carry_on' ? 'primary' : 'secondary'}
              onPress={() => actions.reply(ask, r)}
              loading={actions.busy === `reply:${ask.askId}:${r}`}
              disabled={actions.busy !== null}
              testID={`ask-${r}`}
            >
              {ASK_REPLIES[r]}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onPress={() => actions.stop(ask)}
            loading={actions.busy === `stop:${ask.askId}`}
            disabled={actions.busy !== null}
            testID="ask-stop"
          >
            {ASK_WORDS.stop}
          </Button>
        </View>
      ) : null}
    </Card>
  );
}

/** Why the buttons wait, once for a screen: no computer, it's signed out or offline, or Facebook warned them today. */
export function ComputerNote({ asks }: { asks: AsksOutput }) {
  const words = computerNoteWords(asks);
  if (!words) return null;
  return (
    <Text
      className={
        asks.warnedToday
          ? 'text-[13px] leading-[18px] text-danger-text'
          : 'text-[13px] leading-[18px] text-warning-text'
      }
      testID="ask-computer-note"
    >
      {words}
    </Text>
  );
}

/** The Live screen's list: what the person asked their computer, today's and the open ones, each as it goes. */
export function AskedPart({ asks, actions }: { asks: AsksOutput; actions: AskActions }) {
  return (
    <Part title={ASK_WORDS.askedTitle} testID="live-asks">
      {asks.asks.length ? (
        <View className="gap-2">
          {asks.asks.map((a) => (
            <AskLine key={a.askId} asks={asks} ask={a} actions={actions} named />
          ))}
        </View>
      ) : (
        <Card className="px-4 py-3.5">
          <Note testID="live-asks-empty">{ASK_WORDS.askedNone}</Note>
        </Card>
      )}
    </Part>
  );
}
