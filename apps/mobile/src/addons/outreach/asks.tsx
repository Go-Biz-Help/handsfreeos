import {
  askNameOn,
  ASK_KINDS_FOR,
  ASK_SHOWN_STATES,
  ASK_TONES,
  ASK_CODE_SENT_WORDS,
  ASK_TYPING_WORDS,
  ASK_WORDS,
  askedWords,
  askableOn,
  askNeedsYou,
  askOpen,
  askRepliesFor,
  askReplyLabel,
  askWaitingWords,
  cantAskWhy,
  tooOldFor,
  computerNoteWords,
  latestAskOn,
  targetOf,
  type AskInput,
  type AskReply,
  type AskShown,
  type AsksOutput,
} from '@hfos/core/addons/outreach/asks';
import { clockWords } from '@hfos/core/addons/outreach/live';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import * as React from 'react';
import { View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import type { LiveAnswer } from '@/lib/live-answer';

import { Note, Part, useOutreachAnswer, useOutreachContext } from './kit';

/**
 * Asking the extension from the phone (decisions 43 and 44): the buttons on the Groups and Chats screens ask the
 * person's working computer to do something on Facebook (`outreach.ask.make`), the line under each says how it's
 * going, and a step handed to the person has **Carry on** and **Skip** (`outreach.ask.reply`), with **Stop**
 * (`outreach.ask.cancel`); one waiting on a code a network emailed them has a box for it (`outreach.ask.code`). The Live screen lists what was asked; Waiting for you, what needs the person. All of it
 * needs signal. The words and rules are core's (`@hfos/core/addons/outreach/asks`), the web's too. A button on a
 * network's screen asks that network (`platform`, Facebook's when it names none), only the kinds it can be asked.
 */

/** Asked again this often while a screen with asks is open: an ask moves on within seconds. */
export const ASKS_REFETCH_SECONDS = 15;

/** What a screen asked: one tab's kinds, or all of them (the Live screen). With `on` false, nothing's asked. */
export function useAsks(
  tab: keyof typeof ASK_KINDS_FOR | null,
  screen: string,
  on = true,
  everySeconds = ASKS_REFETCH_SECONDS,
): LiveAnswer<AsksOutput> {
  const ws = useOutreachContext().workspaceId;
  return useOutreachAnswer(
    on
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/outreach.asks', {
              body: { workspaceId: ws, ...(tab ? { kinds: [...ASK_KINDS_FOR[tab]] } : {}) },
            }),
          )
      : null,
    `asks:${ws}:${tab ?? 'all'}`,
    screen,
    { everySeconds },
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
  /** Asks the computer, on a network: Facebook when left out. */
  ask(ask: AskInput, platform?: Platform): void;
  reply(ask: AskShown, reply: AskReply): void;
  stop(ask: AskShown): void;
  /** Sends the code from their email for their computer to put in: true once it's sent. */
  code?(ask: AskShown, code: string): Promise<boolean>;
}

function failed(e: unknown) {
  toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
}

