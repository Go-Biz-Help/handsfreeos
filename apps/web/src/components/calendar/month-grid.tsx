'use client';
import { appointmentCount, type MinuteSpan } from '@hfos/core';
import { CalendarDays } from 'lucide-react';
import type { ReactNode } from 'react';
import { GoogleLogo, MicrosoftLogo } from '@/components/settings/provider-logos';
import type { Appointment } from '@/lib/api/types';
import { fmtDateLong, fmtTime, weekdayShort } from '@/lib/calendar/time';
import { cn } from '@/lib/utils';
import { customersOf, firstName, isPast } from './appt';

/** A busy time or a piece of time off on a month cell: the day it lands on, not where in the day. */
export interface MonthBlock {
  readonly key: string;
  readonly span: MinuteSpan;
  readonly kind: 'busy' | 'time_off';
  readonly title: string;
  readonly provider?: 'google' | 'microsoft' | null;
}

export interface MonthCell {
  readonly date: string;
  readonly today: boolean;
  /** False for the days of the neighbouring months that fill out the first and last weeks. */
  readonly inMonth: boolean;
  readonly events: readonly Appointment[];
  readonly blocks: readonly MonthBlock[];
}

/** Past three, a cell says how many more rather than growing: every row has to stay the same height. */
const SHOWN = 3;

/** And the phone's cell, which is a day number over a row of dots, has room for three of those. */
const DOTS = 3;

/** The day number, the same pill on both sizes. */
const numberClass = (cell: MonthCell) =>
  cn(
    'inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-[12.5px] font-semibold',
    cell.today && 'bg-accent text-white',
    !cell.today && (cell.inMonth ? 'text-text' : 'text-text-3'),
  );

/**
 * One chip per kind, however many blocks a day holds: six separate busy times read from Google are six
 * rows of height on a cell that has to stay the height of every other cell, and "Busy · 6" says as much.
 */
function collapseBlocks(
  blocks: readonly MonthBlock[],
): readonly { readonly block: MonthBlock; readonly count: number }[] {
  const out: { block: MonthBlock; count: number }[] = [];
  for (const block of blocks) {
    const seen = out.find((x) => x.block.kind === block.kind);
    if (seen) seen.count += 1;
    else out.push({ block, count: 1 });
  }
  return out;
}

function BlockMark({ block }: { block: MonthBlock }): ReactNode {
  if (block.kind === 'busy' && block.provider === 'google')
    return <GoogleLogo className="h-2.5 w-2.5 flex-none" />;
  if (block.kind === 'busy' && block.provider === 'microsoft')
    return <MicrosoftLogo className="h-2.5 w-2.5 flex-none" />;
  return <CalendarDays className="h-2.5 w-2.5 flex-none" strokeWidth={1.5} />;
}

function BlockChip({ block, count }: { block: MonthBlock; count: number }) {
  const word = block.kind === 'busy' ? 'Busy' : 'Time off';
  return (
    <span
      className={cn(
        // `.cal-chip`, not `.cal-busy`: that one places itself inside a time-grid column, and a month
        // cell is not one, so it would stretch across whatever it finds instead.
        'flex items-center gap-1 truncate px-1 py-px text-[11px] text-text-3 cal-chip',
        block.kind === 'time_off' && 'cal-chip-off',
      )}
      title={count > 1 ? `${block.title} · ${count} times` : block.title}
      data-testid={block.kind === 'busy' ? 'month-busy' : 'month-time-off'}
    >
      <BlockMark block={block} />
      <span className="truncate">{count > 1 ? `${word} · ${count}` : word}</span>
    </span>
  );
}

/**
 * A month at a glance: six whole weeks, every row the same height. It answers "what is this month like"
 * rather than "when exactly", so nothing here is drawn to scale — a cell lists what is on that day, in
 * order, and hands the day over to the day view when there is more than fits.
 *
 * `compact` is the phone's month, where a cell is fifty-odd pixels wide: the day number and a dot for
 * each booking, and the whole cell hands its day over rather than each row inside it.
 */
