'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * The hero's picture of the product: a new lead texting after hours, the AI teammate answering and booking it,
 * and the one thing that waits for a person.
 *
 * It plays once when the page opens, because the product is something that happens while you are not looking,
 * and a still picture cannot show that. Every line holds its place from the first frame, so the page never
 * moves around it. The OK card is real enough to press: "Send it" is the whole argument in one tap — it asks
 * first, and you stay in charge.
 *
 * It is a drawing, not a screenshot, and the caption says so. Replace it with a real screenshot of the Inbox
 * once there is a demo business worth photographing.
 */

/** When each line arrives, in milliseconds from the page opening. */
const at = {
  first: 350,
  typing: 950,
  typingFor: 1250,
  reply: 2150,
  second: 3150,
  booked: 3950,
  ask: 4800,
} as const;

type Step = 'asking' | 'editing' | 'sent';

export function ProductMock() {
  const [run, setRun] = useState(0);
  const [step, setStep] = useState<Step>('asking');
  const figure = useRef<HTMLElement>(null);
  const replay = useRef<HTMLButtonElement>(null);

  // Once sent there is nothing left in the card to press, so the keyboard goes on to "Play it again"; the
  // live region below says what happened.
  useEffect(() => {
    if (step === 'sent') replay.current?.focus();
  }, [step]);

  // It plays to somebody or not at all: a tab opened in the background, or a phone where the picture sits
  // below the buttons, holds the conversation until it is actually looked at.
  useEffect(() => {
    const el = figure.current;
    if (!el) return;
    let inView = true;
    const sync = () => {
      if (document.visibilityState === 'hidden' || !inView) el.dataset.paused = '';
      else delete el.dataset.paused;
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = (entry?.intersectionRatio ?? 1) >= 0.35;
        sync();
      },
      { threshold: [0, 0.35] },
    );
    observer.observe(el);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return (
    <figure ref={figure} className="m-0">
      <Conversation key={run} step={step} onStep={setStep} />
      <figcaption className="text-text-3 mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
        <span>An illustration of a HandsFreeOS inbox. Names and messages are made up.</span>
        <button
          ref={replay}
          type="button"
          onClick={() => {
            setStep('asking');
            setRun((n) => n + 1);
          }}
          className="text-text-2 hover:text-text -mx-2 inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 font-medium transition-[color,transform] duration-[150ms,160ms] ease-[ease,var(--curve-out)] motion-safe:active:scale-[0.97]"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3" />
          </svg>
          Play it again
        </button>
      </figcaption>
      <p className="sr-only" aria-live="polite">
        {step === 'sent' ? 'Sent. Marisol has the quote.' : ''}
      </p>
    </figure>
  );
}

function Conversation({ step, onStep }: { step: Step; onStep: (step: Step) => void }) {
  return (
    <div>
      <div className="bg-card border-border relative rounded-[20px] border shadow-[var(--shadow-3)]">
        <div className="border-border flex items-center gap-3 border-b px-4 py-3.5 sm:px-5">
          <span className="bg-accent-soft-2 text-accent-text flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold">
            MR
          </span>
          <div className="min-w-0">
            <p className="truncate text-[0.9375rem] font-semibold">Marisol R.</p>
            <p className="text-text-3 truncate text-xs">New lead · texted your business number</p>
          </div>
          <span className="text-text-3 ml-auto text-xs whitespace-nowrap tabular-nums">
            7:42 PM
          </span>
        </div>

        {/* The OK card overlaps the foot of the thread on wider screens; the extra space there keeps it off the booking. */}
        <div className="space-y-3.5 px-4 py-5 sm:px-5 sm:pb-14">
          <Bubble side="in" at={at.first}>
            Hi — my AC is blowing warm air. Can anyone come out today?
          </Bubble>

          {/* The dots and the reply share a place, so the reply lands where the dots were. */}
          <div className="grid [grid-template-areas:'reply'] *:[grid-area:reply]">
            <Typing />
            <div className="seq flex flex-col items-end" style={when(at.reply)}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-text-3 text-xs">replied in 9 seconds</span>
                <span className="bg-accent rounded-full px-2 py-0.5 text-xs font-semibold text-white">
                  Ava · AI teammate
                </span>
              </div>
              <Bubble side="out">
                Sorry about that, Marisol — warm air in this heat is no fun. I can get a tech to you
                tomorrow between 8 and 10 AM, or today between 5 and 7 PM. Which suits you?
              </Bubble>
            </div>
          </div>

          <Bubble side="in" at={at.second}>
            Tomorrow 8–10 please
          </Bubble>

          <div
            className="seq border-success-text/20 bg-success-soft text-success-text flex items-center gap-2.5 rounded-[12px] border px-3 py-2.5 text-sm"
            style={when(at.booked)}
          >
            <svg
              viewBox="0 0 20 20"
              aria-hidden="true"
              className="draw-tick h-4 w-4 shrink-0"
              style={when(at.booked + 260)}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m4 10.5 4 4 8-9" />
            </svg>
            <span>
              <strong className="font-semibold">Booked</strong> · Tue 8:00–10:00 AM · Dale ·
              Diagnostic visit · reminder texts set
            </span>
          </div>
        </div>
      </div>

      <AskCard step={step} onStep={onStep} />
    </div>
  );
}

/**
 * The one thing that waits for a person. Its three states share one place, so the card never changes size
 * as you press through it; the change between them is a short crossfade, softened with a little blur so it
 * reads as one card changing rather than two swapping.
 */
function AskCard({ step, onStep }: { step: Step; onStep: (step: Step) => void }) {
  // It cannot be pressed before it has arrived: a keyboard would otherwise land on buttons nobody can see.
  const [arrived, setArrived] = useState(false);
  const pressed = useRef(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const draftSendRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const fallback = window.setTimeout(() => setArrived(true), at.ask + 1500);
    return () => window.clearTimeout(fallback);
  }, []);

  // Keep the keyboard where the card went, but only once somebody has pressed something.
  useEffect(() => {
    if (!pressed.current) return;
    if (step === 'sent') return;
    (step === 'asking' ? editRef : draftSendRef).current?.focus();
  }, [step]);

  const go = (next: Step) => {
    pressed.current = true;
    onStep(next);
  };

  return (
    <div
      className="seq relative mt-4 ml-auto w-[min(21.5rem,100%)] origin-top sm:-mt-9 sm:-mr-6"
      style={when(at.ask)}
      onAnimationStart={(event) => {
        if (event.target === event.currentTarget) setArrived(true);
      }}
      inert={!arrived}
    >
      <div
        className={`bg-card rounded-[16px] border p-4 shadow-[var(--shadow-3)] transition-colors duration-300 ${
          step === 'sent' ? 'border-success-text/30' : 'border-border-strong'
        }`}
      >
        <div className="grid [grid-template-areas:'state'] *:[grid-area:state]">
          <State shown={step === 'asking'}>
            <Label>Waiting for your OK</Label>
            <p className="text-sm">
              Ava wants to send Marisol a <strong className="font-semibold">$189</strong> diagnostic
              quote. It hasn&rsquo;t sent a price on its own yet.
            </p>
            <div className="mt-3.5 flex gap-2">
              <CardButton primary onClick={() => go('sent')}>
                Send it
              </CardButton>
              <CardButton ref={editRef} onClick={() => go('editing')}>
                Edit
              </CardButton>
            </div>
          </State>

          <State shown={step === 'editing'}>
            <Label>Ava&rsquo;s draft</Label>
            <p className="border-accent border-l-2 pl-3 text-sm">
              Your quote for tomorrow&rsquo;s visit: $189. Look it over and accept it here.
            </p>
            <div className="mt-3.5 flex gap-2">
              <CardButton ref={draftSendRef} primary onClick={() => go('sent')}>
                Send it
              </CardButton>
              <CardButton onClick={() => go('asking')}>Back</CardButton>
            </div>
          </State>

          <State shown={step === 'sent'}>
            <Label tone="success">Sent · you approved it</Label>
            <p className="text-sm">
              Marisol has the quote. Once she accepts it, it becomes the invoice.
            </p>
            <p className="text-success-text mt-3.5 flex items-center gap-1.5 text-sm font-semibold">
              {/* Mounted only once sent, so the tick draws as the card turns, not unseen beforehand. */}
              {step === 'sent' ? (
                <svg
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                  className="draw-tick h-4 w-4"
                  style={when(120)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m4 10.5 4 4 8-9" />
                </svg>
              ) : (
                <span className="h-4 w-4" />
              )}
              7:44 PM · one tap from you
            </p>
          </State>
        </div>
      </div>
    </div>
  );
}

/**
 * Visible the instant it is shown (so the keyboard can land on it straight away), and hidden only once it has
 * faded out. Leaving is quicker than arriving.
 */
function State({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div
      inert={!shown}
      className={`ease-out ${
        shown
          ? 'visible opacity-100 transition-[opacity,filter,transform] duration-[240ms]'
          : 'invisible opacity-0 transition-[opacity,filter,transform,visibility] duration-[150ms] motion-safe:scale-[0.98] motion-safe:blur-[2px]'
      }`}
    >
      {children}
    </div>
  );
}

function Label({ children, tone }: { children: ReactNode; tone?: 'success' }) {
  return (
    <p
      className={`mb-2 text-xs font-semibold ${tone === 'success' ? 'text-success-text' : 'text-text-3'}`}
    >
      {children}
    </p>
  );
}

function CardButton({
  primary = false,
  ref,
  onClick,
  children,
}: {
  primary?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={`rounded-[8px] px-3 py-1.5 text-sm font-semibold transition-[transform,background-color] duration-[160ms,150ms] ease-[var(--curve-out),ease] motion-safe:active:scale-[0.97] ${
        primary
          ? 'bg-accent hover:bg-accent-hover text-white'
          : 'border-border-strong hover:bg-card-2 border'
      }`}
    >
      {children}
    </button>
  );
}

/** The three dots, there only between the question and the answer. */
function Typing() {
  return (
    <div
      aria-hidden="true"
      className="seq-typing bg-accent-soft mt-[1.625rem] flex h-9 w-14 items-center justify-center gap-1 self-start justify-self-end rounded-[18px] rounded-br-[6px] motion-reduce:hidden"
      style={{ ...when(at.typing), '--for': `${at.typingFor}ms` } as CSSProperties}
    >
      {[0, 1, 2].map((n) => (
        <span
          key={n}
          className="typing-dot bg-accent h-1.5 w-1.5 rounded-full"
          style={{ '--n': n } as CSSProperties}
        />
      ))}
    </div>
  );
}

function Bubble({
  side,
  at: arrives,
  children,
}: {
  side: 'in' | 'out';
  at?: number;
  children: ReactNode;
}) {
  const isIn = side === 'in';
  return (
    <div className={isIn ? 'flex' : 'flex justify-end'}>
      <p
        // A bubble grows out of its own corner, the way a message comes from one side.
        className={[
          'max-w-[85%] rounded-[18px] px-3.5 py-2.5 text-[0.9375rem] leading-snug',
          arrives === undefined ? '' : 'seq',
          isIn
            ? 'bg-card-2 text-text origin-bottom-left rounded-bl-[6px]'
            : 'bg-accent origin-bottom-right rounded-br-[6px] text-white',
        ].join(' ')}
        style={arrives === undefined ? undefined : when(arrives)}
      >
        {children}
      </p>
    </div>
  );
}

const when = (ms: number) => ({ '--at': `${ms}ms` }) as CSSProperties;
