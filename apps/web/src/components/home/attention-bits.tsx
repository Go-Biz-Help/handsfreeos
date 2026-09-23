import { LET_HANDLE_MODE_LABELS, type AttentionKind } from '@hfos/core';
import {
  BadgeDollarSign,
  BellOff,
  CalendarClock,
  CircleHelp,
  EyeOff,
  Globe,
  GraduationCap,
  Unplug,
  WifiOff,
  ChartLine,
  Handshake,
  UserMinus,
  Check,
  ChevronDown,
  ClipboardCheck,
  ClipboardX,
  Clock,
  MapPinOff,
  Signpost,
  Wrench,
  CreditCard,
  FileText,
  Flame,
  Heart,
  Hourglass,
  ListChecks,
  MessageCircle,
  Receipt,
  ShieldCheck,
  Sparkles,
  UserPlus,
  UserRound,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { AI_SOFT, AI_TEXT, BR_SOFT, BR_TEXT } from '@/components/workflows/chips';
import { cn } from '@/lib/utils';
import type { ChipIcon, ChipTone, ShownChip } from './attention-words';

const KIND_LOOK: Readonly<
  Record<AttentionKind, { readonly icon: LucideIcon; readonly tile: string }>
> = {
  hot_lead: { icon: Flame, tile: 'bg-danger-soft text-danger-text' },
  unanswered_lead: { icon: UserPlus, tile: 'bg-accent-soft text-accent-text' },
  stale_opportunity: { icon: Hourglass, tile: 'bg-card-2 text-text-2' },
  missing_next_action: { icon: Hourglass, tile: 'bg-card-2 text-text-2' },
  unconfirmed_appointment: { icon: CalendarClock, tile: cn(BR_SOFT, BR_TEXT) },
  ai_approval: { icon: Sparkles, tile: cn(AI_SOFT, AI_TEXT) },
  customer_waiting: { icon: MessageCircle, tile: 'bg-warning-soft text-warning-text' },
  overdue_task: { icon: ListChecks, tile: 'bg-warning-soft text-warning-text' },
  estimate_waiting: { icon: FileText, tile: 'bg-warning-soft text-warning-text' },
  invoice_overdue: { icon: Receipt, tile: 'bg-danger-soft text-danger-text' },
  wallet_low: { icon: Wallet, tile: 'bg-warning-soft text-warning-text' },
  wallet_empty: { icon: Wallet, tile: 'bg-danger-soft text-danger-text' },
  wallet_card_declined: { icon: CreditCard, tile: 'bg-danger-soft text-danger-text' },
  job_not_thanked: { icon: Heart, tile: 'bg-accent-soft text-accent-text' },
  referral_mentioned: { icon: UserPlus, tile: 'bg-accent-soft text-accent-text' },
  maintenance_due: { icon: Wrench, tile: cn(BR_SOFT, BR_TEXT) },
  pipeline_mismatch: { icon: Signpost, tile: 'bg-card-2 text-text-2' },
  quiet_after_price: { icon: BadgeDollarSign, tile: 'bg-warning-soft text-warning-text' },
  job_unconfirmed: { icon: ClipboardCheck, tile: cn(BR_SOFT, BR_TEXT) },
  job_never_completed: { icon: ClipboardX, tile: 'bg-warning-soft text-warning-text' },
  job_no_address: { icon: MapPinOff, tile: 'bg-warning-soft text-warning-text' },
  client_quiet: { icon: UserMinus, tile: 'bg-card-2 text-text-2' },
  promise_due: { icon: Handshake, tile: 'bg-warning-soft text-warning-text' },
  revenue_moved: { icon: ChartLine, tile: 'bg-accent-soft text-accent-text' },
  channel_quiet: { icon: BellOff, tile: 'bg-warning-soft text-warning-text' },
  connection_error: { icon: Unplug, tile: 'bg-danger-soft text-danger-text' },
  connection_silent: { icon: WifiOff, tile: 'bg-warning-soft text-warning-text' },
  ai_unreviewed: { icon: EyeOff, tile: cn(AI_SOFT, AI_TEXT) },
  ai_corrections: { icon: GraduationCap, tile: cn(AI_SOFT, AI_TEXT) },
  website_changed: { icon: Globe, tile: 'bg-accent-soft text-accent-text' },
  faq_suggestions: { icon: CircleHelp, tile: cn(AI_SOFT, AI_TEXT) },
};

/** The kind label's colour where it isn't grey: hot leads in red, approvals in the AI teammate's violet. */
export const KIND_LABEL_TONE: Readonly<Partial<Record<AttentionKind, string>>> = {
  hot_lead: 'text-danger-text',
  ai_approval: AI_TEXT,
};

const TILE = {
  sm: 'h-6 w-6 rounded-[7px]',
  md: 'h-[30px] w-[30px] rounded-control',
  lg: 'h-[38px] w-[38px] rounded-menu',
} as const;
const TILE_ICON = { sm: 'h-[13px] w-[13px]', md: 'h-[15px] w-[15px]', lg: 'h-[18px] w-[18px]' };

/** The kind's square: a flame for a hot lead, a calendar for a visit not confirmed, and so on. */
export function KindTile({
  kind,
  size = 'md',
  className,
}: {
  kind: AttentionKind;
  size?: keyof typeof TILE;
  className?: string;
}) {
  const look = KIND_LOOK[kind];
  const Icon = look.icon;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center',
        TILE[size],
        look.tile,
        className,
      )}
    >
      <Icon className={TILE_ICON[size]} strokeWidth={1.75} />
    </span>
  );
}

