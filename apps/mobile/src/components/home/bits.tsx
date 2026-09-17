import type {
  AttentionKind,
  CardChip,
  CardChipIcon,
  CardChipTone,
  HandleIcon,
  LetHandleMode,
} from '@hfos/core';
import { LET_HANDLE_MODE_LABELS } from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useAiColors } from '@/components/drafts';
import {
  CalendarClock,
  CalendarPlus,
  Check,
  ChevronDown,
  Clock,
  FileText,
  Flame,
  Hourglass,
  ListChecks,
  Mail,
  MessageCircle,
  Phone,
  Receipt,
  Send,
  ShieldCheck,
  Sparkles,
  UserPlus,
  UserRound,
  Zap,
} from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeName } from '@/theme';

/**
 * The Action Center's small parts at phone size, as the web draws them (`components/home/attention-bits.tsx`): the
 * kind's square, the reason chips, whose it is, the section heads, a sheet's rows and a folded section.
 */

/** The web's teal for "Not confirmed" (`BR_SOFT`, `BR_TEXT`), mixed as the web mixes it. */
const TEAL = {
  light: { soft: '#e2ecf0', text: '#1d586e' },
  dark: { soft: '#1c2731', text: '#619aaf' },
} as const;

type Tone = 'danger' | 'accent' | 'gray' | 'teal' | 'ai' | 'warning';

const KIND_LOOK: Readonly<
  Record<AttentionKind, { readonly icon: LucideIcon; readonly tone: Tone }>
> = {
  hot_lead: { icon: Flame, tone: 'danger' },
  unanswered_lead: { icon: UserPlus, tone: 'accent' },
  stale_opportunity: { icon: Hourglass, tone: 'gray' },
  missing_next_action: { icon: Hourglass, tone: 'gray' },
  unconfirmed_appointment: { icon: CalendarClock, tone: 'teal' },
  ai_approval: { icon: Sparkles, tone: 'ai' },
  customer_waiting: { icon: MessageCircle, tone: 'warning' },
  overdue_task: { icon: ListChecks, tone: 'warning' },
  estimate_waiting: { icon: FileText, tone: 'warning' },
  invoice_overdue: { icon: Receipt, tone: 'danger' },
};

const TONE_CLASS: Readonly<Partial<Record<Tone, { bg: string; fg: string }>>> = {
  danger: { bg: 'bg-danger-soft', fg: 'text-danger-text' },
  accent: { bg: 'bg-accent-soft', fg: 'text-accent-text' },
  gray: { bg: 'bg-card-2', fg: 'text-text-2' },
  warning: { bg: 'bg-warning-soft', fg: 'text-warning-text' },
};

/** A tone's colours: classes for the kit's tokens, values for the web's mixes the tokens don't have. */
function useTone(tone: Tone): { bg?: string; fg?: string; style?: { bg: string; fg: string } } {
  const ai = useAiColors();
  const theme = useThemeName();
  if (tone === 'ai') return { style: { bg: ai.soft, fg: ai.text } };
  if (tone === 'teal') return { style: { bg: TEAL[theme].soft, fg: TEAL[theme].text } };
  return TONE_CLASS[tone]!;
}

const TILE = {
  sm: { box: 'size-6 rounded-[7px]', icon: 13, iconClass: 'size-[13px]' },
  md: { box: 'size-[30px] rounded-control', icon: 15, iconClass: 'size-[15px]' },
  lg: { box: 'size-[38px] rounded-menu', icon: 18, iconClass: 'size-[18px]' },
} as const;

/** The kind's square: a flame for a hot lead, a calendar for a visit not confirmed, and so on. */
export function KindTile({ kind, size = 'md' }: { kind: AttentionKind; size?: keyof typeof TILE }) {
  const look = KIND_LOOK[kind];
  const tone = useTone(look.tone);
  const t = TILE[size];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn('shrink-0 items-center justify-center', t.box, tone.bg)}
      style={tone.style ? { backgroundColor: tone.style.bg } : undefined}
    >
      {tone.style ? (
        <look.icon size={t.icon} color={tone.style.fg} strokeWidth={1.75} />
      ) : (
        <Icon as={look.icon} strokeWidth={1.75} className={cn(t.iconClass, tone.fg)} />
      )}
    </View>
  );
}

