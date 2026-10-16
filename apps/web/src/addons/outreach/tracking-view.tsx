'use client';
/**
 * The top of Social Outreach's Results tab (docs/outreach.md, decision 70; the boards in design/tracking): the three
 * numbers the video says to watch every day, first messages sent, said yes and calls booked, each against the
 * person's target from their goal; the two rates between them against the usual ones; the person's latest week's
 * review; and the numbers by playbook, by the main offer's version and by network, each network's share of one goal.
 * Owners and admins see everyone's counts, with no targets and no review. Every word and rule is core's
 * (`@hfos/core/addons/outreach/tracking`).
 */
import type { ActivityPeriod } from '@hfos/core/addons/outreach/activity';
import { shareWords } from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import {
  bookStanding,
  percent,
  REVIEW_FIX_KEYS,
  REVIEW_FIXES,
  TRACKING_WORDS as T,
  yesStanding,
  type RateStanding,
  type TrackingNumbers,
} from '@hfos/core/addons/outreach/tracking';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Tracking } from './types';

const KEYS = [
  'messages',
  'positive',
  'booked',
] as const satisfies readonly (keyof TrackingNumbers)[];
const STANDING_BADGE: Record<RateStanding, BadgeVariant> = {
  few: 'gray',
  below: 'pending',
  like: 'ok',
  above: 'ok',
};
/** The fixes in the video's order, keeping on track out. */
const ORDER = REVIEW_FIX_KEYS.filter((k) => k !== 'on_track');

export function TrackingSection({
  tracking,
  period,
}: {
  tracking: Tracking | null;
  period: ActivityPeriod;
}) {
  if (!tracking)
    return (
      <Card className="p-5 text-[13.5px] text-text-2" data-testid="tracking-failed">
        {T.failed}
      </Card>
    );
  return (
    <div className="space-y-4" data-testid="tracking">
      <NumbersCard tracking={tracking} period={period} />
      {tracking.everyone ? null : <ReviewCard review={tracking.review} />}
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
        <BreakdownCard
          title={T.byPlaybook}
          hint={T.byPlaybookHint}
          head="Playbook"
          rows={tracking.byPlaybook.map((p) => ({
            key: p.playbookId ?? 'none',
            name: p.name ?? T.noPlaybook,
            n: p,
          }))}
          testId="tracking-playbooks"
        />
        <BreakdownCard
          title={T.byVersion}
          hint={T.byVersionHint}
          head="Version"
          rows={tracking.byVersion.map((v) => ({
            key: String(v.version),
            name: T.version(v.version, v.live),
            n: v,
          }))}
          testId="tracking-versions"
        />
        <BreakdownCard
          title={T.byNetwork}
          hint={T.byNetworkHint}
          head="Network"
          rows={tracking.byNetwork.map((n) => ({
            key: n.platform,
            name: PLATFORMS[n.platform],
            detail: shareWords(n.messages, tracking.numbers.messages),
            n,
          }))}
          testId="tracking-networks"
        />
      </div>
    </div>
  );
}

