import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import {
  Ban,
  Check,
  CircleAlert,
  CirclePause,
  CircleDollarSign,
  Clock,
  CalendarDays,
  CloudUpload,
  Image,
  Inbox,
  ListTodo,
  MessageCircle,
  Moon,
  Pencil,
  Sparkles,
  SquareKanban,
  StickyNote,
  Tag,
  UserPen,
  UserPlus,
} from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { ChangeIcon } from '@/changes/describe';
import { cn } from '@/lib/utils';

/** The pieces Changes on this phone and its sheets are drawn with (the canvas's Offline board). */

export const CHANGE_ICONS: Record<ChangeIcon, LucideIcon> = {
  text: MessageCircle,
  email: MessageCircle,
  note: StickyNote,
  newPerson: UserPlus,
  person: UserPen,
  lead: SquareKanban,
  photo: Image,
  task: ListTodo,
  tag: Tag,
  calendar: CalendarDays,
  money: CircleDollarSign,
  inbox: Inbox,
  item: Sparkles,
  change: Pencil,
};

export type PillTone = 'wait' | 'sending' | 'sent' | 'held' | 'refused' | 'ask' | 'quiet';

const PILLS: Record<PillTone, { box: string; text: string; icon: LucideIcon }> = {
  wait: { box: 'bg-card-2', text: 'text-text-2', icon: Clock },
  sending: { box: 'bg-accent-soft', text: 'text-accent-text', icon: CloudUpload },
  sent: { box: 'bg-success-soft', text: 'text-success-text', icon: Check },
  held: { box: 'bg-warning-soft', text: 'text-warning-text', icon: CirclePause },
  refused: { box: 'bg-danger-soft', text: 'text-danger-text', icon: Ban },
  ask: { box: 'bg-accent-soft', text: 'text-accent-text', icon: CircleAlert },
  quiet: { box: 'bg-warning-soft', text: 'text-warning-text', icon: Moon },
};

/** "Still send?", "Refused", "Held", "Waiting", "Sent": where a change stands, in its colour. */
export function StatePill({
  tone,
  children,
  testID,
}: {
  tone: PillTone;
  children: string;
  testID?: string;
}) {
  const pill = PILLS[tone];
  return (
    <View
      className={cn('h-6 shrink-0 flex-row items-center gap-[5px] rounded-md px-2', pill.box)}
      testID={testID}
    >
      <Icon as={pill.icon} className={cn('size-[13px]', pill.text)} strokeWidth={1.75} />
      <Text className={cn('text-[12.5px] font-semibold', pill.text)}>{children}</Text>
    </View>
  );
}

/** The square icon at the start of a change's row. */
export function ChangeTile({
  icon,
  tone = 'plain',
}: {
  icon: LucideIcon;
  tone?: 'plain' | 'sent';
}) {
  return (
    <View
      className={cn(
        'size-[34px] items-center justify-center rounded-[9px]',
        tone === 'sent' ? 'bg-success-soft' : 'bg-card-2',
      )}
    >
      <Icon
        as={icon}
        className={cn('size-[17px]', tone === 'sent' ? 'text-success-text' : 'text-text-2')}
      />
    </View>
  );
}

/** Why a change is held or refused, on its tone. */
export function WhyBox({
  tone,
  children,
  testID,
}: {
  tone: 'bad' | 'hold' | 'plain';
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View
      className={cn(
        'mt-1.5 rounded-[9px] px-[11px] py-[9px]',
        tone === 'bad' ? 'bg-danger-soft' : tone === 'hold' ? 'bg-warning-soft' : 'bg-card-2',
      )}
      testID={testID}
    >
      <Text
        className={cn(
          'text-[13px] leading-[19px]',
          tone === 'bad'
            ? 'text-danger-text'
            : tone === 'hold'
              ? 'text-warning-text'
              : 'text-text-2',
        )}
      >
        {children}
      </Text>
    </View>
  );
}

/** A photo's upload so far. */
export function ProgressBar({ fraction }: { fraction: number }) {
  const percent = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <View className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-card-3">
      <View className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
    </View>
  );
}

/** The tile at the top left of a sheet that asks something. */
export function SheetTile({
  icon,
  tone,
}: {
  icon: LucideIcon;
  tone: 'accent' | 'warning' | 'danger';
}) {
  return (
    <View
      className={cn(
        'size-[38px] items-center justify-center rounded-[10px]',
        tone === 'accent'
          ? 'bg-accent-soft'
          : tone === 'warning'
            ? 'bg-warning-soft'
            : 'bg-danger-soft',
      )}
    >
      <Icon
        as={icon}
        className={cn(
          'size-[18px]',
          tone === 'accent'
            ? 'text-accent-text'
            : tone === 'warning'
              ? 'text-warning-text'
              : 'text-danger-text',
        )}
      />
    </View>
  );
}

/** What was written, as the person wrote it. */
export function Well({ children, testID }: { children: string; testID?: string }) {
  return (
    <View className="mt-3.5 rounded-[10px] bg-card-2 px-3 py-2.5" testID={testID}>
      <Text className="text-[15px] leading-[22px]">{children}</Text>
    </View>
  );
}
