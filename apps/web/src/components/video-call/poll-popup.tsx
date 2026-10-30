'use client';
/**
 * A live poll's question popping up on a customer's screen in a HandsFreeOS video call
 * (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 2): pick one, pick any, yes or no, a number, a short answer, or a
 * button. Their answer goes to the worker on their own link and lands on their contact. When the question closes,
 * the totals show for a few seconds if it shares them.
 *
 * - **Only the server's word counts.** A question comes on the polls topic from the worker, which LiveKit delivers
 *   with nobody's name on it; the same topic from someone in the call is ignored.
 * - **Coming in late**, or back after a dropped connection, the page asks the worker what's up.
 */
import {
  POLL_WORDS,
  VIDEO_CALL_POLLS_TOPIC,
  pollSecondsLeft,
  readPollMessage,
  type PollOnScreen,
  type PollTotals,
} from '@hfos/core';
import { useConnectionState, useDataChannel } from '@livekit/components-react';
import { ConnectionState } from 'livekit-client';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { answerCallPoll, getCallPoll } from '@/lib/api/public-booking';
import { errorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { Answers } from './poll-panel';

/** How long a closed question's totals stay up. */
const RESULTS_MS = 8_000;

type Shown =
  | { readonly kind: 'asking'; readonly poll: PollOnScreen; readonly done: 'no' | 'sent' | 'talk' }
  | { readonly kind: 'results'; readonly title: string; readonly totals: PollTotals };

export function PollPopup({ token, business }: { token: string; business: string }) {
  const state = useConnectionState();
  const [shown, setShown] = useState<Shown | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [owner, setOwner] = useState(business);

  // In, or back in: whatever is up now.
  useEffect(() => {
    if (state !== ConnectionState.Connected) return;
    let live = true;
    void getCallPoll(token)
      .then((a) => {
        if (!live) return;
        setOwner(a.business || business);
        if (a.poll) {
          setShown({ kind: 'asking', poll: a.poll, done: a.answered ? 'sent' : 'no' });
          setHidden(false);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [state, token, business]);

  useDataChannel(VIDEO_CALL_POLLS_TOPIC, (msg) => {
    // The worker's messages come from the server, with no one's name on them.
    if (msg.from) return;
    const m = readPollMessage(msg.payload);
    if (!m) return;
    if (m.t === 'open') {
      setShown({ kind: 'asking', poll: m.poll, done: 'no' });
      setHidden(false);
      setError(null);
      return;
    }
    // The AI's "Ask now?" is the team's alone (and never sent to a customer).
    if (m.t !== 'close') return;
    setShown((was) => {
      if (was?.kind !== 'asking' || was.poll.pollId !== m.pollId) return was;
      return m.totals ? { kind: 'results', title: was.poll.title, totals: m.totals } : null;
    });
  });

  // The clock while a question is up, and the totals going away.
  useEffect(() => {
    if (shown?.kind === 'asking') {
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
    }
    if (shown?.kind === 'results') {
      const t = setTimeout(() => setShown(null), RESULTS_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [shown]);

  if (!shown || hidden) return null;

  const send = async (value: unknown) => {
    if (shown.kind !== 'asking' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const a = await answerCallPoll(token, { pollId: shown.poll.pollId, value });
      if (a.status === 'closed') setError(POLL_WORDS.closed);
      else
        setShown({
          ...shown,
          done: shown.poll.button?.action === 'talk' ? 'talk' : 'sent',
        });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const left = shown.kind === 'asking' ? pollSecondsLeft(shown.poll.closesAt, now) : 0;

  return (
    <div
      className="absolute inset-x-2 bottom-2 z-30 mx-auto max-w-[420px] rounded-card border border-border bg-card p-4 shadow-3 sm:bottom-4"
      role="dialog"
      aria-label={shown.kind === 'asking' ? shown.poll.title : POLL_WORDS.results}
      data-testid="call-poll-popup"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold" data-testid="call-poll-title">
            {shown.kind === 'asking' ? shown.poll.title : shown.title}
          </p>
          {shown.kind === 'asking' && shown.poll.help ? (
            <p className="text-[13px] text-text-2">{shown.poll.help}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Hide"
          onClick={() => setHidden(true)}
          className="rounded-control p-1 text-text-3 hover:bg-card-2 hover:text-text"
        >
          <X size={16} />
        </button>
      </div>
      {shown.kind === 'results' ? (
        <div data-testid="call-poll-results">
          <Answers q={{ totals: shown.totals, texts: [], pressed: [] }} />
        </div>
      ) : shown.done !== 'no' ? (
        <p
          className="mt-3 flex items-center gap-1.5 text-[13.5px] text-success-text"
          data-testid="call-poll-thanks"
        >
          <Check size={16} aria-hidden />
          {shown.done === 'talk' ? POLL_WORDS.talkSent : POLL_WORDS.thanks}
        </p>
      ) : (
        <AnswerControls poll={shown.poll} busy={busy} onSend={(v) => void send(v)} />
      )}
      {error ? (
        <p className="mt-2 text-[12.5px] text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2 text-[11.5px] text-text-3">
        <span>{POLL_WORDS.saved(owner)}</span>
        {shown.kind === 'asking' ? (
          <span className="tabular-nums">{POLL_WORDS.secondsLeft(left)}</span>
        ) : null}
      </div>
    </div>
  );
}

const choiceClass = (on: boolean) =>
  cn(
    'w-full rounded-control border px-3 py-2 text-left text-[13.5px] transition-colors',
    on ? 'border-accent bg-accent-soft text-accent-text' : 'border-border hover:bg-card-2',
  );

/** What they answer with, for each kind of question. */
function AnswerControls({
  poll,
  busy,
  onSend,
}: {
  poll: PollOnScreen;
  busy: boolean;
  onSend: (value: unknown) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  switch (poll.type) {
    case 'choice':
    case 'yes_no':
      return (
        <div className="mt-3 flex flex-col gap-1.5">
          {poll.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busy}
              className={choiceClass(false)}
              onClick={() => onSend(c.id)}
              data-testid="call-poll-choice"
            >
              {c.label}
            </button>
          ))}
        </div>
      );
    case 'checkboxes':
      return (
        <div className="mt-3 flex flex-col gap-1.5">
          {poll.choices.map((c) => {
            const on = picked.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                className={choiceClass(on)}
                onClick={() => setPicked(on ? picked.filter((x) => x !== c.id) : [...picked, c.id])}
                data-testid="call-poll-choice"
              >
                {c.label}
              </button>
            );
          })}
          <Button
            className="mt-1"
            disabled={!picked.length}
            loading={busy}
            onClick={() => onSend(picked)}
            data-testid="call-poll-send"
          >
            {POLL_WORDS.send}
          </Button>
        </div>
      );
    case 'rating':
    case 'scale': {
      const numbers: number[] = [];
      for (let n = poll.min; n <= poll.max; n++) numbers.push(n);
      return (
        <div className="mt-3">
          <div className="flex flex-wrap gap-1.5">
            {numbers.map((n) => (
              <button
                key={n}
                type="button"
                disabled={busy}
                className="h-9 min-w-9 rounded-control border border-border px-2 text-[13.5px] tabular-nums hover:bg-card-2"
                onClick={() => onSend(n)}
                data-testid="call-poll-number"
              >
                {n}
              </button>
            ))}
          </div>
          {poll.minLabel || poll.maxLabel ? (
            <div className="mt-1 flex justify-between text-[11.5px] text-text-3">
              <span>{poll.minLabel}</span>
              <span>{poll.maxLabel}</span>
            </div>
          ) : null}
        </div>
      );
    }
    case 'short_text':
      return (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onSend(text.trim());
          }}
        >
          <input
            value={text}
            maxLength={poll.maxLength}
            onChange={(e) => setText(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-control border border-border bg-card px-3 text-[13.5px]"
            aria-label={poll.title}
            data-testid="call-poll-text"
          />
          <Button type="submit" loading={busy} disabled={!text.trim()} data-testid="call-poll-send">
            {POLL_WORDS.send}
          </Button>
        </form>
      );
    case 'button': {
      const b = poll.button;
      if (!b) return null;
      return (
        <Button
          className="mt-3 w-full"
          loading={busy}
          onClick={() => {
            // A link opens in a new tab, so the call goes on; pressing it is their answer.
            if (b.url && b.action !== 'talk' && /^https?:\/\//.test(b.url))
              window.open(b.url, '_blank', 'noopener');
            onSend(true);
          }}
          data-testid="call-poll-button"
        >
          {b.label}
        </Button>
      );
    }
  }
}
