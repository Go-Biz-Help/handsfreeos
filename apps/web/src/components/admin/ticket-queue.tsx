'use client';
import {
  DESK_WORDS,
  TICKET_QUEUE_FILTERS,
  sinceIso,
  ticketQueueCount,
  ticketQueueSummary,
  type TicketQueueFilter,
} from '@hfos/core';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { STATUS_WORD, type TicketRow } from './ticket-bits';

export type QueueFilter = TicketQueueFilter;

export function TicketQueue({
  tickets,
  filter,
  search,
  nextCursor,
  counts,
}: {
  tickets: readonly TicketRow[];
  filter: QueueFilter;
  search: string;
  nextCursor: string | null;
  counts: {
    unanswered: number;
    mine: number;
    unassigned: number;
    waitingOnCustomer: number;
    solvedToday: number;
    oldestWaitingMinutes: number | null;
  };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = useState(search);

  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') q.delete(k);
      else q.set(k, v);
    }
    q.delete('cursor');
    router.push(`/admin/tickets${q.size ? `?${q}` : ''}`);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go({ q: term.trim() || null });
  };
  const countFor = (key: QueueFilter) => ticketQueueCount(key, counts);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">Tickets</h1>
        <p className="text-[13px] text-text-3" data-testid="queue-summary">
          {ticketQueueSummary(counts)}
        </p>
      </div>

      <form onSubmit={submit} className="mt-4 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-text-3"
            strokeWidth={1.5}
          />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={DESK_WORDS.searchTickets}
            aria-label="Search tickets"
            data-testid="ticket-search"
            className="pl-10"
          />
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {TICKET_QUEUE_FILTERS.map((f) => {
          const on = f.key === filter;
          const n = countFor(f.key);
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => go({ show: f.key === 'unanswered' ? null : f.key })}
              data-testid={`queue-filter-${f.key}`}
              className={cn(
                'h-8 rounded-control px-3 text-[13px] font-medium',
                on ? 'bg-accent-soft text-accent-text' : 'text-text-2 hover:bg-card-2',
              )}
            >
              {f.label}
              {n !== null && n > 0 ? <span className="ml-1.5 text-text-3">{n}</span> : null}
            </button>
          );
        })}
      </div>

      {tickets.length === 0 ? (
        <div className="mt-8 rounded-card border border-border bg-card px-5 py-12 text-center">
          <p className="text-sm font-medium">{DESK_WORDS.queueEmptyTitle}</p>
          <p className="mt-1 text-[13px] text-text-3">
            {filter === 'unanswered'
              ? DESK_WORDS.queueEmptyUnanswered
              : DESK_WORDS.queueEmptyFiltered}
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {tickets.map((t) => (
            <li key={t.id}>
              <Link
                href={`/admin/tickets/${t.id}`}
                data-testid={`ticket-row-${t.number}`}
                className="flex flex-col gap-1 px-4 py-3.5 hover:bg-card-2"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-xs tabular-nums text-text-3">#{t.number}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {t.subject || DESK_WORDS.noSubject}
                  </span>
                  <span className="flex-none text-xs text-text-3">{sinceIso(t.updatedAt)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-3">
                  <span className="truncate">{t.requester.name || t.requester.email}</span>
                  {t.business ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{t.business.name}</span>
                    </>
                  ) : null}
                  <span aria-hidden>·</span>
                  <span>{STATUS_WORD[t.status]}</span>
                  {t.priority === 'urgent' || t.priority === 'high' ? (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger-text">
                      {t.priority === 'urgent' ? 'Urgent' : 'High'}
                    </span>
                  ) : null}
                  {t.assignee ? (
                    <span className="ml-auto truncate">{t.assignee.name}</span>
                  ) : (
                    <span className="ml-auto text-accent-text">{DESK_WORDS.nobodyYet}</span>
                  )}
                </div>
                <p className="truncate text-[13px] text-text-2">{t.preview}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => {
              const q = new URLSearchParams(params.toString());
              q.set('cursor', nextCursor);
              router.push(`/admin/tickets?${q}`);
            }}
            className="h-10 rounded-control border border-border px-4 text-sm font-medium hover:bg-card-2"
          >
            {DESK_WORDS.olderTickets}
          </button>
        </div>
      ) : null}
    </div>
  );
}