function NumbersCard({ tracking, period }: { tracking: Tracking; period: ActivityPeriod }) {
  const n = tracking.numbers;
  const target = tracking.target;
  const rates = [
    {
      key: 'yes',
      label: T.rates.yes,
      part: n.positive,
      whole: n.messages,
      of: 'message',
      rate: tracking.rates.yes,
      benchmark: T.benchmark.yes,
      standing: yesStanding(n),
      // The usual 4 to 8%, on a scale to 20%.
      band: { from: 20, width: 20 },
      at: (r: number) => Math.min(100, r * 500),
    },
    {
      key: 'books',
      label: T.rates.books,
      part: n.booked,
      whole: n.positive,
      of: 'yes',
      rate: tracking.rates.books,
      benchmark: T.benchmark.books,
      standing: bookStanding(n),
      // 1 in 3 and better, on a scale to 100%.
      band: { from: 33, width: 67 },
      at: (r: number) => Math.min(100, r * 100),
    },
  ] as const;
  return (
    <Card className="p-0" data-testid="tracking-numbers">
      <div className="flex flex-wrap items-end justify-between gap-2 px-5 pt-4">
        <div>
          <h2 className="text-[17px] font-semibold">{tracking.everyone ? T.titleTeam : T.title}</h2>
          <p className="text-[13px] text-text-2">{tracking.everyone ? T.hintTeam : T.hint}</p>
        </div>
        {tracking.everyone ? null : target ? (
          <span className="text-[12.5px] text-text-3">{T.goal(target.goal)}</span>
        ) : (
          <span className="text-[12.5px] text-text-3" data-testid="tracking-no-goal">
            {T.noGoal}
          </span>
        )}
      </div>
      <ol className="grid gap-3 px-5 pt-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        {KEYS.map((key) => {
          const value = n[key];
          const goal = target ? target[key] : null;
          const pct = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
          const win = key === 'booked';
          return (
            <li
              key={key}
              className={cn(
                'grid gap-2 rounded-card border p-4',
                win ? 'border-success-soft bg-success-soft' : 'border-border bg-card',
              )}
              data-testid={`tracking-number-${key}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn('text-[13px] font-semibold', win && 'text-success-text')}>
                  {T.numbers[key]}
                </span>
                <span className={cn('text-[12px]', win ? 'text-success-text' : 'text-text-3')}>
                  {T.numberHints[key]}
                </span>
              </div>
              <span
                className={cn(
                  'text-[28px] font-semibold leading-tight tracking-[-0.015em] tabular-nums',
                  win && 'text-success-text',
                )}
              >
                {value.toLocaleString()}
              </span>
              {goal !== null ? (
                <>
                  <div
                    className={cn('h-1.5 rounded-full', win ? 'bg-card' : 'bg-card-2')}
                    role="progressbar"
                    aria-label={`${T.numbers[key]} against the target`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                  >
                    <div
                      className={cn('h-1.5 rounded-full', win ? 'bg-success' : 'bg-accent')}
                      style={{ width: `${value > 0 ? Math.max(4, pct) : 0}%` }}
                    />
                  </div>
                  <span
                    className={cn('text-[12.5px]', win ? 'text-success-text' : 'text-text-2')}
                    data-testid={`tracking-target-${key}`}
                  >
                    {T.target(goal)}
                  </span>
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      {n.messages === 0 && n.positive === 0 ? (
        <p className="px-5 py-4 text-[13px] text-text-2">{T.none(period)}</p>
      ) : (
        <ul className="mt-2 px-5 pb-1">
          {rates.map((r) => (
            <li
              key={r.key}
              className="grid items-center gap-x-4 gap-y-1 border-t border-border py-3 [grid-template-columns:minmax(120px,150px)_minmax(0,1fr)] md:[grid-template-columns:150px_minmax(0,1fr)_240px_auto]"
              data-testid={`tracking-rate-${r.key}`}
            >
              <span className="text-[14px] font-semibold">{r.label}</span>
              <span className="text-[13px] tabular-nums text-text-2">
                {r.rate === null ? T.noRate : T.rateOf(r.part, r.whole, r.of)}
              </span>
              <div className="col-span-2 grid gap-1 md:col-span-1">
                <div className="relative h-2 rounded-full bg-card-2" aria-hidden="true">
                  <span
                    className="absolute inset-y-0 rounded-full bg-success-soft"
                    style={{ left: `${r.band.from}%`, width: `${r.band.width}%` }}
                  />
                  {r.rate !== null ? (
                    <span
                      className="absolute top-1/2 -ml-1.5 -mt-1.5 h-3 w-3 rounded-full border-2 border-card bg-accent"
                      style={{ left: `${r.at(r.rate)}%` }}
                    />
                  ) : null}
                </div>
                <span className="text-[12.5px] text-text-3">{r.benchmark}</span>
              </div>
              <span className="justify-self-start md:justify-self-end">
                <Badge variant={STANDING_BADGE[r.standing]}>{T.standing[r.standing]}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReviewCard({ review }: { review: Tracking['review'] }) {
  const R = T.review;
  if (!review)
    return (
      <Card className="p-5" data-testid="tracking-review-none">
        <h2 className="text-[15px] font-semibold">{R.title}</h2>
        <p className="mt-1 text-[13px] text-text-2">{R.none}</p>
      </Card>
    );
  const at = ORDER.indexOf(review.fix as (typeof ORDER)[number]);
  const step = at === -1 ? ORDER.length : at;
  return (
    <Card className="space-y-3.5 p-5" data-testid="tracking-review">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {R.title} · {R.week(review.week)}
          </span>
          <h2 className="text-[19px] font-semibold" data-testid="tracking-review-headline">
            {review.headline}
          </h2>
        </div>
        <ol className="flex flex-wrap gap-1.5" aria-label="What to fix, in this order">
          {ORDER.map((fix, i) => (
            <li
              key={fix}
              className={cn(
                'inline-flex h-[26px] items-center rounded-full px-2.5 text-[12.5px] font-medium',
                i === step
                  ? 'bg-accent-soft text-accent-text'
                  : i < step
                    ? 'bg-card-2 text-success-text'
                    : 'bg-card-2 text-text-3',
              )}
              aria-current={i === step ? 'step' : undefined}
            >
              {i + 1}. {REVIEW_FIXES[fix].label}
            </li>
          ))}
        </ol>
      </div>
      <p className="max-w-[760px] text-[14px]">{review.why}</p>
      <ol className="space-y-2">
        {review.steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 text-[14px]">
            <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-card-2 text-[12px] font-semibold text-text-2">
              {i + 1}
            </span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <p className="text-[12.5px] text-text-3">
        Last week: {R.lastWeek(review.numbers)} · {R.by[review.by]}
      </p>
    </Card>
  );
}

function BreakdownCard({
  title,
  hint,
  head,
  rows,
  testId,
}: {
  title: string;
  hint: string;
  head: string;
  rows: readonly { key: string; name: string; detail?: string; n: TrackingNumbers }[];
  testId: string;
}) {
  return (
    <Card className="overflow-x-auto p-0" data-testid={testId}>
      <div className="px-5 pt-4">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <p className="text-[12.5px] text-text-3">{hint}</p>
      </div>
      {rows.length ? (
        <table className="mt-2 w-full min-w-[360px] text-left text-[13.5px]">
          <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
            <tr>
              <th className="px-5 py-2.5 font-semibold">{head}</th>
              <th className="px-3 py-2.5 text-right font-semibold">{T.columns.messages}</th>
              <th className="px-3 py-2.5 text-right font-semibold">{T.columns.positive}</th>
              <th className="px-5 py-2.5 text-right font-semibold">{T.columns.booked}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className="border-b border-border last:border-b-0"
                data-testid={`${testId}-row`}
              >
                <td className="px-5 py-2.5 font-medium">
                  {r.name}
                  {r.detail ? (
                    <span className="block text-[12px] font-normal text-text-3">{r.detail}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{r.n.messages}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {r.n.positive}
                  {r.n.messages ? (
                    <span className="ml-1.5 text-[12px] text-text-3">
                      {percent(r.n.positive / r.n.messages)}
                    </span>
                  ) : null}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums">{r.n.booked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-5 pb-4 pt-2 text-[13px] text-text-2">{T.noneCounted}</p>
      )}
    </Card>
  );
}
