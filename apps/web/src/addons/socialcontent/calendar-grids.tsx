'use client';
/**
 * The Calendar's Week and Month looks (the owner, 15 Nov; the design they OK'd). A week is 7 days from Monday, each a
 * column of its posts and open places; a month is 6 such weeks, each day with its first posts and how many more. A
 * post's edge says where it stands (waiting for an OK, OK'd, posted, didn't post, hidden). While picking, each post,
 * day and week has a tick; a day's number opens its week.
 */
import type { ContentState } from '@hfos/core/addons/socialcontent/calendar';
import { daysFrom, monthOf, weekShownShort } from '@hfos/core/addons/socialcontent/calendar-looks';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import { fmtDateShort, fmtMonthDay, parseLocalDate } from '@hfos/core';
import { cn } from '@/lib/utils';
import { timeIn } from './post-sheet';
import type { CalendarView, Content } from './types';

type Slot = CalendarView['open'][number];

/** Where a post stands, as its edge and fill. */
export function edgeOf(p: Pick<Content, 'state' | 'hidden'>): string {
  if (p.hidden) return 'border-l-border-strong border-dashed opacity-70';
  const by: Record<ContentState, string> = {
    draft: 'border-l-warning bg-warning-soft/60',
    ready: 'border-l-success bg-success-soft/50',
    posting: 'border-l-success bg-success-soft/50',
    posted: 'border-l-success',
    failed: 'border-l-danger bg-danger-soft/60',
    skipped: 'border-l-border-strong opacity-60',
  };
  return by[p.state];
}

/** A post as a dot, on a phone-wide Month. */
function dotOf(p: Pick<Content, 'state' | 'hidden'>): string {
  if (p.hidden) return 'border border-border-strong';
  if (p.state === 'draft') return 'bg-warning';
  if (p.state === 'failed') return 'bg-danger';
  if (p.state === 'skipped') return 'bg-border-strong';
  return 'bg-success';
}

/** The state word under a post, in its color. */
function stateTone(p: Pick<Content, 'state' | 'hidden'>): string {
  if (p.hidden) return 'text-text-3';
  if (p.state === 'draft') return 'text-warning-text';
  if (p.state === 'failed') return 'text-danger-text';
  if (p.state === 'posted' || p.state === 'ready' || p.state === 'posting')
    return 'text-success-text';
  return 'text-text-3';
}

const stateWord = (p: Pick<Content, 'state' | 'hidden'>) =>
  p.hidden ? W.picking.hiddenBadge : W.post.states[p.state];

function Net({ network }: { network: string }) {
  return (
    <span
      className="rounded-[4px] bg-card-2 px-1 text-[10.5px] font-semibold uppercase leading-[16px] text-text-2"
      title={networkName(network as never)}
    >
      {W.picking.short[network] ?? network.slice(0, 2)}
    </span>
  );
}

/** A tick for picking, with words for those who can't see it. */
function Tick({
  checked,
  label,
  onChange,
  testId,
  className,
}: {
  checked: boolean;
  label: string;
  onChange: (on: boolean) => void;
  testId?: string;
  className?: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(e) => onChange(e.currentTarget.checked)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'h-[16px] w-[16px] flex-none cursor-pointer rounded-[4px] border border-border-strong accent-accent',
        className,
      )}
      data-testid={testId}
    />
  );
}

export interface GridProps {
  readonly today: string;
  readonly timeZone: string;
  /** The posts shown on each day, under the filter picked. */
  readonly byDay: ReadonlyMap<string, readonly Content[]>;
  readonly openByDay: ReadonlyMap<string, readonly Slot[]>;
  readonly selecting: boolean;
  readonly isPicked: (id: string) => boolean;
  readonly onPick: (posts: readonly Content[], on: boolean) => void;
  readonly onOpen: (p: Content) => void;
}

