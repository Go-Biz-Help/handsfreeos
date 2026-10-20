import {
  DESK_BUSINESS_WORDS,
  DESK_FLAG_ACTIONS,
  DESK_QUICK_LOOK_WORDS,
  DESK_SETUP_STATE_WORDS,
  deskActiveAgo,
  deskActivityBars,
  deskProblemReportLine,
  deskTheirMoneyLines,
  deskTrafficLines,
  type DeskFlag,
  type DeskFlagTone,
  type DeskQuickLookTab,
  type DeskSetupRow,
  type DeskSetupState,
} from '@hfos/core';
import { Check } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

/**
 * One business at a glance, in the pieces the quick look (business-quick-look.tsx) and the full page
 * (/admin/businesses/<id>) both show. No state and no hooks, so a server page draws them as readily as the window.
 */

type Glance = Ok<'/v1/queries/platform.business.glance'>;

const TONE: Readonly<Record<DeskFlagTone, { box: string; dot: string }>> = {
  danger: { box: 'bg-danger-soft text-danger-text', dot: 'bg-danger' },
  warning: { box: 'bg-warning-soft text-warning-text', dot: 'bg-warning' },
  accent: { box: 'bg-accent-soft text-accent-text', dot: 'bg-accent' },
};

const SETUP_BADGE: Readonly<Record<DeskSetupState, BadgeVariant>> = {
  yes: 'ok',
  no: 'gray',
  waiting: 'pending',
  problem: 'danger',
};

const SETUP_DOT: Readonly<Record<DeskSetupState, string>> = {
  yes: 'bg-success',
  no: 'border-[1.5px] border-text-3',
  waiting: 'bg-warning',
  problem: 'bg-danger',
};

/** "Lone Star Plumbing" → "LS". */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** Under the page's own heading a section is an h2; inside the window, whose title is the h2, an h3. */
export type GlanceHeading = 'h2' | 'h3';

