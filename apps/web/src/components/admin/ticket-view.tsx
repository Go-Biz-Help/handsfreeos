'use client';
import { ArrowLeft, Eye, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { CHANNEL_WORD, PRIORITY_WORD, STATUS_WORD, whenWords, type TicketRow } from './ticket-bits';
import { ViewAsButton } from './view-as';

export interface TicketMessageView {
  readonly id: string;
  readonly author: 'customer' | 'staff' | 'ai' | 'system';
  readonly internal: boolean;
  readonly authorName: string;
  readonly bodyText: string;
  readonly createdAt: string;
}

export interface TicketDraftView {
  readonly bodyText: string;
  readonly sources: readonly { kind: string; title: string; id: string | null }[];
  readonly model: string;
  readonly createdAt: string;
  readonly stale: boolean;
}

export interface TicketViewProps {
  readonly ticket: TicketRow;
  readonly messages: readonly TicketMessageView[];
  readonly events: readonly { id: string; kind: string; actorName: string; createdAt: string }[];
  readonly draft: TicketDraftView | null;
  readonly business: {
    readonly workspaceId: string;
    readonly name: string;
    readonly organizationName: string;
    readonly createdAt: string;
    readonly memberCount: number;
    readonly openTicketCount: number;
  } | null;
  readonly alsoFrom: readonly { id: string; number: number; subject: string; status: string }[];
  readonly staff: readonly { userId: string; fullName: string; displayName: string }[];
  readonly savedReplies: readonly { id: string; title: string; bodyText: string }[];
  /** `founder`: opening their business goes straight in as its owner (20261013002100). */
  readonly can: { assign: boolean; viewAs: boolean; founder: boolean };
  readonly meUserId: string;
}

const KIND_WORD: Record<string, string> = {
  opened: 'Opened',
  customer_replied: 'They wrote again',
  acknowledged: 'We said it arrived',
  status_changed: 'Status changed',
  priority_changed: 'Priority changed',
  assigned: 'Given to someone',
  snoozed: 'Put down for later',
  unsnoozed: 'Picked back up',
  linked_business: 'Linked to a business',
  merged_in: 'Another ticket folded in',
  merged_into: 'Folded into another ticket',
};

export function TicketView(props: TicketViewProps) {
  const { ticket, business } = props;
  const router = useRouter();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    await run('send', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/support.ticket.reply', {
          body: { ticketId: ticket.id, body: text, internal },
        }),
      );
      setBody('');
      setInternal(false);
    });
  };

  // The generated client's types go several thousand paths deep; one cast here keeps the compiler sane.
  const command = (path: string, input: object) =>
    (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(path, {
      body: input,
    }).then(unwrap);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <Link
        href="/admin/tickets"
        className="inline-flex items-center gap-1.5 text-[13px] text-text-3 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} /> All tickets
      </Link>

      <div className="mt-2 flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold md:text-2xl" data-testid="ticket-subject">
            {ticket.subject || '(no subject)'}
          </h1>
          <p className="mt-1 text-[13px] text-text-3">
            #{ticket.number} · {CHANNEL_WORD[ticket.channel]} ·{' '}
            {ticket.requester.name ? `${ticket.requester.name}, ` : ''}
            {ticket.requester.email}
          </p>

          <ol className="mt-5 flex flex-col gap-3">
            {props.messages.map((m) => (
              <li
                key={m.id}
                data-testid={`ticket-message-${m.author}`}
                className={cn(
                  'rounded-card border px-4 py-3',
                  m.internal
                    ? 'border-warning-soft bg-warning-soft'
                    : m.author === 'customer'
                      ? 'border-border bg-card'
                      : 'border-accent-soft bg-accent-soft',
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-semibold">
                    {m.authorName}
                    {m.internal ? ' · internal note' : ''}
                  </span>
                  <span className="flex-none text-xs text-text-3">{whenWords(m.createdAt)}</span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">{m.bodyText}</p>
              </li>
            ))}
          </ol>

          {props.draft ? (
            <div
              className="mt-5 rounded-card border border-dashed border-accent bg-card px-4 py-3"
              data-testid="ticket-draft"
            >
              <div className="flex items-center gap-2 text-[13px] font-semibold text-accent-text">
                <Sparkles className="h-4 w-4" strokeWidth={1.5} />A suggested answer
                {props.draft.stale ? (
                  <span className="font-normal text-text-3">
                    · written before their latest message
                  </span>
                ) : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-2">
                {props.draft.bodyText}
              </p>
              {props.draft.sources.length ? (
                <p className="mt-2 text-xs text-text-3">
                  From: {props.draft.sources.map((s) => s.title).join(' · ')}
                </p>
              ) : (
                <p className="mt-2 text-xs text-text-3">
                  It had nothing solid to go on, so read this as questions to ask rather than an
                  answer.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setBody(props.draft!.bodyText)}
                  data-testid="draft-use"
                >
                  Put it in the box
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy === 'dismiss'}
                  onClick={() =>
                    run('dismiss', () =>
                      command('/v1/commands/support.ticket.dismiss_draft', {
                        ticketId: ticket.id,
                      }),
                    )
                  }
                >
                  No thanks
                </Button>
              </div>
            </div>
          ) : null}

          <form onSubmit={send} className="mt-5 rounded-card border border-border bg-card p-4">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder={
                internal
                  ? 'A note for whoever picks this up next. The customer never sees it.'
                  : 'Write back. Plain words, and say what happens next.'
              }
              aria-label={internal ? 'Internal note' : 'Reply'}
              data-testid="reply-box"
            />
            {props.savedReplies.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {props.savedReplies.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setBody((b) => (b ? `${b}\n\n${r.bodyText}` : r.bodyText))}
                    className="h-7 rounded-control border border-border px-2.5 text-xs text-text-2 hover:bg-card-2"
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                disabled={busy === 'send' || !body.trim()}
                data-testid="reply-send"
              >
                {busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {internal ? 'Save the note' : 'Send it'}
              </Button>
              <label className="flex items-center gap-2 text-[13px] text-text-2">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                  data-testid="reply-internal"
                />
                Internal note
              </label>
              <button
                type="button"
                disabled={busy === 'draft'}
                onClick={() =>
                  run('draft', () =>
                    command('/v1/commands/support.ticket.request_draft', { ticketId: ticket.id }),
                  )
                }
                className="ml-auto inline-flex items-center gap-1.5 text-[13px] text-text-3 hover:text-text"
                data-testid="ask-ai"
              >
                <Sparkles className="h-4 w-4" strokeWidth={1.5} />
                Ask the AI for a draft
              </button>
            </div>
            {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
            <p className="mt-2 text-xs text-text-3">
              A reply goes out from support@handsfreeos.com, and their answer comes back to this
              ticket.
            </p>
          </form>
        </div>

        <aside className="w-full flex-none lg:w-72">
          <div className="rounded-card border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">This ticket</h2>
            <dl className="mt-3 flex flex-col gap-2.5 text-[13px]">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-text-3">Status</dt>
                <dd>
                  <select
                    value={ticket.status}
                    aria-label="Status"
                    data-testid="ticket-status"
                    onChange={(e) =>
                      run('status', () =>
                        command('/v1/commands/support.ticket.set_status', {
                          ticketId: ticket.id,
                          status: e.target.value,
                        }),
                      )
                    }
                    className="h-8 rounded-control border border-border bg-card px-2 text-[13px]"
                  >
                    {Object.entries(STATUS_WORD).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-text-3">Priority</dt>
                <dd>
                  <select
                    value={ticket.priority}
                    aria-label="Priority"
                    data-testid="ticket-priority"
                    onChange={(e) =>
                      run('priority', () =>
                        command('/v1/commands/support.ticket.set_priority', {
                          ticketId: ticket.id,
                          priority: e.target.value,
                        }),
                      )
                    }
                    className="h-8 rounded-control border border-border bg-card px-2 text-[13px]"
                  >
                    {Object.entries(PRIORITY_WORD).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-text-3">Who has it</dt>
                <dd>
                  {props.can.assign ? (
                    <select
                      value={ticket.assignee?.userId ?? ''}
                      aria-label="Assigned to"
                      data-testid="ticket-assignee"
                      onChange={(e) =>
                        run('assign', () =>
                          command('/v1/commands/support.ticket.assign', {
                            ticketId: ticket.id,
                            assigneeUserId: e.target.value || null,
                          }),
                        )
                      }
                      className="h-8 rounded-control border border-border bg-card px-2 text-[13px]"
                    >
                      <option value="">Nobody</option>
                      {props.staff.map((s) => (
                        <option key={s.userId} value={s.userId}>
                          {s.displayName || s.fullName}
                          {s.userId === props.meUserId ? ' (me)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span>{ticket.assignee?.name ?? 'Nobody'}</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-text-3">Came in</dt>
                <dd>{whenWords(ticket.createdAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-text-3">First answered</dt>
                <dd>{ticket.firstResponseAt ? whenWords(ticket.firstResponseAt) : 'Not yet'}</dd>
              </div>
            </dl>
          </div>

          <div className="mt-4 rounded-card border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Their business</h2>
            {business ? (
              <>
                <p className="mt-2 text-sm font-medium">{business.name}</p>
                <p className="text-[13px] text-text-3">
                  {business.organizationName ? `${business.organizationName} · ` : ''}
                  {business.memberCount} {business.memberCount === 1 ? 'person' : 'people'} · with
                  us since {new Date(business.createdAt).toLocaleDateString()}
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  <Link
                    href={`/admin/businesses/${business.workspaceId}`}
                    className="inline-flex h-9 items-center justify-center rounded-control border border-border px-3 text-[13px] font-medium hover:bg-card-2"
                  >
                    Open their account page
                  </Link>
                  {props.can.viewAs ? (
                    <ViewAsButton
                      workspaceId={business.workspaceId}
                      businessName={business.name}
                      ticketId={ticket.id}
                      founder={props.can.founder}
                    />
                  ) : null}
                </div>
              </>
            ) : (
              <p className="mt-2 text-[13px] text-text-3">
                We do not know which business this is about yet. Their address is not one of our
                users, or they work in more than one.
                <Eye className="ml-1 inline h-3.5 w-3.5 opacity-0" aria-hidden />
              </p>
            )}
          </div>

          {props.alsoFrom.length ? (
            <div className="mt-4 rounded-card border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">Also from them</h2>
              <ul className="mt-2 flex flex-col gap-1.5">
                {props.alsoFrom.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/admin/tickets/${t.id}`}
                      className="text-[13px] text-text-2 hover:text-text"
                    >
                      #{t.number} {t.subject}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-4 rounded-card border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">What happened</h2>
            <ul className="mt-2 flex flex-col gap-1.5 text-[13px] text-text-3">
              {props.events.map((e) => (
                <li key={e.id}>
                  {KIND_WORD[e.kind] ?? e.kind} · {whenWords(e.createdAt)}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