/** "2", or while picking "2 of 4" / "All 3". */
function dayCount(
  posts: readonly Content[],
  selecting: boolean,
  isPicked: (id: string) => boolean,
) {
  if (!selecting) return posts.length ? String(posts.length) : '';
  const n = posts.filter((p) => isPicked(p.id)).length;
  return posts.length ? W.picking.dayPicked(n, posts.length) : '';
}

/** A week from Monday: a column for each day. */
export function WeekGrid({
  from,
  onWrite,
  busy,
  ...g
}: GridProps & {
  from: string;
  /** Writes a post for an open place. */
  onWrite: (slot: Slot) => void;
  busy: string | null;
}) {
  const days = daysFrom(from, 7);
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-7" data-testid="socialcontent-week">
      {days.map((day, i) => {
        const posts = g.byDay.get(day) ?? [];
        const free = g.openByDay.get(day) ?? [];
        const isToday = day === g.today;
        const all = posts.length > 0 && posts.every((p) => g.isPicked(p.id));
        return (
          <section
            key={day}
            className="min-w-0 space-y-2"
            data-testid={`socialcontent-week-${day}`}
          >
            <div
              className={cn(
                'flex items-start gap-2 rounded-card border border-border bg-card-2 px-2.5 py-2',
                g.selecting && all && 'border-accent bg-accent-soft',
              )}
            >
              {g.selecting && posts.length ? (
                <Tick
                  checked={all}
                  label={W.picking.pickDay(fmtDateShort(day))}
                  onChange={(on) => g.onPick(posts, on)}
                  className="mt-0.5"
                  testId={`socialcontent-pick-day-${day}`}
                />
              ) : null}
              <div className="min-w-0 flex-1 leading-tight">
                <div
                  className={cn('text-[12px]', isToday ? 'font-medium text-accent' : 'text-text-3')}
                >
                  {isToday ? W.picking.today : W.picking.weekdays[i]}
                </div>
                <div className="text-[14px] font-semibold text-text">
                  {isToday ? `${W.picking.weekdays[i]} ` : ''}
                  {parseLocalDate(day).day}
                </div>
              </div>
              <span
                className={cn(
                  'text-[12px] tabular-nums',
                  g.selecting && all ? 'text-accent' : 'text-text-3',
                )}
              >
                {dayCount(posts, g.selecting, g.isPicked)}
              </span>
            </div>
            {posts.map((p) => {
              const on = g.isPicked(p.id);
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => (g.selecting ? g.onPick([p], !on) : g.onOpen(p))}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    if (g.selecting) g.onPick([p], !on);
                    else g.onOpen(p);
                  }}
                  className={cn(
                    'cursor-pointer rounded-card border border-l-[3px] border-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                    edgeOf(p),
                    g.selecting && on && 'border-accent bg-accent-soft ring-1 ring-accent',
                  )}
                  data-testid={`socialcontent-post-${p.id}`}
                >
                  <div className="flex items-center gap-1.5 text-[12px] text-text-3">
                    {g.selecting ? (
                      <Tick
                        checked={on}
                        label={W.picking.pickPost(p.title)}
                        onChange={(v) => g.onPick([p], v)}
                        testId={`socialcontent-post-${p.id}-pick`}
                      />
                    ) : null}
                    <Net network={p.network} />
                    {p.postAt ? <span>{timeIn(p.postAt, g.timeZone)}</span> : null}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[13px] font-medium text-text">
                    {p.title}
                  </div>
                  <div className={cn('mt-0.5 text-[12px]', stateTone(p))}>{stateWord(p)}</div>
                </div>
              );
            })}
            {free.map((o) => (
              <div
                key={`${o.network}:${o.at}`}
                className="rounded-card border border-dashed border-border-strong px-2.5 py-2"
                data-testid={`socialcontent-open-${o.network}-${o.date}`}
              >
                <div className="flex items-center gap-1.5 text-[12px] text-text-3">
                  <Net network={o.network} />
                  <span>{timeIn(o.at, g.timeZone)}</span>
                </div>
                <div className="mt-1 text-[12.5px] text-text-3">
                  {g.selecting ? W.picking.openNoPick : W.calendar.open}
                </div>
                {g.selecting ? null : (
                  <button
                    type="button"
                    className="mt-1 text-[12.5px] font-medium text-accent hover:underline disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => onWrite(o)}
                  >
                    {busy === `open:${o.network}:${o.at}`
                      ? W.calendar.writing
                      : W.calendar.writeFor}
                  </button>
                )}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** How many posts a Month day shows before "+2 more". */
const MONTH_SHOWN = 3;

/** A month: 6 weeks from the Monday on or before its first. */
export function MonthGrid({
  from,
  month,
  onOpenWeek,
  ...g
}: GridProps & {
  from: string;
  /** The month's first day. */
  month: string;
  onOpenWeek: (day: string) => void;
}) {
  const weeks = Array.from({ length: 6 }, (_, w) => daysFrom(daysFrom(from, 42)[w * 7]!, 7));
  const inMonth = (day: string) => monthOf(day) === month;
  const cols = g.selecting ? 'grid-cols-[28px_repeat(7,minmax(0,1fr))]' : 'grid-cols-7';
  return (
    <div data-testid="socialcontent-month">
      <div className="space-y-1.5">
        <div className={cn('grid gap-1 sm:gap-1.5', cols)}>
          {g.selecting ? <span /> : null}
          {W.picking.weekdays.map((d, i) => (
            <span
              key={d}
              className="px-1 text-center text-[11.5px] font-medium uppercase tracking-wide text-text-3 sm:text-left"
            >
              <span className="hidden sm:inline">{d}</span>
              <span className="sm:hidden" aria-hidden>
                {W.picking.weekdaysShort[i]}
              </span>
            </span>
          ))}
        </div>
        {weeks.map((week) => {
          const weekPosts = week.flatMap((d) => g.byDay.get(d) ?? []);
          const weekAll = weekPosts.length > 0 && weekPosts.every((p) => g.isPicked(p.id));
          return (
            <div key={week[0]} className={cn('grid gap-1 sm:gap-1.5', cols)}>
              {g.selecting ? (
                <div className="flex items-center justify-center">
                  {weekPosts.length ? (
                    <Tick
                      checked={weekAll}
                      label={W.picking.pickWeekOf(weekShownShort(week[0]!))}
                      onChange={(on) => g.onPick(weekPosts, on)}
                      testId={`socialcontent-pick-week-${week[0]}`}
                    />
                  ) : null}
                </div>
              ) : null}
              {week.map((day) => {
                const posts = g.byDay.get(day) ?? [];
                const free = g.openByDay.get(day) ?? [];
                const all = posts.length > 0 && posts.every((p) => g.isPicked(p.id));
                const isToday = day === g.today;
                const n = parseLocalDate(day).day;
                return (
                  <div
                    key={day}
                    className={cn(
                      'flex min-h-[64px] min-w-0 flex-col gap-1 rounded-card border border-border p-1 sm:min-h-[104px] sm:p-1.5',
                      inMonth(day) ? 'bg-card' : 'bg-card-2',
                      g.selecting && all && 'border-accent bg-accent-soft',
                    )}
                    data-testid={`socialcontent-month-${day}`}
                  >
                    <div className="flex flex-wrap items-center gap-1 sm:gap-1.5">
                      {g.selecting && posts.length ? (
                        <Tick
                          checked={all}
                          label={W.picking.pickDay(fmtDateShort(day))}
                          onChange={(on) => g.onPick(posts, on)}
                          testId={`socialcontent-pick-day-${day}`}
                        />
                      ) : null}
                      <button
                        type="button"
                        onClick={() => onOpenWeek(day)}
                        title={W.picking.openWeek(fmtDateShort(day))}
                        aria-label={W.picking.openWeek(fmtDateShort(day))}
                        className={cn(
                          'ml-auto grid h-6 min-w-6 place-items-center rounded-full px-1 text-[12.5px] tabular-nums hover:bg-card-2',
                          isToday
                            ? 'bg-accent font-semibold text-white hover:bg-accent-hover'
                            : inMonth(day)
                              ? 'font-medium text-text'
                              : 'text-text-3',
                        )}
                      >
                        {!inMonth(day) && (n === 1 || day === from) ? fmtMonthDay(day) : n}
                      </button>
                    </div>
                    {/* A phone-wide screen shows a dot for each post; its number opens the week. */}
                    {posts.length ? (
                      <div className="flex flex-wrap gap-0.5 px-0.5 sm:hidden" aria-hidden>
                        {posts.slice(0, 6).map((p) => (
                          <span key={p.id} className={cn('h-1.5 w-1.5 rounded-full', dotOf(p))} />
                        ))}
                      </div>
                    ) : null}
                    {posts.slice(0, MONTH_SHOWN).map((p) => {
                      const on = g.isPicked(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => (g.selecting ? g.onPick([p], !on) : g.onOpen(p))}
                          className={cn(
                            'hidden min-w-0 items-center gap-1 rounded-[5px] border border-l-[3px] border-transparent px-1 py-[1px] text-left text-[11.5px] text-text hover:brightness-95 sm:flex',
                            edgeOf(p),
                            g.selecting && on && 'ring-1 ring-accent',
                          )}
                          aria-pressed={g.selecting ? on : undefined}
                          title={`${p.title} · ${stateWord(p)}`}
                          data-testid={`socialcontent-post-${p.id}`}
                        >
                          <span className="flex-none text-[10px] font-semibold uppercase text-text-3">
                            {W.picking.short[p.network] ?? p.network.slice(0, 2)}
                          </span>
                          <span className="truncate">{p.title}</span>
                        </button>
                      );
                    })}
                    {posts.length > MONTH_SHOWN ? (
                      <button
                        type="button"
                        onClick={() => onOpenWeek(day)}
                        className="hidden px-1 text-left text-[11.5px] text-text-3 hover:text-text sm:block"
                      >
                        {W.picking.moreOn(posts.length - MONTH_SHOWN)}
                      </button>
                    ) : null}
                    {!posts.length && free.length && day >= g.today ? (
                      <span className="hidden px-1 text-[11.5px] text-text-3 sm:inline">
                        {W.picking.notFilled}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** What the edges mean, under the Month look. */
export function Legend({ hint }: { hint: string | null }) {
  const items: readonly { key: string; edge: string; label: string }[] = [
    {
      key: 'waiting',
      edge: edgeOf({ state: 'draft', hidden: false }),
      label: W.picking.shows.waiting,
    },
    { key: 'okd', edge: edgeOf({ state: 'ready', hidden: false }), label: W.picking.shows.okd },
    {
      key: 'posted',
      edge: edgeOf({ state: 'posted', hidden: false }),
      label: W.picking.shows.posted,
    },
    {
      key: 'failed',
      edge: edgeOf({ state: 'failed', hidden: false }),
      label: W.picking.shows.failed,
    },
    {
      key: 'hidden',
      edge: edgeOf({ state: 'posted', hidden: true }),
      label: W.picking.shows.hidden,
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-text-3">
      <ul
        aria-label={W.picking.legendLabel}
        className="flex flex-wrap items-center gap-x-4 gap-y-1"
      >
        {items.map((i) => (
          <li key={i.key} className="flex items-center gap-1.5">
            <span
              className={cn('h-3 w-3 rounded-[3px] border border-l-[3px] border-border', i.edge)}
            />
            {i.label}
          </li>
        ))}
      </ul>
      {hint ? <span className="ml-auto">{hint}</span> : null}
    </div>
  );
}
