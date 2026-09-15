'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  AlertCircle,
  BookOpen,
  CalendarCheck,
  Hand,
  Hourglass,
  Info,
  MessageSquare,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { CustomerPicker, type PickedCustomer } from '@/components/calendar/customer-picker';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { CHANNEL_NAMES, checkViews, firstName, plural, toolName } from '@/lib/ai-team/describe';
import {
  streamTest,
  testConsoleMissing,
  type TestEvent,
  type TestMessage,
} from '@/lib/ai-team/test-stream';
import type { RunOutcome, TeammateChannelKey } from '@/lib/ai-team/types';
import { errorMessage } from '@/lib/api/client';
import { toLocalInputValue } from '@/lib/format';
import { cn } from '@/lib/utils';
import { clockSeconds } from '@/lib/workflows/run-words';
import { LogRow, type LogLine, type LogTone } from './log';
import { AiTile, TeammateMark } from './mark';

const SAMPLES = [
  'How much does a visit cost?',
  'Can I book for Thursday morning?',
  'Are you a real person?',
  'I want to talk to someone',
];

/** One message from the manager and how the teammate handled it. */
interface Turn {
  readonly id: string;
  readonly customer: string;
  /** The reply as it streams in. */
  readonly reply: string;
  readonly done: boolean;
  readonly outcome: RunOutcome | null;
  /** Training wheels would hold it for an OK. */
  readonly draft: boolean;
  /** "Would have: booked Thu 10 AM (simulated)". */
  readonly would: readonly string[];
  readonly log: readonly LogLine[];
  readonly toolSteps: number;
  readonly ms: number | null;
  readonly error: string | null;
}

const TOOL_ICONS: Readonly<Record<string, LucideIcon>> = {
  search_knowledge: BookOpen,
  find_times: CalendarCheck,
  my_appointments: CalendarCheck,
};
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];

function lineAt(
  at: string,
  timeZone: string,
  tone: LogTone,
  icon: LucideIcon,
  title: string,
  extra: Partial<LogLine> = {},
): LogLine {
  return { id: crypto.randomUUID(), time: clockSeconds(at, timeZone), tone, icon, title, ...extra };
}

/** A turn after one more event from the worker. */
function step(t: Turn, e: TestEvent, timeZone: string): Turn {
  const now = new Date().toISOString();
  switch (e.type) {
    case 'started':
      return t;
    case 'delta':
      return { ...t, reply: t.reply + e.text };
    case 'context':
      return {
        ...t,
        log: [...t.log, lineAt(e.at, timeZone, 'run', UserRound, e.title, { detail: e.detail })],
      };
    case 'note':
      return {
        ...t,
        log: [...t.log, lineAt(e.at, timeZone, 'ai', Sparkles, e.title, { detail: e.detail })],
      };
    case 'knowledge':
      return {
        ...t,
        log: [
          ...t.log,
          lineAt(
            e.at,
            timeZone,
            'ai',
            BookOpen,
            e.query ? `Searched Knowledge for “${e.query}”` : 'Searched Knowledge',
            {
              knowledge: e.items.map((i) => ({ id: i.id || null, title: i.title })),
              detail: e.items.length ? null : 'Nothing matched.',
            },
          ),
        ],
      };
    case 'tool':
      return {
        ...t,
        log: [
          ...t.log,
          lineAt(e.at, timeZone, 'run', TOOL_ICONS[e.name] ?? Wrench, e.title || toolName(e.name), {
            detail: e.detail,
          }),
        ],
      };
    case 'would':
      return {
        ...t,
        would: [...t.would, `Would have: ${e.summary} (simulated)`],
        log: [
          ...t.log,
          lineAt(e.at, timeZone, 'run', CalendarCheck, `Would have: ${e.summary}`, {
            detail: 'Simulated, so nothing changed.',
          }),
        ],
      };
    case 'check':
      return {
        ...t,
        log: [
          ...t.log,
          lineAt(
            e.at,
            timeZone,
            e.ok ? 'ok' : 'bad',
            ShieldCheck,
            e.ok
              ? e.rewritten
                ? 'Safety check passed after one rewrite'
                : 'Safety check passed'
              : 'Safety check failed',
            { checks: checkViews(e.passed, e.problems) },
          ),
        ],
      };
    case 'done': {
      const end: LogLine[] = [];
      if (e.outcome === 'handed_off')
        end.push(
          lineAt(now, timeZone, 'held', Hand, 'Handed to a person', {
            detail: 'In a real conversation it goes to Needs a person, with a note.',
          }),
        );
      else if (e.outcome === 'no_reply')
        end.push(lineAt(now, timeZone, 'wait', Info, 'Decided not to reply'));
      else if (e.draft)
        end.push(
          lineAt(now, timeZone, 'held', Hourglass, 'Draft (training wheels)', {
            detail:
              'In a real conversation this waits in the inbox and on Approvals, with any booking held until someone approves it.',
          }),
        );
      else
        end.push(
          lineAt(now, timeZone, 'ok', Send, 'Would send it now', {
            detail: 'It works on its own, so a real reply goes out straight away.',
          }),
        );
      return {
        ...t,
        done: true,
        outcome: e.outcome,
        draft: e.draft,
        reply: e.reply ?? t.reply,
        toolSteps: e.toolSteps,
        ms: e.ms,
        log: [...t.log, ...end],
      };
    }
    case 'error':
      return {
        ...t,
        done: true,
        error: e.message,
        log: [
          ...t.log,
          lineAt(now, timeZone, 'bad', AlertCircle, 'The test stopped', { detail: e.message }),
        ],
      };
  }
}

