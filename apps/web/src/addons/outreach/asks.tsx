'use client';
/**
 * Asking the extension (docs/outreach.md, decision 43): what needs the browser is asked of the person's working
 * computer from here. The buttons on the Friends, Groups, Chats and Today tabs make an ask (`outreach.ask.make`); the
 * computer takes it, says how it's going, hands a step to the person when it can't find it, and says how it ended.
 * These are the shared pieces: the button, the line under it with **Carry on**, **Skip** and **Stop**, the box for a
 * code from their email, and the note that says why the buttons wait. The rules and words are core's (packages/core/src/addons/outreach/asks.ts).
 *
 * An ask is made on a network (Facebook when a screen names none): a button on a network's screen carries its
 * `platform`, shows only for the kinds that network can be asked (`ASK_KINDS_ON`), and its line is its own network's
 * ask, never another's of the same kind.
 */
import {
  askableOn,
  askedWords,
  askOpen,
  askRepliesFor,
  askReplyLabel,
  askWaitingWords,
  askNameOn,
  ASK_REPLIES,
  ASK_SHOWN_STATES,
  ASK_TONES,
  ASK_CODE_SENT_WORDS,
  ASK_TYPING_WORDS,
  ASK_WORDS,
  cantAskWhy,
  tooOldFor,
  computerNoteWords,
  latestAsk,
  latestAskOn,
  targetOf,
  type AskInput,
  type AskShownState,
} from '@hfos/core/addons/outreach/asks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { clockWords } from '@hfos/core/addons/outreach/live';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import type { Ask, Asks } from './types';
import { useAct } from './use-act';

const TONES: Record<AskShownState, BadgeVariant> = ASK_TONES;

/** Finding a button's ask, and why it can't ask: core's, the phone's too. */
export { cantAskWhy, latestAsk, latestAskOn, targetOf };

/**
 * A button that asks the computer, with the line of its latest ask under it. Disabled while one like it is open (its
 * line has **Stop**), with no computer, and after a warning today for anything on Facebook. None for a kind its
 * network can't be asked.
 */
export function AskButton({
  workspaceId,
  asks,
  ask,
  platform = 'facebook',
  label,
  variant = 'secondary',
  size = 'sm',
  disabled = false,
  showLine = true,
  testId,
  onAsked,
}: {
  workspaceId: string;
  asks: Asks;
  ask: AskInput;
  /** The network it's asked on. */
  platform?: Platform;
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  showLine?: boolean;
  testId?: string;
  onAsked?: (ask: Ask) => void;
}) {
  const { busy, act } = useAct();
  const kind = ask.kind;
  const target = targetOf(ask);
  const latest = latestAskOn(asks, platform, kind, target);
  const open = latest !== null && askOpen(latest.state);
  const why = cantAskWhy(asks, kind, platform);
  const press = () =>
    void act(`ask:${kind}`, async () => {
      const made = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.ask.make', {
          body: { workspaceId, platform, ask },
        }),
      );
      toast.success(askedWords(made, asks, Date.now()));
      onAsked?.(made.ask);
    });
  if (!askableOn(platform, kind)) return null;
  return (
    <div className="grid content-start gap-1.5" data-testid={testId ? `${testId}-box` : undefined}>
      <div>
        <Button
          variant={variant}
          size={size}
          onClick={press}
          loading={busy === `ask:${kind}`}
          disabled={disabled || busy !== null || open || why !== null}
          title={why ?? (open ? ASK_WORDS.onIt : undefined)}
          data-testid={testId}
        >
          {label}
        </Button>
      </div>
      {/* An older extension can't do this kind: said here, since the tab's note is about the computer. */}
      {asks.computer && tooOldFor(asks.computer.version, kind, platform) ? (
        <p className="text-[12.5px] text-warning-text" data-testid="outreach-ask-too-old">
          {why}
        </p>
      ) : null}
      {showLine && latest ? <AskLine workspaceId={workspaceId} asks={asks} ask={latest} /> : null}
    </div>
  );
}

/**
 * How an ask is going: its state, its line and when; **Carry on** and **Skip** while a step is handed to the person,
 * the box for a code from their email while it waits on one, and **Stop** while it's open. Typing says to type on the
 * computer: HandsFreeOS never sees a password.
 */