export function MonthGrid({
  cells,
  timeZone,
  now,
  selectedId,
  compact,
  onOpen,
  onNew,
  onDay,
}: {
  cells: readonly MonthCell[];
  timeZone: string;
  now: number | null;
  selectedId: string | null;
  compact?: boolean;
  onOpen: (appointment: Appointment) => void;
  onNew: (date: string) => void;
  onDay: (date: string) => void;
}) {
  const heads = cells.slice(0, 7).map((c) => c.date);
  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-auto border-border bg-card',
        compact ? 'border-y' : 'rounded-[14px] border',
      )}
      data-testid={compact ? 'month-compact' : 'month-grid'}
    >
      <div className="grid grid-cols-7 border-b border-border bg-card-2">
        {heads.map((d) => (
          <div
            key={d}
            className="px-2 py-1.5 text-center text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3"
          >
            {weekdayShort(d)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell) => {
          const blocks = collapseBlocks(cell.blocks);
          const shown = cell.events.slice(0, compact ? DOTS : SHOWN);
          const rest = cell.events.length - shown.length;

          // The phone: the whole day is one target, and its dots say how full it is.
          if (compact)
            return (
              <button
                key={cell.date}
                type="button"
                onClick={() => onDay(cell.date)}
                data-testid={`month-day-${cell.date}`}
                data-in-month={cell.inMonth}
                aria-label={[fmtDateLong(cell.date), appointmentCount(cell.events.length)]
                  .filter(Boolean)
                  .join(' · ')}
                className={cn(
                  'flex min-h-[62px] flex-col items-center gap-1 border-b border-r border-border px-0.5 py-1.5 [&:nth-child(7n)]:border-r-0',
                  !cell.inMonth && 'bg-card-2',
                )}
              >
                <span className={numberClass(cell)}>{Number(cell.date.slice(8))}</span>
                <span className="flex h-[7px] items-center gap-[3px]">
                  {blocks.map(({ block }) => (
                    <span
                      key={block.key}
                      className={cn(
                        'h-[5px] w-[5px] flex-none rounded-full',
                        block.kind === 'busy'
                          ? 'bg-border-strong'
                          : 'border border-dashed border-border-strong',
                      )}
                      data-testid={block.kind === 'busy' ? 'month-busy-dot' : 'month-off-dot'}
                    />
                  ))}
                  {shown.map((a) => (
                    <span
                      key={a.id}
                      className={cn(
                        'h-[5px] w-[5px] flex-none rounded-full',
                        isPast(a, now) && 'opacity-50',
                      )}
                      style={{ background: a.calendar.color }}
                      data-testid={`month-dot-${a.id}`}
                    />
                  ))}
                  {rest > 0 ? (
                    <span className="text-[9px] font-semibold leading-none text-text-3">
                      +{rest}
                    </span>
                  ) : null}
                </span>
              </button>
            );

          return (
            <div
              key={cell.date}
              data-testid={`month-cell-${cell.date}`}
              data-in-month={cell.inMonth}
              className={cn(
                'flex min-h-[112px] flex-col gap-1 border-b border-r border-border p-1.5 [&:nth-child(7n)]:border-r-0',
                !cell.inMonth && 'bg-card-2',
              )}
            >
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => onDay(cell.date)}
                  title={`Open ${cell.date}`}
                  className={numberClass(cell)}
                >
                  {Number(cell.date.slice(8))}
                </button>
                {/* Clicking the empty part of a day books on it, as an empty slot does on the time grid. */}
                <button
                  type="button"
                  onClick={() => onNew(cell.date)}
                  aria-label={`New appointment on ${cell.date}`}
                  title="New appointment"
                  className="h-[18px] w-[18px] rounded-[5px] text-[13px] leading-none text-text-3 opacity-0 hover:bg-card-2 focus-visible:opacity-100 group-hover:opacity-100 md:opacity-0 md:hover:opacity-100"
                >
                  +
                </button>
              </div>

              {blocks.map(({ block, count }) => (
                <BlockChip key={block.key} block={block} count={count} />
              ))}

              {shown.map((a) => {
                const who = customersOf(a)[0];
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onOpen(a)}
                    title={`${fmtTime(a.startsAt, timeZone)} · ${a.service?.name ?? 'Appointment'}`}
                    data-testid={`month-appt-${a.id}`}
                    className={cn(
                      'flex items-center gap-1 truncate rounded-[5px] border border-transparent px-1 py-px text-left text-[11.5px]',
                      a.id === selectedId && 'border-accent',
                      isPast(a, now) && 'opacity-60',
                    )}
                    style={{ background: `${a.calendar.color}22` }}
                  >
                    <span
                      className="h-2 w-2 flex-none rounded-[2px]"
                      style={{ background: a.calendar.color }}
                    />
                    <span className="flex-none tabular-nums text-text-2">
                      {fmtTime(a.startsAt, timeZone)}
                    </span>
                    <span className="truncate">
                      {who ? firstName(who.fullName) : (a.service?.name ?? 'Appointment')}
                    </span>
                  </button>
                );
              })}

              {rest > 0 ? (
                <button
                  type="button"
                  onClick={() => onDay(cell.date)}
                  data-testid={`month-more-${cell.date}`}
                  className="truncate px-1 text-left text-[11.5px] font-medium text-text-3 hover:text-text"
                >
                  +{rest} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