/**
 * The test console: a manager writes as a customer (someone in Customers, or an unknown visitor) by text,
 * chat or email, at now or a time they pick, and sees the reply stream in, then what the teammate looked
 * up, the knowledge it used, the checks the reply passed, and anything it would have done. Look-ups are
 * real, changes are simulated, and nothing is sent. Full screen on phones.
 */
export function TestConsole({
  open,
  onOpenChange,
  workspaceId,
  name,
  timeZone,
  config,
  unsaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  name: string;
  timeZone: string;
  /** The settings to test: the builder's draft. */
  config: unknown;
  /** The draft has changes that aren't saved yet. */
  unsaved: boolean;
}) {
  const [person, setPerson] = useState<PickedCustomer | null>(null);
  const [channel, setChannel] = useState<TeammateChannelKey>('sms');
  const [at, setAt] = useState('');
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [pane, setPane] = useState<'chat' | 'log'>('chat');
  const abort = useRef<AbortController | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const who = person ? firstName(person.fullName) : channel === 'chat' ? 'a visitor' : 'a customer';

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    for (const el of [chatRef.current, logRef.current]) if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const update = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((xs) => xs.map((x) => (x.id === id ? fn(x) : x)));

  function stop() {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
  }

  function startOver() {
    stop();
    setTurns([]);
  }

  async function send(raw: string) {
    const message = raw.trim();
    if (!message || busy) return;
    const id = crypto.randomUUID();
    const history: TestMessage[] = turns.flatMap((t) => [
      { from: 'customer' as const, text: t.customer },
      ...(t.reply.trim() ? [{ from: 'teammate' as const, text: t.reply }] : []),
    ]);
    const nowIso = new Date().toISOString();
    const verb =
      channel === 'sms' ? 'texted' : channel === 'email' ? 'emailed' : 'wrote in the chat';
    const turn: Turn = {
      id,
      customer: message,
      reply: '',
      done: false,
      outcome: null,
      draft: false,
      would: [],
      log: [
        lineAt(
          nowIso,
          timeZone,
          'ok',
          MessageSquare,
          `${person ? firstName(person.fullName) : 'They'} ${verb}`,
          {
            quote: message,
          },
        ),
      ],
      toolSteps: 0,
      ms: null,
      error: null,
    };
    setTurns((xs) => [...xs, turn]);
    setText('');
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await streamTest(
        {
          workspaceId,
          personId: person?.id ?? null,
          channel,
          at: at ? new Date(at).toISOString() : null,
          config,
          messages: [...history, { from: 'customer' as const, text: message }].slice(-40),
        },
        (e) => update(id, (t) => step(t, e, timeZone)),
        ctrl.signal,
      );
      update(id, (t) => (t.done ? t : { ...t, done: true }));
    } catch (e) {
      if (testConsoleMissing(e)) {
        setMissing(true);
        setTurns((xs) => xs.filter((x) => x.id !== id));
      } else update(id, (t) => ({ ...t, done: true, error: errorMessage(e) }));
    } finally {
      if (abort.current === ctrl) {
        abort.current = null;
        setBusy(false);
      }
    }
  }

  const meta = (t: Turn) =>
    t.done
      ? [
          plural(t.toolSteps, 'look-up', 'look-ups'),
          t.ms !== null ? `${(t.ms / 1000).toFixed(1)} s` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Working on it…';

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) stop();
        onOpenChange(o);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 hidden bg-[var(--scrim)] lg:block" />
        <DialogPrimitive.Content
          data-testid="test-console"
          className="fixed inset-0 z-50 flex flex-col bg-card focus:outline-none lg:left-auto lg:w-[960px] lg:max-w-[calc(100vw-48px)] lg:border-l lg:border-border lg:shadow-3"
        >
          <div className="flex flex-none items-start gap-3 border-b border-border px-4 pb-3.5 pt-4 lg:px-[22px] lg:pt-5">
            <AiTile />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
                Test console
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-[13px] text-text-2">
                Chat with {name} as a customer. Look-ups are real. Bookings and changes are pretend,
                and nothing is sent.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-control text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring lg:h-8 lg:w-8"
            >
              <X className="h-[18px] w-[18px]" />
            </DialogPrimitive.Close>
          </div>

          <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 lg:px-[22px]">
            <div className="flex items-center gap-2">
              <label htmlFor="test-as" className="text-[13px] font-semibold">
                Test as
              </label>
              <div className="w-[230px]">
                <CustomerPicker
                  id="test-as"
                  workspaceId={workspaceId}
                  value={person}
                  onChange={(p) => {
                    setPerson(p);
                    startOver();
                  }}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">By</span>
              <Segmented
                value={channel}
                ariaLabel="Channel"
                onChange={(c) => {
                  setChannel(c);
                  startOver();
                }}
                options={[
                  { value: 'sms', label: 'Text', testId: 'test-channel-sms' },
                  { value: 'chat', label: 'Website chat', testId: 'test-channel-chat' },
                  { value: 'email', label: 'Email', testId: 'test-channel-email' },
                ]}
              />
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="test-at" className="text-[13px] font-semibold">
                At
              </label>
              <Select
                id="test-at"
                selectSize="sm"
                className="w-[130px]"
                value={at ? 'pick' : 'now'}
                onChange={(e) =>
                  setAt(e.target.value === 'now' ? '' : toLocalInputValue(new Date()))
                }
              >
                <option value="now">Now</option>
                <option value="pick">Pick a time</option>
              </Select>
              {at ? (
                <Input
                  type="datetime-local"
                  inputSize="sm"
                  className="w-[200px]"
                  aria-label="Pretend it’s this time"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                />
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={!turns.length && !busy}
              onClick={startOver}
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Start over
            </Button>
          </div>

          {missing ? (
            <div
              className="flex min-h-0 flex-1 items-center justify-center p-6"
              data-testid="test-console-missing"
            >
              <EmptyState
                dashed
                className="max-w-md"
                title="The test console arrives with the teammate’s runtime."
              >
                Set {name} up now. Once its runtime is in, you can chat with it here before any
                customer does.
              </EmptyState>
            </div>
          ) : (
            <>
              <div className="flex-none px-4 pt-3 lg:hidden">
                <Segmented
                  fill
                  size="lg"
                  value={pane}
                  ariaLabel="Show"
                  onChange={setPane}
                  options={[
                    { value: 'chat', label: 'Chat' },
                    { value: 'log', label: `What ${name} did` },
                  ]}
                />
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[410px_minmax(0,1fr)]">
                <div
                  className={cn(
                    'min-h-0 flex-col bg-card-2 lg:flex lg:border-r lg:border-border',
                    pane === 'chat' ? 'flex' : 'hidden',
                  )}
                >
                  <div
                    ref={chatRef}
                    className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3 pt-4"
                    aria-live="polite"
                    data-testid="test-console-chat"
                  >
                    <div className="self-center text-xs font-medium text-text-3">
                      Test chat · by {CHANNEL_NAMES[channel].toLowerCase()}
                    </div>
                    {!turns.length ? (
                      <p className="mt-4 text-center text-[13px] text-text-2">
                        Write as {who} to see how {name} answers.
                      </p>
                    ) : null}
                    {turns.map((t) => (
                      <Fragment key={t.id}>
                        <div className="flex max-w-[86%] flex-col items-end gap-[3px] self-end">
                          <div className="whitespace-pre-wrap rounded-2xl bg-accent px-[13px] py-[9px] text-sm leading-[1.45] text-white [overflow-wrap:anywhere]">
                            {t.customer}
                          </div>
                          <span className="text-xs text-text-3">You, as {who}</span>
                        </div>
                        {t.error && !t.reply ? null : (
                          <div className="flex max-w-[90%] flex-col gap-[5px] self-start">
                            <span className="flex items-center gap-[5px] text-xs text-text-3">
                              <TeammateMark size="xs" />
                              <strong className="font-semibold text-text-2">{name} (AI)</strong>
                            </span>
                            <div
                              className="whitespace-pre-wrap rounded-2xl border border-border bg-card px-[13px] py-[9px] text-sm leading-[1.45] [overflow-wrap:anywhere]"
                              data-testid="test-console-reply"
                            >
                              {t.reply || (
                                <span className="text-text-3">
                                  {t.done ? 'No reply.' : 'Writing…'}
                                </span>
                              )}
                            </div>
                            {t.done ? (
                              <span className="flex flex-wrap gap-1.5">
                                {t.draft ? (
                                  <Tag
                                    className="bg-warning-soft text-warning-text"
                                    icon={Hourglass}
                                  >
                                    Draft (training wheels)
                                  </Tag>
                                ) : null}
                                {t.outcome === 'handed_off' ? (
                                  <Tag className="bg-warning-soft text-warning-text" icon={Hand}>
                                    Handed to a person
                                  </Tag>
                                ) : null}
                                {t.would.map((w, i) => (
                                  <Tag key={i} className="bg-card text-text-2" icon={CalendarCheck}>
                                    {w}
                                  </Tag>
                                ))}
                              </span>
                            ) : null}
                          </div>
                        )}
                        {t.error ? (
                          <p role="alert" className="text-xs text-danger-text">
                            {t.error}
                          </p>
                        ) : null}
                      </Fragment>
                    ))}
                  </div>
                  <div className="flex-none border-t border-border bg-card px-3.5 pb-3.5 pt-2.5">
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-text-3">Try:</span>
                      {SAMPLES.map((s) => (
                        <button
                          key={s}
                          type="button"
                          disabled={busy}
                          onClick={() => void send(s)}
                          className="inline-flex h-7 items-center rounded-full border border-border-strong bg-card px-3 text-[12.5px] font-medium text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send(text);
                      }}
                      className="rounded-xl border border-border-strong bg-card transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring"
                    >
                      <textarea
                        value={text}
                        rows={2}
                        placeholder={`Write as ${who}…`}
                        aria-label={`Write as ${who}`}
                        data-testid="test-console-input"
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void send(text);
                          }
                        }}
                        className="block w-full resize-none bg-transparent px-3 pb-0.5 pt-2.5 text-base leading-[1.45] text-text outline-none placeholder:text-placeholder lg:text-[14.5px]"
                      />
                      <div className="flex items-center justify-end px-1.5 pb-1.5">
                        <Button
                          type="submit"
                          size="sm"
                          loading={busy}
                          disabled={!text.trim()}
                          data-testid="test-console-send"
                        >
                          <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                          Send
                        </Button>
                      </div>
                    </form>
                  </div>
                </div>
                <div
                  ref={logRef}
                  className={cn(
                    'min-h-0 flex-col overflow-y-auto px-4 py-3.5 lg:flex lg:px-5',
                    pane === 'log' ? 'flex' : 'hidden',
                  )}
                  data-testid="test-console-log"
                >
                  <h3 className="text-[15px] font-semibold">What {name} did</h3>
                  {!turns.length ? (
                    <p className="mt-1 text-[13px] text-text-2">
                      Each reply shows what it looked up, the knowledge it used, the checks it
                      passed, and anything it would have done.
                    </p>
                  ) : (
                    turns.map((t, i) => (
                      <section
                        key={t.id}
                        className={cn('mt-2', i > 0 && 'border-t border-border pt-3')}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[13px] font-semibold">
                            {ORDINALS[i] ? `${ORDINALS[i]} reply` : `Reply ${i + 1}`}
                          </span>
                          <span className="text-xs text-text-3">{meta(t)}</span>
                        </div>
                        {t.log.map((l, j) => (
                          <LogRow key={l.id} line={l} first={j === 0} />
                        ))}
                      </section>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          <p className="flex flex-none items-start gap-2 border-t border-border px-4 py-2.5 text-xs text-text-3 lg:px-[22px]">
            <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
            <span>
              Test chats don’t count toward training wheels and never reach a customer.
              {unsaved ? ' It tests your unsaved changes too.' : ''} Pick “Website chat” to test as
              an unknown visitor.
            </span>
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Tag({
  children,
  icon: Icon,
  className,
}: {
  children: string;
  icon: LucideIcon;
  className: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] px-1.5 text-[11.5px] font-medium',
        className,
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={1.75} />
      {children}
    </span>
  );
}
