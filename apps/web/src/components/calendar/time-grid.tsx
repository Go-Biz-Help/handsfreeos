'use client';
import {
  closedStretches,
  overlapLanes,
  placeOnDay,
  wallMinutes,
  type MinuteSpan,
} from '@hfos/core';
import { CalendarDays, Globe, Truck, Users } from 'lucide-react';
import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { GoogleLogo, MicrosoftLogo } from '@/components/settings/provider-logos';
import type { Appointment } from '@/lib/api/types';
import { clockLabel, dateOf, fmtLength, fmtRange, hourLabel } from '@/lib/calendar/time';
import { cn } from '@/lib/utils';
import { areaOf, customersOf, firstName, isPast } from './appt';

export interface GridBlock {
  readonly key: string;
  readonly span: MinuteSpan;
  readonly kind: 'busy' | 'time_off';
  readonly title: string;
  readonly provider?: 'google' | 'microsoft' | null;
}

export interface GridColumn {
  readonly key: string;
  /** The local date this column shows. */
  readonly date: string;
  readonly header: ReactNode;
  readonly today: boolean;
  /** Open time that day (wall minutes); the rest is shaded. Null shades nothing. */
  readonly open: readonly MinuteSpan[] | null;
  readonly blocks: readonly GridBlock[];
  readonly events: readonly Appointment[];
  /** Whose column: an empty-slot click books with them, a drop here gives it to them. */
  readonly userId: string | null;
}

export interface GridMove {
  readonly appt: Appointment;
  readonly from: GridColumn;
  readonly to: GridColumn;
  /** The new place, in wall minutes on `to.date`. */
  readonly top: number;
  readonly bottom: number;
  readonly kind: 'move' | 'resize';
}

export interface GridGhost {
  readonly apptId: string;
  readonly colKey: string;
  readonly top: number;
  readonly bottom: number;
}

interface DragState {
  appt: Appointment;
  col: GridColumn;
  el: HTMLElement;
  startX: number;
  startY: number;
  top: number;
  bottom: number;
  kind: 'move' | 'resize';
  moved: boolean;
  target: GridColumn;
  nextTop: number;
  nextBottom: number;
}

/**
 * The in-house time grid: exact-minute placement, side-by-side lanes for overlaps, one background for the
 * hour and quarter-hour lines, shading outside working hours, grey Busy blocks, a current-time line after
 * mount, a sticky header and time gutter, and horizontal scroll for many columns. Drag moves and the bottom
 * edge resizes, for desktop pointers only; the parent confirms before anything changes.
 */