/** The actions, through the phone's changes (online: they go straight to HandsFreeOS), each reloading the screen. */
export function useAskActions(asks: AsksOutput | null, reload: () => void): AskActions {
  const ws = useOutreachContext().workspaceId;
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = React.useCallback(
    async (key: string, act: () => Promise<string | null>): Promise<boolean> => {
      setBusy(key);
      try {
        const said = await act();
        if (said) toast.show(said);
        reload();
        return true;
      } catch (e) {
        failed(e);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );
  return React.useMemo(
    () => ({
      busy,
      ask: (ask, platform) =>
        void run(`ask:${ask.kind}:${targetOf(ask)}`, async () => {
          const made = await change('outreach.ask.make', {
            workspaceId: ws,
            ...(platform ? { platform } : {}),
            ask,
          });
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
      code: (ask, code) =>
        run(`code:${ask.askId}`, async () => {
          await change('outreach.ask.code', { workspaceId: ws, askId: ask.askId, code });
          return null;
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
  platform,
  label,
  actions,
  variant = 'secondary',
  disabled = false,
  showLine = true,
  testID,
}: {
  asks: AsksOutput;
  ask: AskInput;
  /** The network it's asked on: Facebook's when left out. None shows for a kind it can't be asked. */
  platform?: Platform;
  label: string;
  actions: AskActions;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  showLine?: boolean;
  testID?: string;
}) {
  const target = targetOf(ask);
  const on = platform ?? 'facebook';
  const latest = latestAskOn(asks, on, ask.kind, target);
  const open = latest !== null && askOpen(latest.state);
  const why = cantAskWhy(asks, ask.kind, on);
  const key = `ask:${ask.kind}:${target}`;
  if (!askableOn(on, ask.kind)) return null;
  return (
    <View className="gap-1.5">
      <Button
        size="md"
        variant={variant}
        className="self-start"
        onPress={() => (platform ? actions.ask(ask, platform) : actions.ask(ask))}
        loading={actions.busy === key}
        disabled={disabled || actions.busy !== null || open || why !== null}
        testID={testID}
      >
        {label}
      </Button>
      {/* An older extension can't do this kind: said here, since the screen's note is about the computer. */}
      {asks.computer && tooOldFor(asks.computer.version, ask.kind, on) ? (
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
 * the box for a code from their email while it waits on one, and **Stop** while it's open. Typing says to type on the
 * computer: HandsFreeOS never sees a password.
 */
export function AskLine({
  asks,
  ask,
  actions,
  named = false,
  focusCode = false,
}: {
  /** The business's clock and the computer, for when and the words while it waits. */
  asks: Pick<AsksOutput, 'timezone' | 'computer' | 'now'>;
  ask: AskShown;
  actions: AskActions;
  /** Say what was asked first, for the Live screen's and Waiting for you's lists. */
  named?: boolean;
  /** The code's box takes the keyboard at once: the code's own screen. */
  focusCode?: boolean;
}) {
  const open = askOpen(ask.state);
  const replies = ask.state === 'stuck' && ask.reply === null ? askRepliesFor(ask.kind) : [];
  const at = ask.endedAt ?? ask.startedAt ?? ask.askedAt;
  const words =
    ask.state === 'typing'
      ? ASK_TYPING_WORDS
      : (ask.line ??
        (ask.state === 'waiting'
          ? askWaitingWords(asks.computer, asks.timezone, Date.parse(asks.now), ask.platform)
          : null));
  return (
    <Card className="gap-1.5 bg-card-2 px-3 py-2.5" testID="ask-line">
      <View className="flex-row flex-wrap items-center gap-2">
        <Badge variant={ASK_TONES[ask.state]} testID="ask-state">
          <Text>{ASK_SHOWN_STATES[ask.state]}</Text>
        </Badge>
        {named ? (
          <Text className="text-[13.5px] font-medium">
            {askNameOn(ask.kind, ask.platform)}
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
      {ask.state === 'code' && actions.code ? (
        <CodeBox ask={ask} actions={actions} focus={focusCode} />
      ) : null}
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
              {askReplyLabel(ask, r)}
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

/**
 * The code a network emailed them, for their computer to put in: sent once, it says so till the computer takes it,
 * with a way to type it again (a typo, or a newer email).
 */
function CodeBox({
  ask,
  actions,
  focus = false,
}: {
  ask: AskShown;
  actions: AskActions;
  focus?: boolean;
}) {
  const [code, setCode] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const busy = actions.busy === `code:${ask.askId}`;
  const send = async () => {
    if (await actions.code?.(ask, code)) {
      setSent(true);
      setCode('');
    }
  };
  if (sent)
    return (
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-[13px] leading-[18px] text-text-2" testID="ask-code-sent">
          {ASK_CODE_SENT_WORDS}
        </Text>
        <Button size="sm" variant="ghost" onPress={() => setSent(false)}>
          {ASK_WORDS.anotherCode}
        </Button>
      </View>
    );
  return (
    <View className="gap-2">
      <Input
        value={code}
        onChangeText={setCode}
        placeholder={ASK_WORDS.code}
        accessibilityLabel={ASK_WORDS.code}
        autoFocus={focus}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        autoCapitalize="characters"
        autoCorrect={false}
        returnKeyType="send"
        onSubmitEditing={() => void send()}
        testID="ask-code"
      />
      <Button
        size="sm"
        className="self-start"
        onPress={() => void send()}
        loading={busy}
        disabled={actions.busy !== null || code.trim() === ''}
        testID="ask-code-send"
      >
        {ASK_WORDS.sendCode}
      </Button>
    </View>
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