export function GlanceSection({
  title,
  aside,
  children,
  className,
  id,
  heading: Heading = 'h2',
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  heading?: GlanceHeading;
}) {
  return (
    <section
      id={id}
      className={cn('scroll-mt-4 rounded-card border border-border bg-card p-4', className)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Heading className="text-sm font-semibold">{title}</Heading>
        {aside ? <span className="text-xs text-text-3">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function GlanceLines({
  lines,
}: {
  lines: readonly { label: string; value: string; tone?: 'danger' | null }[];
}) {
  return (
    <dl className="mt-3 flex flex-col gap-2 text-[13px]">
      {lines.map((l) => (
        <div key={l.label} className="flex justify-between gap-3">
          <dt className="text-text-3">{l.label}</dt>
          <dd className={cn('text-right', l.tone === 'danger' && 'font-semibold text-danger-text')}>
            {l.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What needs a look, or that nothing does. `action` draws the way to a flag's tab: a button in the window, a link to
 * the section further down the full page.
 */
export function FlagList({
  flags,
  action,
}: {
  flags: readonly DeskFlag[];
  action?: (tab: DeskQuickLookTab, label: string) => ReactNode;
}) {
  if (!flags.length)
    return (
      <p className="flex items-center gap-2.5 rounded-menu bg-success-soft px-3 py-2.5 text-[13px] text-success-text">
        <Check className="h-4 w-4" />
        {DESK_QUICK_LOOK_WORDS.nothingNeedsALook}
      </p>
    );
  return (
    <ul aria-label={DESK_BUSINESS_WORDS.needsALook} className="flex flex-col gap-1.5">
      {flags.map((f) => (
        <li
          key={f.key}
          className={cn(
            'flex items-center gap-3 rounded-menu py-1.5 pl-3 pr-1.5 text-[13px]',
            TONE[f.tone].box,
          )}
        >
          <span aria-hidden className={cn('h-2 w-2 flex-none rounded-full', TONE[f.tone].dot)} />
          <span className="min-w-0 flex-1 py-1">{f.text}</span>
          {f.tab && action ? action(f.tab, DESK_FLAG_ACTIONS[f.tab]) : null}
        </li>
      ))}
    </ul>
  );
}

/** The look of a flag's way to its tab, button or link alike. */
export const FLAG_ACTION_CLASS =
  'inline-flex h-8 flex-none items-center rounded-control bg-card/60 px-2.5 text-xs font-semibold hover:bg-card';

export function GlanceCounts({
  items,
}: {
  items: readonly { readonly label: string; readonly value: string }[];
}) {
  return (
    <dl className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
      {items.map((c) => (
        <div key={c.label} className="rounded-card border border-border bg-card px-3 py-2.5">
          <dt className="text-xs leading-tight text-text-3">{c.label}</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The last 30 days: a bar a day, then texts, calls, emails and AI replies. */
export function ActivitySection({ glance, heading }: { glance: Glance; heading?: GlanceHeading }) {
  const total = glance.activity.reduce((a, n) => a + n, 0);
  const bars = deskActivityBars(glance.activity);
  return (
    <GlanceSection
      title={DESK_QUICK_LOOK_WORDS.lastThirtyDays}
      aside={DESK_QUICK_LOOK_WORDS.activityTotal(total)}
      heading={heading}
    >
      <div
        role="img"
        aria-label={DESK_QUICK_LOOK_WORDS.activityChart(total)}
        className="mt-3 flex h-14 items-end gap-[3px]"
      >
        {bars.map((share, i) => (
          <span
            key={i}
            className={cn(
              'flex-1 rounded-[2px]',
              share === 0 ? 'bg-card-3' : i === bars.length - 1 ? 'bg-accent' : 'bg-accent-soft-2',
            )}
            style={{ height: `${Math.max(4, Math.round(share * 100))}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-text-3">
        <span>{DESK_QUICK_LOOK_WORDS.thirtyDaysAgo}</span>
        <span>{DESK_QUICK_LOOK_WORDS.today}</span>
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-2">
        {deskTrafficLines(glance.traffic).map((t) => (
          <div key={t.label}>
            <dt className="text-xs text-text-3">{t.label}</dt>
            <dd className="text-[15px] font-semibold tabular-nums">{t.value}</dd>
          </div>
        ))}
      </dl>
    </GlanceSection>
  );
}

/** What is set up as a short list with a dot each, for beside the numbers. */
export function SetupDots({ setup }: { setup: readonly DeskSetupRow[] }) {
  return (
    <ul className="mt-3 flex flex-col gap-2 text-[13px]">
      {setup.map((s) => (
        <li key={s.key} className="flex items-center gap-2">
          <span aria-hidden className={cn('h-2 w-2 flex-none rounded-full', SETUP_DOT[s.state])} />
          <span className="flex-none">{s.label}</span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-right',
              s.state === 'problem' ? 'text-danger-text' : 'text-text-3',
            )}
          >
            {s.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What is set up in full: each thing, how it is connected, and whether it works. */
export function SetupRows({ setup }: { setup: readonly DeskSetupRow[] }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
      {setup.map((s) => (
        <li
          key={s.key}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13px]"
        >
          <span className="w-48 flex-none font-semibold">{s.label}</span>
          <span className="min-w-0 flex-1 basis-40 text-text-2">{s.detail}</span>
          <Badge variant={SETUP_BADGE[s.state]}>{DESK_SETUP_STATE_WORDS[s.state]}</Badge>
        </li>
      ))}
    </ul>
  );
}

/** Money their own customers paid them, which is theirs, never ours. */
export function TheirMoneySection({
  glance,
  heading,
}: {
  glance: Glance;
  heading?: GlanceHeading;
}) {
  return (
    <GlanceSection title={DESK_QUICK_LOOK_WORDS.whatCustomersPayThem} heading={heading}>
      <p className="mt-1 text-xs text-text-3">
        {DESK_QUICK_LOOK_WORDS.whatCustomersPayThemExplain}
      </p>
      <GlanceLines lines={deskTheirMoneyLines(glance)} />
    </GlanceSection>
  );
}

export function MoreAboutThem({
  lines,
  className,
}: {
  lines: readonly { readonly label: string; readonly value: string }[];
  className?: string;
}) {
  return (
    <dl className={cn('mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3', className)}>
      {lines.map((m) => (
        <div key={m.label}>
          <dt className="text-xs text-text-3">{m.label}</dt>
          <dd className="mt-0.5 text-[13px]">{m.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Their last few problem reports, each a link to it, and whether somebody has handled it. */
export function ProblemReportsSection({
  glance,
  heading,
}: {
  glance: Glance;
  heading?: GlanceHeading;
}) {
  const reports = glance.problemReports.recent;
  return (
    <GlanceSection title={DESK_QUICK_LOOK_WORDS.problemReports} heading={heading}>
      {reports.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">{DESK_QUICK_LOOK_WORDS.noProblemReports}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2 text-[13px]">
          {reports.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
              <Link
                href={`/admin/problems/${r.id}`}
                className="min-w-0 flex-1 hover:text-accent-text"
              >
                {deskProblemReportLine(r)}
              </Link>
              <span className="text-xs text-text-3">{deskActiveAgo(r.createdAt)}</span>
              <Badge variant={r.handled ? 'ok' : 'pending'}>
                {r.handled ? DESK_QUICK_LOOK_WORDS.handled : DESK_QUICK_LOOK_WORDS.notHandled}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </GlanceSection>
  );
}