export function TimeGrid({
  columns,
  timeZone,
  hours,
  now,
  hourHeight = 60,
  minColumnWidth = 168,
  gutter = 56,
  draggable,
  crossColumns,
  selectedId,
  ghost,
  maxHeight,
  onSlot,
  onOpen,
  onMove,
  testId = 'time-grid',
}: {
  columns: readonly GridColumn[];
  timeZone: string;
  hours: { from: number; to: number };
  now: number | null;
  hourHeight?: number;
  minColumnWidth?: number;
  gutter?: number;
  draggable: boolean;
  /** Whether a drag can land in another column (another person, or another day). */
  crossColumns: boolean;
  selectedId?: string | null;
  ghost?: GridGhost | null;
  maxHeight?: string;
  onSlot?: (col: GridColumn, minutes: number) => void;
  onOpen: (appt: Appointment) => void;
  onMove?: (move: GridMove) => void;
  testId?: string;
}) {
  const px = hourHeight / 60;
  const first = hours.from * 60;
  const last = hours.to * 60;
  const bodyHeight = (hours.to - hours.from) * hourHeight;
  const colEls = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [live, setLive] = useState<GridGhost | null>(null);
  const shown = live ?? ghost ?? null;
  const today = now === null ? null : dateOf(now, timeZone);
  const nowMinutes = now === null ? null : wallMinutes(now, timeZone);
  const y = (minutes: number) => (minutes - first) * px;

  function begin(
    e: PointerEvent<HTMLElement>,
    appt: Appointment,
    col: GridColumn,
    span: MinuteSpan,
    kind: DragState['kind'],
    el: HTMLElement,
  ) {
    if (!draggable || e.pointerType !== 'mouse' || e.button !== 0 || appt.status !== 'scheduled')
      return;
    el.setPointerCapture(e.pointerId);
    drag.current = {
      appt,
      col,
      el,
      startX: e.clientX,
      startY: e.clientY,
      top: span.top,
      bottom: span.bottom,
      kind,
      moved: false,
      target: col,
      nextTop: span.top,
      nextBottom: span.bottom,
    };
  }

  function track(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    d.moved = true;
    const delta = Math.round(dy / px / 15) * 15;
    const length = d.bottom - d.top;
    if (d.kind === 'resize') {
      d.nextTop = d.top;
      d.nextBottom = Math.min(Math.max(d.top + 15, d.bottom + delta), last);
    } else {
      d.nextTop = Math.min(Math.max(d.top + delta, first), last - length);
      d.nextBottom = d.nextTop + length;
      if (crossColumns)
        for (const c of columns) {
          const rect = colEls.current.get(c.key)?.getBoundingClientRect();
          if (rect && e.clientX >= rect.left && e.clientX < rect.right) d.target = c;
        }
    }
    setLive({ apptId: d.appt.id, colKey: d.target.key, top: d.nextTop, bottom: d.nextBottom });
  }

  function finish(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.el.hasPointerCapture(e.pointerId)) d.el.releasePointerCapture(e.pointerId);
    setLive(null);
    if (!d.moved) return;
    suppressClick.current = true;
    const changed = d.target.key !== d.col.key || d.nextTop !== d.top || d.nextBottom !== d.bottom;
    if (changed)
      onMove?.({
        appt: d.appt,
        from: d.col,
        to: d.target,
        top: d.nextTop,
        bottom: d.nextBottom,
        kind: d.kind,
      });
  }

  const gridTemplateColumns = `${gutter}px repeat(${columns.length}, minmax(${minColumnWidth}px, 1fr))`;

  return (
    <div
      className="relative overflow-auto rounded-card border border-border bg-card shadow-1"
      style={{ maxHeight }}
      data-testid={testId}
    >
      <div
        className="grid"
        style={{ gridTemplateColumns, minWidth: gutter + columns.length * minColumnWidth }}
      >
        <div className="sticky left-0 top-0 z-30 border-b border-border bg-card" />
        {columns.map((c) => (
          <div
            key={c.key}
            className={cn(
              'sticky top-0 z-20 flex min-w-0 items-center gap-2.5 border-b border-l border-border bg-card px-3 py-2',
            )}
            data-testid={`grid-head-${c.key}`}
          >
            {c.header}
          </div>
        ))}

        <div className="sticky left-0 z-20 bg-card" style={{ height: bodyHeight }} aria-hidden>
          {Array.from({ length: hours.to - hours.from }, (_, i) => (
            <span
              key={i}
              className={cn(
                'absolute right-2 whitespace-nowrap text-[11px] leading-none text-text-3',
                i === 0 ? 'top-1' : '-translate-y-1/2',
              )}
              style={i === 0 ? undefined : { top: i * hourHeight }}
            >
              {hourLabel(hours.from + i)}
            </span>
          ))}
          {nowMinutes !== null &&
          columns.some((c) => c.date === today) &&
          nowMinutes >= first &&
          nowMinutes <= last ? (
            <span className="cal-nowl" style={{ top: y(nowMinutes) }}>
              {clockLabel(nowMinutes, false)}
            </span>
          ) : null}
        </div>

        {columns.map((c) => {
          const spans = new Map<string, MinuteSpan>();
          for (const a of c.events) {
            const span = placeOnDay(Date.parse(a.startsAt), Date.parse(a.endsAt), c.date, timeZone);
            if (span) spans.set(a.id, span);
          }
          const lanes = overlapLanes(
            [...spans].map(([id, s]) => ({ id, start: s.top, end: s.bottom })),
          );
          const closed = c.open ? closedStretches(c.open) : [];
          return (
            <div
              key={c.key}
              ref={(el) => {
                if (el) colEls.current.set(c.key, el);
                else colEls.current.delete(c.key);
              }}
              className="cal-col cursor-cell"
              style={{ height: bodyHeight, '--hh': `${hourHeight}px` } as CSSProperties}
              data-testid={`grid-col-${c.key}`}
              data-date={c.date}
              onClick={(e) => {
                if (!onSlot || (e.target as HTMLElement).closest('[data-appt]')) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const minutes = Math.floor(((e.clientY - rect.top) / px + first) / 15) * 15;
                onSlot(c, Math.min(Math.max(minutes, first), last - 15));
              }}
            >
              {closed.map((s) => {
                const top = Math.max(s.top, first);
                const bottom = Math.min(s.bottom, last);
                return bottom > top ? (
                  <div
                    key={`off-${s.top}`}
                    className="cal-offh"
                    style={{ top: y(top), height: (bottom - top) * px }}
                  />
                ) : null;
              })}
              {c.blocks.map((b) => {
                const top = Math.max(b.span.top, first);
                const bottom = Math.min(b.span.bottom, last);
                if (bottom <= top) return null;
                return (
                  <div
                    key={b.key}
                    className={cn('cal-busy', b.kind === 'time_off' && 'cal-timeoff')}
                    style={{ top: y(top) + 1, height: Math.max(14, (bottom - top) * px - 2) }}
                    title={b.title}
                    data-testid={b.kind === 'busy' ? 'busy-block' : 'time-off-block'}
                  >
                    {b.kind === 'busy' ? (
                      b.provider === 'google' ? (
                        <GoogleLogo className="mt-px h-3 w-3 flex-none" />
                      ) : b.provider === 'microsoft' ? (
                        <MicrosoftLogo className="mt-px h-3 w-3 flex-none" />
                      ) : (
                        <CalendarDays className="mt-px h-3 w-3 flex-none" strokeWidth={1.5} />
                      )
                    ) : (
                      <CalendarDays className="mt-px h-3 w-3 flex-none" strokeWidth={1.5} />
                    )}
                    <span>{b.kind === 'busy' ? 'Busy' : 'Time off'}</span>
                  </div>
                );
              })}
              {c.events.map((a) => {
                const span = spans.get(a.id);
                if (!span) return null;
                const lane = lanes.get(a.id) ?? { lane: 0, lanes: 1 };
                const dragging = shown?.apptId === a.id;
                return (
                  <EventBlock
                    key={a.id}
                    appt={a}
                    col={c}
                    span={span}
                    lane={lane}
                    y={y}
                    px={px}
                    first={first}
                    last={last}
                    timeZone={timeZone}
                    now={now}
                    selected={selectedId === a.id}
                    dragging={dragging}
                    draggable={draggable}
                    onPointerDown={(e, kind, el) => begin(e, a, c, span, kind, el)}
                    onPointerMove={track}
                    onPointerUp={finish}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      onOpen(a);
                    }}
                  />
                );
              })}
              {shown && shown.colKey === c.key
                ? (() => {
                    const a = columns.flatMap((x) => x.events).find((e) => e.id === shown.apptId);
                    if (!a) return null;
                    return (
                      <div
                        aria-hidden
                        className="cal-ev cal-ghost"
                        style={
                          {
                            '--c': a.calendar.color,
                            top: y(shown.top) + 1,
                            height: Math.max(18, (shown.bottom - shown.top) * px - 2),
                            left: 3,
                            right: 4,
                          } as CSSProperties
                        }
                        data-testid="drag-ghost"
                      >
                        <span className="cal-t">{a.title}</span>
                        <span className="cal-s">
                          {clockLabel(shown.top)}–{clockLabel(shown.bottom)}
                        </span>
                      </div>
                    );
                  })()
                : null}
              {nowMinutes !== null &&
              c.date === today &&
              nowMinutes >= first &&
              nowMinutes <= last ? (
                <div className="cal-now" style={{ top: y(nowMinutes) }} data-testid="now-line" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventBlock({
  appt: a,
  col,
  span,
  lane,
  y,
  px,
  first,
  last,
  timeZone,
  now,
  selected,
  dragging,
  draggable,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onClick,
}: {
  appt: Appointment;
  col: GridColumn;
  span: MinuteSpan;
  lane: { lane: number; lanes: number };
  y: (m: number) => number;
  px: number;
  first: number;
  last: number;
  timeZone: string;
  now: number | null;
  selected: boolean;
  dragging: boolean;
  draggable: boolean;
  onPointerDown: (e: PointerEvent<HTMLElement>, kind: 'move' | 'resize', el: HTMLElement) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onClick: () => void;
}) {
  const top = Math.max(span.top, first);
  const bottom = Math.min(span.bottom, last);
  if (bottom <= top) return null;
  const height = Math.max(18, (bottom - top) * px - 2);
  const customers = customersOf(a);
  const area = areaOf(a.location.address);
  const others = a.staff.filter((s) => s.userId !== col.userId).map((s) => firstName(s.fullName));
  const sub = [
    customers.length === 1
      ? customers[0]!.fullName
      : customers.length > 1
        ? `${customers.length} customers`
        : null,
    area,
  ]
    .filter(Boolean)
    .join(' · ');
  const chips: ReactNode[] = [];
  if (a.capacity > 1)
    chips.push(
      <span key="seats" className="cal-mini">
        <Users className="h-3 w-3" strokeWidth={1.5} />
        {a.seatsTaken}/{a.capacity} seats
      </span>,
    );
  for (const r of a.resources)
    chips.push(
      <span key={r.resourceId} className="cal-mini">
        <Truck className="h-3 w-3" strokeWidth={1.5} />
        {r.name}
      </span>,
    );
  if (others.length && col.userId)
    chips.push(
      <span key="with" className="cal-mini">
        With {others.join(' and ')}
      </span>,
    );
  if (a.status === 'no_show')
    chips.push(
      <span key="noshow" className="cal-mini">
        No-show
      </span>,
    );
  const range = fmtRange(a.startsAt, a.endsAt, timeZone);
  const before = a.bufferBefore;
  const after = a.bufferAfter;
  const minutes = span.bottom - span.top;
  const style = {
    '--c': a.calendar.color,
    top: y(top) + 1,
    height,
    left: `calc(${(lane.lane / lane.lanes) * 100}% + 3px)`,
    width: `calc(${100 / lane.lanes}% - 7px)`,
  } as CSSProperties;
  return (
    <>
      {before > 0 && span.top - before >= first ? (
        <div
          className="cal-travel"
          style={
            {
              '--c': a.calendar.color,
              top: y(span.top - before),
              height: before * px,
              left: style.left,
              width: style.width,
            } as CSSProperties
          }
          title={`${fmtLength(before)} kept before`}
        />
      ) : null}
      {after > 0 && span.bottom + after <= last ? (
        <div
          className="cal-travel"
          style={
            {
              '--c': a.calendar.color,
              top: y(span.bottom),
              height: after * px,
              left: style.left,
              width: style.width,
            } as CSSProperties
          }
          title={`${fmtLength(after)} kept after`}
        />
      ) : null}
      <button
        type="button"
        data-appt={a.id}
        data-testid={`appt-${a.id}`}
        data-col={col.key}
        data-top={span.top}
        data-bottom={span.bottom}
        className={cn(
          'cal-ev',
          (isPast(a, now) || a.status !== 'scheduled') && 'cal-past',
          selected && 'cal-sel',
          dragging && 'cal-dragging',
          draggable && a.status === 'scheduled' && 'cursor-grab active:cursor-grabbing',
        )}
        style={style}
        title={`${a.title} · ${range}`}
        onPointerDown={(e) => onPointerDown(e, 'move', e.currentTarget)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
      >
        <span className="cal-t pr-3">{a.title}</span>
        {a.source === 'booking_page' ? (
          <span className="absolute right-1.5 top-[5px] text-text-2" title="Booked online">
            <Globe className="h-3 w-3" strokeWidth={1.5} />
          </span>
        ) : null}
        {minutes >= 40 && sub ? <span className="cal-s">{sub}</span> : null}
        {minutes >= 30 ? <span className="cal-s">{range}</span> : null}
        {minutes >= 90 && chips.length ? (
          <span className="mt-1 flex flex-wrap gap-1">{chips}</span>
        ) : null}
        {draggable && a.status === 'scheduled' ? (
          <span
            className="cal-handle"
            aria-hidden
            data-testid="resize-handle"
            onPointerDown={(e) => {
              e.stopPropagation();
              onPointerDown(e, 'resize', e.currentTarget.parentElement as HTMLElement);
            }}
          />
        ) : null}
      </button>
    </>
  );
}
