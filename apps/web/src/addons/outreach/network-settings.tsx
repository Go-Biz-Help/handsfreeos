'use client';
/**
 * The parts of a network's page in Settings that decision 170 brought (docs/outreach.md; the owner, 16 Nov 2026: "let’s
 * do this redesign for all of the platforms"): the status card at the top, which says what the extension is really
 * doing there (`networkStatus`), How hands-off? in place of the Sending, Replies and helpful posts lists
 * (`withHandsOff`), and More settings, folded, for the rest. Settings → You has How hands-off on every network.
 */
import type { BusinessRules } from '@hfos/core/addons/outreach/automation';
import {
  HANDS_OFF_KEYS,
  HANDS_OFF_WORDS as H,
  handsOffAllowed,
  NETWORK_PAGE_WORDS as P,
  type HandsOff,
} from '@hfos/core/addons/outreach/hands-off';
import {
  NETWORK_STATUS_WORDS as NS,
  networkTone,
  type NetworkStatus,
} from '@hfos/core/addons/outreach/network-status';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { SETTINGS_PAGE_WORDS as S } from '@hfos/core/addons/outreach/settings-pages';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Hand, PauseCircle } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';

const TONE: Record<ReturnType<typeof networkTone>, { icon: string; chip: string }> = {
  good: { icon: 'bg-success-soft text-success-text', chip: 'bg-success-soft text-success-text' },
  waiting: { icon: 'bg-accent-soft text-accent-text', chip: 'bg-accent-soft text-accent-text' },
  warn: { icon: 'bg-warning-soft text-warning-text', chip: 'bg-warning-soft text-warning-text' },
  plain: { icon: 'bg-card-2 text-text-2', chip: 'bg-card-2 text-text-2' },
};

const ICON = {
  running: CheckCircle2,
  waiting: Hand,
  stuck: AlertTriangle,
  stopped: PauseCircle,
  resting: Clock,
  yours: Hand,
} as const;

/** Where the card's button goes, and what it says. */
function actOf(
  workspaceId: string,
  platform: Platform,
  act: NetworkStatus['act'],
): { href: string; label: string } | null {
  switch (act) {
    case 'review':
      return { href: outreachHref(workspaceId, { view: 'needs' }), label: NS.review };
    case 'people':
      return { href: outreachHref(workspaceId, { view: 'needs' }), label: NS.people };
    case 'computer':
      return {
        href: outreachHref(workspaceId, { view: 'settings', part: 'computer' }),
        label: NS.computer,
      };
    case 'today':
      return { href: outreachHref(workspaceId, { view: 'today', net: platform }), label: NS.today };
    default:
      return null;
  }
}

/**
 * The status card (decision 170): one of a few states, with what's going on and whether the person needs to do
 * anything, and a button when there's something to do. Today's link shows what happened there.
 */
export function NetworkStatusCard({
  workspaceId,
  platform,
  status,
  testId,
}: {
  workspaceId: string;
  platform: Platform;
  status: NetworkStatus;
  testId: string;
}) {
  const tone = TONE[networkTone(status.state)];
  const Icon = ICON[status.state];
  const act = actOf(workspaceId, platform, status.act);
  return (
    <Card
      className="space-y-3 px-[22px] py-5 max-md:px-4 max-md:py-4"
      data-testid={testId}
      data-state={status.state}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px]',
            tone.icon,
          )}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3
              className="text-[16px] font-semibold tracking-tight"
              data-testid={`${testId}-title`}
            >
              {status.title}
            </h3>
            <span
              className={cn(
                'whitespace-nowrap rounded-[6px] px-2 py-0.5 text-[12px] font-semibold',
                tone.chip,
              )}
              data-testid={`${testId}-chip`}
            >
              {status.chip}
            </span>
          </div>
          <p className="text-[13.5px] text-text-2" data-testid={`${testId}-line`}>
            {status.line}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {act ? (
          <ButtonLink size="sm" variant="secondary" href={act.href} data-testid={`${testId}-act`}>
            {act.label}
          </ButtonLink>
        ) : null}
        <Link
          href={outreachHref(workspaceId, { view: 'today', net: platform })}
          className="text-[13px] font-medium text-accent-text hover:underline"
          data-testid={`${testId}-today`}
        >
          {NS.seeWhat}
        </Link>
      </div>
    </Card>
  );
}

/**
 * How hands-off? (decision 170): four buttons, safest first, with a line under the one picked. A level the business
 * doesn't allow can't be pressed, and says so; choices that match none read as the person's own mix.
 */