/** The kind label's colour where it isn't grey: hot leads in red, approvals in the AI teammate's violet. */
export function KindLabel({ kind, children }: { kind: AttentionKind; children: string }) {
  const ai = useAiColors();
  return (
    <Text
      numberOfLines={1}
      className={cn(
        'shrink-0 text-[11.5px] font-semibold',
        kind === 'hot_lead' ? 'text-danger-text' : kind === 'ai_approval' ? '' : 'text-text-3',
      )}
      style={kind === 'ai_approval' ? { color: ai.text } : undefined}
    >
      {children}
    </Text>
  );
}

const CHIP_TONE: Readonly<Record<Exclude<CardChipTone, 'ai'>, { bg: string; fg: string }>> = {
  plain: { bg: 'bg-card-2', fg: 'text-text-2' },
  money: { bg: 'bg-card-2', fg: 'font-semibold text-text' },
  est: { bg: 'bg-card-2', fg: 'text-text-3' },
  time: { bg: 'bg-warning-soft', fg: 'text-warning-text' },
  late: { bg: 'bg-danger-soft', fg: 'text-danger-text' },
  good: { bg: 'bg-success-soft', fg: 'text-success-text' },
  auto: { bg: 'bg-accent-soft', fg: 'text-accent-text' },
};
const CHIP_ICON: Readonly<Record<Exclude<CardChipIcon, null>, LucideIcon>> = {
  clock: Clock,
  check: Check,
  ai: Sparkles,
  auto: Zap,
};

/** One reason chip: "$18,500", "Waiting 11 min", "Qualified". */
export function ReasonChip({ chip }: { chip: Pick<CardChip, 'text' | 'tone' | 'icon'> }) {
  const ai = useAiColors();
  const ChipIcon = chip.icon ? CHIP_ICON[chip.icon] : null;
  if (chip.tone === 'ai')
    return (
      <View
        testID="attention-chip"
        className="h-[22px] flex-row items-center gap-1 rounded-[6px] px-[7px]"
        style={{ backgroundColor: ai.soft }}
      >
        {ChipIcon ? <ChipIcon size={12} color={ai.text} strokeWidth={1.75} /> : null}
        <Text className="text-xs font-medium" style={{ color: ai.text }}>
          {chip.text}
        </Text>
      </View>
    );
  const tone = CHIP_TONE[chip.tone];
  return (
    <View
      testID="attention-chip"
      className={cn('h-[22px] flex-row items-center gap-1 rounded-[6px] px-[7px]', tone.bg)}
    >
      {ChipIcon ? (
        <Icon as={ChipIcon} strokeWidth={1.75} className={cn('size-3', tone.fg)} />
      ) : null}
      <Text className={cn('text-xs font-medium', tone.fg)}>{chip.text}</Text>
    </View>
  );
}

export function Chips({ chips }: { chips: readonly CardChip[] }) {
  return (
    <View className="flex-row flex-wrap items-center gap-[5px]">
      {chips.map((c) => (
        <ReasonChip key={c.key} chip={c} />
      ))}
    </View>
  );
}

/** Whose it is: their initials, or a dashed ring when nobody has it. */
export function AssigneeMark({ assignee }: { assignee: { id: string; fullName: string } | null }) {
  if (!assignee)
    return (
      <View
        accessibilityLabel="Unassigned"
        className="size-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-border-strong"
      >
        <Icon as={UserRound} strokeWidth={1.75} className="size-3 text-text-3" />
      </View>
    );
  return (
    <View accessibilityLabel={`Assigned to ${assignee.fullName}`} testID="attention-assignee">
      <Avatar name={assignee.fullName} seed={assignee.id} size="sm" />
    </View>
  );
}

export const HANDLE_ICONS: Readonly<Record<HandleIcon, LucideIcon>> = {
  phone: Phone,
  mail: Mail,
  send: Send,
  message: MessageCircle,
  'calendar-plus': CalendarPlus,
  check: Check,
  'list-checks': ListChecks,
  receipt: Receipt,
  'file-text': FileText,
};

