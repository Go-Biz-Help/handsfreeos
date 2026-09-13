'use client';
import { addDays, formatDuration, localDateOf, type AssistantCard } from '@hfos/core';
import { CalendarDays } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';
import { cardHead, cardRow, cardShell, RowLink, Tile } from './card-parts';

type CardOf<T extends AssistantCard['type']> = Extract<AssistantCard, { type: T }>;
type SlotsCardData = CardOf<'slots'>;

/** "today", "tomorrow" or "on Thu, Sep 24", in the calendar's zone at the moment of the tap. */
function dayWords(date: string, label: string, timeZone: string): string {
  const today = localDateOf(Date.now(), timeZone);
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  return `on ${label}`;
}

/** What a tapped time asks, in plain words: "Book AC tune-up at 10:00 AM tomorrow with Priya Natarajan". */
export function slotSentence(
  card: SlotsCardData,
  day: SlotsCardData['days'][number],
  time: SlotsCardData['days'][number]['times'][number],
): string {
  const what = card.service?.name ?? card.calendar.name;
  const who = card.person ? ` with ${card.person.fullName}` : '';
  return `Book ${what} at ${time.label} ${dayWords(day.date, day.label, card.timezone)}${who}`;
}

/**
 * "When is Priya free Thursday?": up to three days of open times (design/m5/Assistant.dc.html). Tapping a
 * time asks to book it; the booking still waits for Confirm.
 */
export function SlotsCard({ card }: { card: SlotsCardData }) {
  const a = useAssistant();
  const one = card.days.length === 1 ? card.days[0]! : null;
  const detail = [card.service?.name, formatDuration(card.durationMinutes), card.zone]
    .filter(Boolean)
    .join(' · ');
  const first = card.person?.fullName.split(/\s+/)[0];
  return (
    <div className={cardShell} data-testid="assistant-card-slots">
      <div className={cardHead}>
        {card.person ? (
          <Avatar name={card.person.fullName} seed={card.person.userId} />
        ) : (
          <Tile icon={CalendarDays} tone="accent" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium">
            {one ? `${card.title} · ${one.label}` : card.title}
          </span>
          <span className="truncate text-xs text-text-3">{detail}</span>
        </span>
      </div>
      {card.days.length === 0 ? (
        <div className={cn(cardRow, 'text-text-3')}>No open times then.</div>
      ) : null}
      {card.days.map((day) => (
        <div
          key={day.date}
          role="group"
          aria-label={`Open times ${day.label}`}
          className="flex flex-col gap-1.5 px-3.5 pb-3"
        >
          {one ? null : <span className="text-xs font-medium text-text-2">{day.label}</span>}
          <div className="grid grid-cols-4 gap-1.5">
            {day.times.map((t) => (
              <button
                key={t.startsAt}
                type="button"
                disabled={a.running}
                onClick={() => a.ask(slotSentence(card, day, t))}
                className="inline-flex h-[34px] items-center justify-center whitespace-nowrap rounded-control border border-border-strong bg-card px-1.5 text-[13px] font-medium text-text transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 max-md:h-11 max-md:text-[14.5px]"
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {card.days.length ? (
        <div className={cn(cardRow, 'text-text-3')}>Tap a time, then say who it’s for.</div>
      ) : null}
      <RowLink href={card.href}>
        <span className="min-w-0 flex-1 truncate font-medium text-accent-text">
          {first ? `Open ${first}’s week` : 'Open the calendar'}
        </span>
      </RowLink>
    </div>
  );
}

const STATUS: Record<CardOf<'appointment'>['status'], { label: string; className: string }> = {
  scheduled: { label: 'Scheduled', className: 'bg-accent-soft text-accent-text' },
  completed: { label: 'Done', className: 'bg-success-soft text-success-text' },
  cancelled: { label: 'Cancelled', className: 'bg-danger-soft text-danger-text' },
  no_show: { label: 'No-show', className: 'bg-warning-soft text-warning-text' },
};

/** One appointment: what, when, who it's for and who works it, with where it stands. */
export function AppointmentCard({ card }: { card: CardOf<'appointment'> }) {
  const status = STATUS[card.status];
  return (
    <div className={cardShell} data-testid="assistant-card-appointment">
      <div className={cardHead}>
        <Tile icon={CalendarDays} tone="accent" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium">{card.what}</span>
          <span className="truncate text-xs text-text-3">{card.when}</span>
        </span>
        <span
          className={cn(
            'inline-flex h-[22px] flex-none items-center rounded-full px-2 text-xs font-medium',
            status.className,
          )}
        >
          {status.label}
        </span>
      </div>
      {card.customer || card.with ? (
        <div className={cardRow}>
          <span className="min-w-0 flex-1 truncate">{card.customer ?? 'No customer yet'}</span>
          {card.with ? (
            <span className="max-w-[50%] flex-none truncate text-xs text-text-3">
              with {card.with}
            </span>
          ) : null}
        </div>
      ) : null}
      <RowLink href={card.href}>
        <span className="min-w-0 flex-1 truncate font-medium text-accent-text">
          Open in the calendar
        </span>
      </RowLink>
    </div>
  );
}