export function HandsOffPart({
  platform,
  level,
  onPick,
  rules,
  canManage,
  title = H.title,
  about,
  note,
  testId,
  children,
}: {
  /** The network it's for, for the line's words; null on Settings → You. */
  platform: Platform | null;
  level: HandsOff | null;
  onPick: (level: HandsOff) => void;
  rules: Pick<BusinessRules, 'sendingAllowed' | 'repliesAllowed' | 'autopilotAllowed'>;
  canManage: boolean;
  title?: string;
  about?: string;
  /** A line under it: training wheels, or Autopilot on for every network. */
  note?: string | null;
  testId: string;
  /** Under the buttons on Settings → You: each level and the networks at it. */
  children?: React.ReactNode;
}) {
  const label = useId();
  // Not allowed, but picked now: it shows, so it can be left.
  const shown = HANDS_OFF_KEYS.filter((l) => handsOffAllowed(l, rules) || l === level);
  const hidden = HANDS_OFF_KEYS.filter((l) => !shown.includes(l));
  return (
    <Card className="space-y-3.5 px-[22px] py-5 max-md:px-4 max-md:py-4" data-testid={testId}>
      <div>
        <h3 id={label} className="text-[16px] font-semibold tracking-tight">
          {title}
        </h3>
        {about ? <p className="mt-1 text-[13px] text-text-2">{about}</p> : null}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={label}
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        data-testid={`${testId}-levels`}
      >
        {shown.map((l) => {
          const picked = level === l;
          const allowed = handsOffAllowed(l, rules);
          return (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={picked}
              disabled={!allowed}
              onClick={() => (picked ? undefined : onPick(l))}
              className={cn(
                'flex min-h-[64px] flex-col items-start justify-center gap-0.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                picked
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-border bg-card hover:bg-card-2',
              )}
              data-testid={`${testId}-${l}`}
            >
              <span className="text-[14px] font-semibold">{H.levels[l]}</span>
              <span className={cn('text-[12px]', picked ? 'text-accent-text' : 'text-text-3')}>
                {H.short[l]}
              </span>
            </button>
          );
        })}
      </div>
      {children}
      <p className="text-[13px] text-text-2" data-testid={`${testId}-about`}>
        {level === null
          ? platform
            ? H.mixAbout
            : H.differs
          : platform
            ? H.about(level, platform)
            : H.about(level, 'facebook')}
      </p>
      {level === null && platform ? (
        <p className="text-[13px] font-medium" data-testid={`${testId}-mix`}>
          {H.mix}
        </p>
      ) : null}
      {note ? (
        <p
          className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2"
          data-testid={`${testId}-note`}
        >
          {note}
        </p>
      ) : null}
      {hidden.length ? (
        <p className="text-[12.5px] text-text-3" data-testid={`${testId}-not-allowed`}>
          {hidden.map((l) => H.notAllowed(l, canManage)).join(' ')}
        </p>
      ) : null}
    </Card>
  );
}

/** More settings (decision 170): folded to start, the rest of a network's choices inside. */
export function MoreSettings({
  name = '',
  helpful = false,
  about,
  testId,
  children,
}: {
  name?: string;
  helpful?: boolean;
  /** Its line while folded, when not a network page's. */
  about?: string;
  testId: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const body = useId();
  return (
    <Card className="px-[22px] py-1 max-md:px-4" data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[56px] w-full items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        data-testid={`${testId}-toggle`}
      >
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold tracking-tight">{P.more}</span>
          {open ? null : (
            <span className="block text-[13px] text-text-2">
              {about ?? P.moreAbout(name, helpful)}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn('h-5 w-5 flex-none text-text-2 transition-transform', open && 'rotate-180')}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={body} className="space-y-5 border-t border-border pb-5 pt-4">
          {children}
        </div>
      ) : null}
    </Card>
  );
}

/** One setting under More settings, or in a card: its title, a line about it, and what to pick. */
export function Row({
  title,
  about,
  testId,
  children,
}: {
  title: string;
  about?: string;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div>
        <h4 className="text-[14px] font-semibold">{title}</h4>
        {about ? <p className="text-[13px] text-text-2">{about}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * A setting on Settings → You, Team or Your computer as a row (decision 170, part 2): its title, how it stands, and
 * what to pick beside it: a switch, a short pick or a button.
 */
export function PickRow({
  title,
  about,
  testId,
  children,
}: {
  title: string;
  about?: React.ReactNode;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
      data-testid={testId}
    >
      <div className="min-w-0 flex-[1_1_240px]">
        <div className="text-[14px] font-medium">{title}</div>
        {about ? <div className="text-[13px] text-text-2">{about}</div> : null}
      </div>
      {children ? (
        <div className="flex flex-none flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * A row that says how a setting stands, with Change to open what sets it under the row, and Done to fold it again.
 * The form inside saves as it's changed, as everything on these pages does.
 */
export function ChangeRow({
  title,
  about,
  testId,
  open: start = false,
  label = S.change,
  children,
}: {
  title: string;
  about?: React.ReactNode;
  testId: string;
  /** Open to start: a problem in it to see. */
  open?: boolean;
  /** The button's word while folded: Change, Limits, Open. */
  label?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(start);
  const body = useId();
  return (
    <div className="py-3 first:pt-0 last:pb-0" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_240px]">
          <div className="text-[14px] font-medium">{title}</div>
          {about ? (
            <div className="text-[13px] text-text-2" data-testid={`${testId}-about`}>
              {about}
            </div>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen((o) => !o)}
          data-testid={`${testId}-toggle`}
        >
          {open ? S.done : label}
        </Button>
      </div>
      {open ? (
        <div id={body} className="mt-3 space-y-4 rounded-[10px] bg-card-2 p-3.5 max-md:p-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A card of rows on Settings → You, Team or Your computer: a title, a line about it, and its rows divided. */
export function RowsCard({
  title,
  about,
  badge,
  testId,
  children,
}: {
  title?: string;
  about?: string;
  badge?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="px-[22px] py-5 max-md:px-4 max-md:py-4" data-testid={testId}>
      {title ? (
        <div className="mb-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-[16px] font-semibold tracking-tight">{title}</h3>
            {badge}
          </div>
          {about ? <p className="mt-0.5 text-[13px] text-text-2">{about}</p> : null}
        </div>
      ) : null}
      <div className="divide-y divide-border">{children}</div>
    </Card>
  );
}