export function AskLine({
  workspaceId,
  asks,
  ask,
  named = false,
  className,
}: {
  workspaceId: string;
  /** The business's clock and the computer, for when and the words while it waits. */
  asks: Pick<Asks, 'timezone' | 'computer' | 'now'>;
  ask: Ask;
  /** Say what was asked first, for the Live tab's and Waiting for you's lists. */
  named?: boolean;
  className?: string;
}) {
  const { busy, act } = useAct();
  const open = askOpen(ask.state);
  const replies = ask.state === 'stuck' && ask.reply === null ? askRepliesFor(ask.kind) : [];
  const at = ask.endedAt ?? ask.startedAt ?? ask.askedAt;
  const reply = (r: keyof typeof ASK_REPLIES) =>
    void act(`reply:${r}`, async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.ask.reply', {
          body: { workspaceId, askId: ask.askId, reply: r },
        }),
      ),
    );
  const stop = () =>
    void act(
      'stop',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.ask.cancel', {
            body: { workspaceId, askId: ask.askId },
          }),
        ),
      ASK_WORDS.stopped,
    );
  return (
    <div
      className={cn('rounded-menu bg-card-2 p-2.5 text-[12.5px]', className)}
      data-testid="ask-line"
      data-ask-state={ask.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={TONES[ask.state]} data-testid="ask-state">
          {ASK_SHOWN_STATES[ask.state]}
        </Badge>
        {named ? (
          <span className="font-medium">
            {askNameOn(ask.kind, ask.platform)}
            {ask.about ? ` · ${ask.about}` : ''}
          </span>
        ) : ask.about ? (
          <span className="text-text-2">{ask.about}</span>
        ) : null}
        <span className="tabular-nums text-text-3">{clockWords(at, asks.timezone)}</span>
      </div>
      {ask.state === 'typing' ? (
        <p className="mt-1.5 text-warning-text" role="status">
          {ASK_TYPING_WORDS}
        </p>
      ) : ask.line ? (
        <p
          className={cn(
            'mt-1.5',
            ask.state === 'stuck' || ask.state === 'code' ? 'text-warning-text' : 'text-text-2',
          )}
          role={open ? 'status' : undefined}
          data-testid="ask-line-words"
        >
          {ask.line}
        </p>
      ) : ask.state === 'waiting' ? (
        <p className="mt-1.5 text-text-2">
          {askWaitingWords(asks.computer, asks.timezone, Date.parse(asks.now), ask.platform)}
        </p>
      ) : null}
      {ask.state === 'stuck' && ask.reply ? (
        <p className="mt-1.5 text-text-3">{ASK_WORDS.youSaid(ask.reply)}</p>
      ) : null}
      {ask.state === 'code' ? <CodeBox workspaceId={workspaceId} askId={ask.askId} /> : null}
      {open ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {replies.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={r === 'carry_on' ? 'primary' : 'secondary'}
              onClick={() => reply(r)}
              loading={busy === `reply:${r}`}
              disabled={busy !== null}
              data-testid={`ask-${r}`}
            >
              {askReplyLabel(ask, r)}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={stop}
            loading={busy === 'stop'}
            disabled={busy !== null}
            data-testid="ask-stop"
          >
            {ASK_WORDS.stop}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The code a network emailed them, for their computer to put in: sent once, it says so till the computer takes it,
 * with a way to type it again (a typo, or a newer email).
 */
function CodeBox({ workspaceId, askId }: { workspaceId: string; askId: string }) {
  const id = useId();
  const { busy, act } = useAct();
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const send = (e: FormEvent) => {
    e.preventDefault();
    void act('code', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.ask.code', {
          body: { workspaceId, askId, code },
        }),
      );
      setSent(true);
      setCode('');
    });
  };
  if (sent)
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p className="text-text-2" role="status" data-testid="ask-code-sent">
          {ASK_CODE_SENT_WORDS}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setSent(false)}>
          {ASK_WORDS.anotherCode}
        </Button>
      </div>
    );
  return (
    <form onSubmit={send} className="mt-2 flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="sr-only">
        {ASK_WORDS.code}
      </label>
      <Input
        id={id}
        inputSize="sm"
        className="w-44"
        autoComplete="one-time-code"
        placeholder={ASK_WORDS.code}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        data-testid="ask-code"
      />
      <Button
        size="sm"
        type="submit"
        loading={busy === 'code'}
        disabled={busy !== null || code.trim() === ''}
        data-testid="ask-code-send"
      >
        {ASK_WORDS.sendCode}
      </Button>
    </form>
  );
}

/** Why the buttons wait, once for a tab: no computer, it's signed out or offline, or Facebook warned them today. */
export function ComputerNote({ asks, className }: { asks: Asks; className?: string }) {
  const words = computerNoteWords(asks);
  if (!words) return null;
  return (
    <p
      className={cn(
        'rounded-menu p-2.5 text-[12.5px]',
        asks.warnedToday ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text',
        className,
      )}
      role="status"
      data-testid="ask-computer-note"
    >
      {words}
    </p>
  );
}