const TONE: Readonly<Record<ChipTone, string>> = {
  plain: 'bg-card-2 text-text-2',
  money: 'bg-card-2 font-semibold tabular-nums text-text',
  est: 'bg-card-2 text-text-3',
  time: 'bg-warning-soft text-warning-text',
  late: 'bg-danger-soft text-danger-text',
  good: 'bg-success-soft text-success-text',
  ai: cn(AI_SOFT, AI_TEXT),
  auto: 'bg-accent-soft text-accent-text',
};
const CHIP_ICON: Readonly<Record<Exclude<ChipIcon, null>, LucideIcon>> = {
  clock: Clock,
  check: Check,
  ai: Sparkles,
  auto: Zap,
};

/** One reason chip: "$18,500", "Waiting 11 min", "Qualified". */
export function ReasonChip({ chip, className }: { chip: ShownChip; className?: string }) {
  const Icon = chip.icon ? CHIP_ICON[chip.icon] : null;
  return (
    <span
      title={chip.title}
      data-testid="attention-chip"
      className={cn(
        'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-xs font-medium',
        TONE[chip.tone],
        className,
      )}
    >
      {Icon ? <Icon className="h-3 w-3 flex-none" strokeWidth={1.75} /> : null}
      {chip.text}
    </span>
  );
}

export function Chips({ chips, className }: { chips: readonly ShownChip[]; className?: string }) {
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-[5px]', className)}>
      {chips.map((c) => (
        <ReasonChip key={c.key} chip={c} />
      ))}
    </span>
  );
}

/** Whose it is: their initials, or a dashed ring when nobody has it. */
export function AssigneeMark({ assignee }: { assignee: { id: string; fullName: string } | null }) {
  if (!assignee)
    return (
      <span
        role="img"
        aria-label="Unassigned"
        title="Unassigned"
        className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full border-[1.5px] border-dashed border-border-strong text-text-3"
      >
        <UserRound className="h-3 w-3" strokeWidth={1.75} />
      </span>
    );
  return (
    <span
      role="img"
      aria-label={`Assigned to ${assignee.fullName}`}
      title={assignee.fullName}
      data-testid="attention-assignee"
      className="inline-flex flex-none"
    >
      <Avatar name={assignee.fullName} seed={assignee.id} size="sm" />
    </span>
  );
}

const MODE = {
  auto: { label: LET_HANDLE_MODE_LABELS.auto, icon: Zap, tone: 'bg-accent-soft text-accent-text' },
  ask: {
    label: LET_HANDLE_MODE_LABELS.ask,
    icon: ShieldCheck,
    tone: 'bg-warning-soft text-warning-text',
  },
  none: { label: LET_HANDLE_MODE_LABELS.none, icon: UserRound, tone: 'bg-card-2 text-text-2' },
} as const;

/** How Let HandsFreeOS Handle works for an item: on its own, asks first, or always a person. */
export function ModeChip({ mode }: { mode: keyof typeof MODE }) {
  const m = MODE[mode];
  const Icon = m.icon;
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-[6px] px-2 text-xs font-semibold',
        m.tone,
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={1.75} />
      {m.label}
    </span>
  );
}

/** "URGENT 2" and "UP NEXT 7" above the lists. */
export function SectionHead({
  label,
  count,
  urgent,
  className,
}: {
  label: string;
  count?: number;
  urgent?: boolean;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        'mb-2 ml-0.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.04em]',
        urgent ? 'text-danger-text' : 'text-text-3',
        className,
      )}
    >
      {urgent ? <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-danger" /> : null}
      {label}
      {count !== undefined ? (
        <span className="font-medium normal-case tracking-normal text-text-3">{count}</span>
      ) : null}
    </h2>
  );
}

/** A 52 px row in a phone's bottom sheet: an action, or a link. */
export function SheetRow({
  icon: Icon,
  label,
  hint,
  danger,
  onClick,
  href,
  testId,
}: {
  icon: LucideIcon;
  label: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  onClick?: () => void;
  href?: string;
  testId?: string;
}) {
  const cls = cn(
    'flex min-h-[52px] w-full items-center gap-3 border-t border-border px-1 py-1.5 text-left text-[15px]',
    danger ? 'text-danger-text' : 'text-text',
  );
  const inner = (
    <>
      <Icon className="h-5 w-5 flex-none" strokeWidth={1.5} />
      <span className="min-w-0 flex-1">{label}</span>
      {hint ? <span className="flex-none text-[13px] text-text-3">{hint}</span> : null}
    </>
  );
  return href ? (
    <Link href={href} className={cls} data-testid={testId}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls} data-testid={testId}>
      {inner}
    </button>
  );
}

/** A phone's folded section (Today, Coming up, Handled): tap to open it in place. */
export function FoldButton({
  open,
  onToggle,
  icon,
  title,
  sub,
  badge,
  testId,
}: {
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  title: string;
  sub?: string | null;
  badge?: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      data-testid={testId}
      className={cn(
        'flex min-h-14 w-full items-center gap-2.5 rounded-card border border-border-strong bg-card px-3.5 py-[11px] text-left',
        open && 'rounded-b-none border-b-0',
      )}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[15px] font-medium text-text">{title}</span>
        {sub ? <span className="truncate text-xs text-text-3">{sub}</span> : null}
      </span>
      {badge}
      <ChevronDown
        className={cn('h-4 w-4 flex-none text-text-3 transition-transform', open && 'rotate-180')}
        strokeWidth={1.75}
      />
    </button>
  );
}