const MODE: Readonly<Record<LetHandleMode, { icon: LucideIcon; bg: string; fg: string }>> = {
  auto: { icon: Zap, bg: 'bg-accent-soft', fg: 'text-accent-text' },
  ask: { icon: ShieldCheck, bg: 'bg-warning-soft', fg: 'text-warning-text' },
  none: { icon: UserRound, bg: 'bg-card-2', fg: 'text-text-2' },
};

/** How Let HandsFreeOS Handle works for an item: on its own, asks first, or always a person. */
export function ModeChip({ mode }: { mode: LetHandleMode }) {
  const m = MODE[mode];
  return (
    <View
      className={cn('h-[22px] flex-row items-center gap-[5px] self-start rounded-[6px] px-2', m.bg)}
      testID="let-handle-mode"
    >
      <Icon as={m.icon} strokeWidth={1.75} className={cn('size-3', m.fg)} />
      <Text className={cn('text-xs font-semibold', m.fg)}>{LET_HANDLE_MODE_LABELS[mode]}</Text>
    </View>
  );
}

/** "URGENT 2" and "UP NEXT 7" above the lists. */
export function SectionHead({
  label,
  count,
  urgent,
  testID,
}: {
  label: string;
  count?: number;
  urgent?: boolean;
  testID?: string;
}) {
  return (
    <View className="mb-2 ml-0.5 flex-row items-center gap-2" testID={testID}>
      {urgent ? <View className="size-2 rounded-full bg-danger" /> : null}
      <Text
        role="heading"
        className={cn(
          'text-xs font-semibold uppercase tracking-[0.5px]',
          urgent ? 'text-danger-text' : 'text-text-3',
        )}
      >
        {label}
      </Text>
      {count !== undefined ? (
        <Text className="text-xs font-medium text-text-3">{count}</Text>
      ) : null}
    </View>
  );
}

/** A 52 px row in a bottom sheet: an action, or a link. */
export function SheetRow({
  icon,
  label,
  hint,
  danger,
  onPress,
  testID,
  first,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  danger?: boolean;
  onPress: () => void;
  testID?: string;
  first?: boolean;
}) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      testID={testID}
      className={cn(
        'min-h-[52px] flex-row items-center gap-3 px-1 py-1.5 active:bg-card-2',
        !first && 'border-t border-border',
      )}
    >
      <Icon as={icon} className={cn('size-5', danger ? 'text-danger-text' : 'text-text')} />
      <Text className={cn('min-w-0 flex-1 text-[15px]', danger && 'text-danger-text')}>
        {label}
      </Text>
      {hint ? <Text className="text-[13px] text-text-3">{hint}</Text> : null}
    </Pressable>
  );
}

/** "SNOOZE", "MORE": a group's label in a sheet. */
export function SheetLabel({ children }: { children: string }) {
  return (
    <Text className="px-1 pb-0.5 pt-2.5 text-[11.5px] font-semibold uppercase tracking-[0.5px] text-text-3">
      {children}
    </Text>
  );
}

/** A folded section (Handled by HandsFreeOS): tap to open it in place. */
export function FoldButton({
  open,
  onToggle,
  icon,
  title,
  sub,
  badge,
  testID,
}: {
  open: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  title: string;
  sub?: string | null;
  badge?: React.ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      testID={testID}
      className={cn(
        'min-h-14 flex-row items-center gap-2.5 rounded-card border border-border-strong bg-card px-3.5 py-[11px] active:bg-card-2',
        open && 'rounded-b-none border-b-0',
      )}
    >
      {icon}
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-medium">{title}</Text>
        {sub ? (
          <Text numberOfLines={1} className="text-xs text-text-3">
            {sub}
          </Text>
        ) : null}
      </View>
      {badge}
      <View style={open ? { transform: [{ rotate: '180deg' }] } : undefined}>
        <Icon as={ChevronDown} strokeWidth={1.75} className="size-4 text-text-3" />
      </View>
    </Pressable>
  );
}
