'use client';
/**
 * Trends (`?view=trends`, round four): how coached calls are going over the last weeks, against the same number of
 * weeks before (`salescoach.trends`, packages/core/src/addons/salescoach/trends.ts).
 *
 * A rep sees their own: the totals, their score week by week and the script steps they skip most. Whoever reviews
 * (`salescoach.review`) sees the owner's view first: the team's totals and score by week, and a row for every rep,
 * each opening that rep's own (`&rep=`). The period is 4, 12 or 26 weeks (`&weeks=`).
 */
import { percentOf, TREND_PERIODS } from '@hfos/core/addons/salescoach/trends';
import { SALESCOACH_WORDS } from '@hfos/core/addons/salescoach/words';
import { ArrowDown, ArrowUp, ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import type { CoachTrend, CoachTrends } from './types';

const W = SALESCOACH_WORDS;
const T = SALESCOACH_WORDS.trends;

type Totals = CoachTrend['totals'];
type Week = CoachTrend['series'][number];

export const trendsHref = (workspaceId: string, weeks: number, rep?: string) =>
  `/app/w/${workspaceId}/a/salescoach?view=trends&weeks=${weeks}${rep ? `&rep=${rep}` : ''}`;

/** A Monday's local date as "Oct 12": the same on the server and in the browser. */
const shortDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

export function TrendsView({
  workspaceId,
  trends,
  weeks,
  rep,
  reviews,
}: {
  workspaceId: string;
  trends: CoachTrends;
  weeks: number;
  /** The rep asked for (`&rep=`), for people who review. */
  rep: string | null;
  reviews: boolean;
}) {
  const one = rep ? trends.reps.find((r) => r.rep.id === rep) : undefined;
  const nothing = trends.team.totals.coached === 0 && trends.team.previous.coached === 0;
  const periods = (
    <nav aria-label={T.period(weeks)} className="flex gap-1" data-testid="trends-periods">
      {TREND_PERIODS.map((n) => (
        <Link
          key={n}
          href={trendsHref(workspaceId, n, rep ?? undefined)}
          aria-current={n === weeks ? 'page' : undefined}
          className={cn(
            'rounded-[7px] px-2.5 py-1 text-[12.5px] font-medium',
            n === weeks ? 'bg-card-3 text-text' : 'text-text-2 hover:text-text',
          )}
        >
          {T.period(n)}
        </Link>
      ))}
    </nav>
  );

  if (reviews && !rep)
    return (
      <div className="space-y-4" data-testid="trends-team">
        <Heading title={T.team} about={T.teamAbout} periods={periods} />
        {nothing ? (
          <EmptyState title={W.tabs.trends} dashed>
            {T.none}
          </EmptyState>
        ) : (
          <>
            <Tiles totals={trends.team.totals} previous={trends.team.previous} />
            <WeeklyScore series={trends.team.series} />
            <RepsTable workspaceId={workspaceId} trends={trends} weeks={weeks} />
            <Skipped trend={trends.team} />
          </>
        )}
      </div>
    );

  // A rep's own; or, for people who review, the rep they picked.
  const trend = one ?? (reviews ? undefined : trends.reps[0]);
  return (
    <div className="space-y-4" data-testid="trends-rep">
      {reviews ? (
        <Link
          href={trendsHref(workspaceId, weeks)}
          className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          {T.team}
        </Link>
      ) : null}
      <Heading
        title={one ? one.rep.name : reviews ? W.tabs.trends : T.mine}
        about={one ? T.repAbout(one.rep.name) : T.mineAbout}
        periods={periods}
      />
      {!trend ? (
        <EmptyState title={W.tabs.trends} dashed>
          {T.none}
        </EmptyState>
      ) : (
        <>
          <Tiles totals={trend.totals} previous={trend.previous} />
          <WeeklyScore series={trend.series} />
          <Skipped trend={trend} />
        </>
      )}
    </div>
  );
}

function Heading({ title, about, periods }: { title: string; about: string; periods: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="text-[12.5px] text-text-3">{about}</p>
      </div>
      {periods}
    </div>
  );
}

// ---------- the totals ----------

interface Tile {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  /** This period's number and the one before, to compare; null when they can't be. */
  readonly now: number | null;
  readonly before: number | null;
  readonly beforeShown: string;
  /** Whether more is better: null when it's neither (talk time). */
  readonly upIsGood: boolean | null;
  readonly about?: string;
}

function Tiles({ totals, previous }: { totals: Totals; previous: Totals }) {
  const pct = (t: Totals, k: 'objections' | 'steps') =>
    k === 'objections'
      ? percentOf(t.objections.answered, t.objections.of)
      : percentOf(t.steps.covered, t.steps.of);
  const hadBefore = previous.coached > 0;
  const tiles: Tile[] = [
    {
      label: T.coached,
      value: String(totals.coached),
      now: totals.coached,
      before: hadBefore ? previous.coached : null,
      beforeShown: String(previous.coached),
      upIsGood: true,
    },
    {
      label: T.score,
      value: totals.score === null ? '—' : String(totals.score),
      now: totals.score,
      before: previous.score,
      beforeShown: String(previous.score ?? '—'),
      upIsGood: true,
    },
    {
      label: T.talk,
      value: T.percent(totals.talkShare),
      now: totals.talkShare,
      before: previous.talkShare,
      beforeShown: T.percent(previous.talkShare),
      upIsGood: null,
      about: T.talkAbout,
    },
    {
      label: T.objections,
      value: T.percent(pct(totals, 'objections')),
      detail: T.ofCount(totals.objections.answered, totals.objections.of),
      now: pct(totals, 'objections'),
      before: pct(previous, 'objections'),
      beforeShown: T.percent(pct(previous, 'objections')),
      upIsGood: true,
    },
    {
      label: T.steps,
      value: T.percent(pct(totals, 'steps')),
      detail: T.ofCount(totals.steps.covered, totals.steps.of),
      now: pct(totals, 'steps'),
      before: pct(previous, 'steps'),
      beforeShown: T.percent(pct(previous, 'steps')),
      upIsGood: true,
    },
    {
      label: T.wins,
      value: String(totals.wins),
      now: totals.wins,
      before: hadBefore ? previous.wins : null,
      beforeShown: String(previous.wins),
      upIsGood: true,
      about: T.winsAbout,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3" data-testid="trends-tiles">
      {tiles.map((t) => (
        <Card key={t.label} className="space-y-1 p-3.5" title={t.about}>
          <div className="text-[12.5px] text-text-2">{t.label}</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-[22px] font-semibold tabular-nums leading-tight">{t.value}</span>
            {t.detail ? <span className="text-[12px] text-text-3">{t.detail}</span> : null}
          </div>
          <Change tile={t} />
        </Card>
      ))}
    </div>
  );
}

function Change({ tile }: { tile: Tile }) {
  if (tile.now === null || tile.before === null)
    return <div className="text-[12px] text-text-3">{T.beforeNone}</div>;
  const d = tile.now - tile.before;
  const good = tile.upIsGood === null || d === 0 ? null : d > 0 === tile.upIsGood;
  const Icon = d > 0 ? ArrowUp : ArrowDown;
  return (
    <div
      className={cn(
        'flex items-center gap-1 text-[12px]',
        good === true ? 'text-success-text' : good === false ? 'text-danger-text' : 'text-text-3',
      )}
    >
      {d !== 0 ? <Icon className="h-3 w-3" strokeWidth={2} aria-hidden /> : null}
      <span className="tabular-nums">{d !== 0 ? Math.abs(d) : null}</span>
      <span className="text-text-3">{T.before(tile.beforeShown)}</span>
    </div>
  );
}

// ---------- the score by week ----------

const CHART_H = 168;
const PAD = { left: 30, right: 34, top: 14, bottom: 24 } as const;

/** The average score of each week, one line; a week with nothing coached is a gap, not a zero. */
function WeeklyScore({ series }: { series: readonly Week[] }) {
  const box = useRef<HTMLDivElement>(null);
  // Measured in the browser: until then the plot's space is kept, so nothing is drawn at the wrong width.
  const [width, setWidth] = useState<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const seen = new ResizeObserver(([e]) => setWidth(Math.max(260, e!.contentRect.width)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  const plotW = (width ?? 0) - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / 100) * plotH;
  // Runs of weeks with a score: each is a line, and a gap breaks it.
  const runs: { i: number; v: number }[][] = [];
  series.forEach((w, i) => {
    if (w.score === null) return;
    const last = runs.at(-1);
    if (last && last.at(-1)!.i === i - 1) last.push({ i, v: w.score });
    else runs.push([{ i, v: w.score }]);
  });
  const lastPoint = runs.at(-1)?.at(-1);
  const nearest = (clientX: number, left: number) => {
    const px = clientX - left;
    let best = 0;
    for (let i = 1; i < series.length; i++)
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent<SVGRectElement>) =>
    setAt(nearest(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect().left));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    setAt((a) => Math.min(series.length - 1, Math.max(0, (a ?? series.length - 1) + step)));
  };
  const shown = at === null ? null : series[at];
  const labelled = new Set([0, Math.floor((series.length - 1) / 2), series.length - 1]);

  return (
    <Card className="space-y-2 p-4" data-testid="trends-weekly">
      <div>
        <h3 className="text-[14px] font-semibold">{T.weekly}</h3>
        <p className="text-[12.5px] text-text-3">{T.weeklyAbout}</p>
      </div>
      <div ref={box} className="relative" style={{ height: CHART_H }}>
        {width === null ? null : (
          <svg
            width={width}
            height={CHART_H}
            className="block max-w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            role="img"
            aria-label={T.weekly}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setAt(null)}
          >
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(v)}
                  y2={y(v)}
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 6}
                  y={y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-text-3 text-[11px] tabular-nums"
                >
                  {v}
                </text>
              </g>
            ))}
            {series.map((w, i) =>
              labelled.has(i) ? (
                <text
                  key={w.week}
                  x={x(i)}
                  y={CHART_H - 6}
                  textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}
                  className="fill-text-3 text-[11px]"
                >
                  {shortDate(w.week)}
                </text>
              ) : null,
            )}
            {shown ? (
              <line
                x1={x(at!)}
                x2={x(at!)}
                y1={PAD.top}
                y2={PAD.top + plotH}
                stroke="var(--border-strong)"
                strokeWidth={1}
              />
            ) : null}
            {runs.map((run) =>
              run.length > 1 ? (
                <polyline
                  key={run[0]!.i}
                  points={run.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
                  fill="none"
                  stroke="var(--accent-text)"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null,
            )}
            {runs.flat().map((p) => (
              <circle
                key={p.i}
                cx={x(p.i)}
                cy={y(p.v)}
                r={p.i === at ? 5 : 4}
                fill="var(--accent-text)"
                stroke="var(--card)"
                strokeWidth={2}
              />
            ))}
            {lastPoint ? (
              <text
                x={x(lastPoint.i) + 8}
                y={y(lastPoint.v)}
                dy="0.32em"
                className="fill-text text-[12px] font-semibold tabular-nums"
              >
                {lastPoint.v}
              </text>
            ) : null}
            <rect
              x={PAD.left}
              y={0}
              width={plotW}
              height={CHART_H}
              fill="transparent"
              onPointerMove={onMove}
              onPointerLeave={() => setAt(null)}
            />
          </svg>
        )}
        {shown && width !== null ? (
          <div
            role="status"
            className="pointer-events-none absolute z-10 rounded-[8px] border border-border bg-card px-2.5 py-1.5 text-[12px] shadow-1"
            // Beside the crosshair, and above or below the point so it never covers it.
            style={{
              left: x(at!) + 158 > width ? x(at!) - 150 : x(at!) + 10,
              top: shown.score !== null && shown.score >= 50 ? PAD.top + plotH - 66 : PAD.top,
              width: 140,
            }}
          >
            <div className="font-semibold tabular-nums">
              {shown.score === null ? '—' : `${W.calls.score} ${shown.score}`}
            </div>
            <div className="text-text-2">{T.weekOf(shortDate(shown.week))}</div>
            <div className="text-text-3">
              {T.coached} {shown.coached}
            </div>
          </div>
        ) : null}
      </div>
      <details className="text-[12.5px]">
        <summary className="cursor-pointer text-text-2 hover:text-text">{T.asTable}</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead className="text-text-3">
            <tr>
              <th className="py-1 font-medium">{T.week}</th>
              <th className="py-1 font-medium">{T.coached}</th>
              <th className="py-1 font-medium">{T.score}</th>
              <th className="py-1 font-medium">{T.talk}</th>
              <th className="py-1 font-medium">{T.wins}</th>
            </tr>
          </thead>
          <tbody>
            {series.map((w) => (
              <tr key={w.week} className="border-t border-border">
                <td className="py-1">{shortDate(w.week)}</td>
                <td className="py-1">{w.coached}</td>
                <td className="py-1">{w.score ?? '—'}</td>
                <td className="py-1">{T.percent(w.talkShare)}</td>
                <td className="py-1">{w.wins}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  );
}

// ---------- the owner's view ----------

function RepsTable({
  workspaceId,
  trends,
  weeks,
}: {
  workspaceId: string;
  trends: CoachTrends;
  weeks: number;
}) {
  return (
    <Card className="overflow-x-auto" data-testid="trends-reps">
      <table className="w-full min-w-[620px] text-left text-[13px] tabular-nums">
        <thead className="text-[12px] text-text-3">
          <tr className="border-b border-border">
            <th className="px-4 py-2 font-medium">{T.rep}</th>
            <th className="px-2 py-2 font-medium">{T.coached}</th>
            <th className="px-2 py-2 font-medium">{T.score}</th>
            <th className="px-2 py-2 font-medium">{T.talk}</th>
            <th className="px-2 py-2 font-medium">{T.objections}</th>
            <th className="px-2 py-2 font-medium">{T.steps}</th>
            <th className="px-4 py-2 font-medium">{T.wins}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {trends.reps.map((r) => {
            const d =
              r.totals.score !== null && r.previous.score !== null
                ? r.totals.score - r.previous.score
                : null;
            return (
              <tr key={r.rep.id} className="hover:bg-card-2">
                <td className="px-4 py-2.5">
                  <Link
                    href={trendsHref(workspaceId, weeks, r.rep.id)}
                    className="font-medium hover:underline"
                    data-testid="trends-rep-link"
                  >
                    {r.rep.name}
                  </Link>
                </td>
                <td className="px-2 py-2.5">{r.totals.coached}</td>
                <td className="px-2 py-2.5">
                  {r.totals.score ?? '—'}
                  {d ? (
                    <span
                      className={cn(
                        'ml-1.5 inline-flex items-center text-[11.5px]',
                        d > 0 ? 'text-success-text' : 'text-danger-text',
                      )}
                    >
                      {d > 0 ? (
                        <ArrowUp className="h-3 w-3" strokeWidth={2} aria-label="up" />
                      ) : (
                        <ArrowDown className="h-3 w-3" strokeWidth={2} aria-label="down" />
                      )}
                      {Math.abs(d)}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-2.5">{T.percent(r.totals.talkShare)}</td>
                <td className="px-2 py-2.5">
                  {T.percent(percentOf(r.totals.objections.answered, r.totals.objections.of))}
                </td>
                <td className="px-2 py-2.5">
                  {T.percent(percentOf(r.totals.steps.covered, r.totals.steps.of))}
                </td>
                <td className="px-4 py-2.5">{r.totals.wins}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function Skipped({ trend }: { trend: CoachTrend }) {
  return (
    <Card className="space-y-2 p-4" data-testid="trends-skipped">
      <div>
        <h3 className="text-[14px] font-semibold">{T.skipped}</h3>
        <p className="text-[12.5px] text-text-3">{T.skippedAbout}</p>
      </div>
      {trend.skippedSteps.length === 0 ? (
        <p className="text-[13px] text-text-2">{T.noSkipped}</p>
      ) : (
        <ul className="divide-y divide-border">
          {trend.skippedSteps.map((s) => (
            <li key={`${s.playbookId}:${s.stepId}`} className="flex items-baseline gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium">{s.title}</div>
                <div className="truncate text-[12px] text-text-3">{s.playbookName}</div>
              </div>
              <div className="flex-none text-[12.5px] text-text-2 tabular-nums">
                {T.skippedLine(s.skipped, s.of)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
