import { localDateOf, daysBetween, fmtMonthDay, fmtTime, weekdayShort } from '@hfos/core';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { RE_DUTIES_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { CloudOff } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { clockTime, useSyncStatus } from '@/lib/sync-status';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

/**
 * What the deal screens (boards 76–81) share: a deal's health as a dot, where the phone's own changes stand, the
 * strip that says what the phone kept when there's no signal, group labels, chips, choices in a sheet, tabs, and when
 * something is due in a list's words.
 */

export type Health = 'green' | 'yellow' | 'red';

/** Green, amber or red, as the web's HealthDot. */
export function HealthDot({ health, className }: { health: Health; className?: string }) {
  return (
    <View
      accessibilityLabel={
        health === 'red' ? 'At risk' : health === 'yellow' ? 'Needs attention' : 'On track'
      }
      testID={`health-${health}`}
      className={cn(
        'size-2.5 rounded-full',
        health === 'red' ? 'bg-danger' : health === 'yellow' ? 'bg-warning' : 'bg-success',
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------------------------- the phone's own changes

/** One of Real Estate's changes made on this phone, not through yet. */
export interface ReChange {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** waiting, sending, held, ask, refused or retry. */
  readonly state: string;
  readonly rule: string | null;
  readonly madeAt: string;
}

export const RE_OUTBOX_SQL = `
  SELECT id, name, input, state, rule, made_at FROM outbox
  WHERE workspace_id = ? AND name LIKE 'realestate.%' AND state != 'sent'
  ORDER BY seq`;

const parse = (s: unknown): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(String(s ?? ''));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Real Estate's changes on this phone that haven't reached HandsFreeOS: what "waiting to send" marks are made of. */
export function useReChanges(workspaceId: string): readonly ReChange[] {
  const { data } = useQuery<{
    id: string;
    name: string;
    input: string;
    state: string;
    rule: string | null;
    made_at: string;
  }>(RE_OUTBOX_SQL, [workspaceId]);
  return React.useMemo(
    () =>
      data.map((r) => ({
        id: r.id,
        name: r.name,
        input: parse(r.input),
        state: r.state,
        rule: r.rule,
        madeAt: r.made_at,
      })),
    [data],
  );
}

/** The changes of one command about one thing (`dutyId`, `draftId`…). */
export const changesFor = (
  list: readonly ReChange[],
  name: string,
  key: string,
  id: string,
): ReChange[] => list.filter((c) => c.name === name && c.input[key] === id);

// ---------------------------------------------------------------------------------------------- strips

/**
 * "No signal · what this phone kept at 9:41 AM": over a list read from the phone's copy, with no signal. `inset` when it
 * sits in a screen's scrolling content rather than across its top.
 */
export function KeptStrip({ inset }: { inset?: boolean }) {
  const { online } = useNetwork();
  const status = useSyncStatus();
  if (online) return null;
  return (
    <View
      className={cn(
        'flex-row items-center gap-2 border-border bg-card-2 px-3.5 py-2',
        inset ? 'rounded-menu border' : 'border-b',
      )}
      testID="re-kept-strip"
    >
      <Icon as={CloudOff} className="size-4 text-text-3" />
      <Text className="flex-1 text-[13px] text-text-2">
        {status.asOf ? RE_PHONE_WORDS.keptAt(clockTime(status.asOf)) : RE_PHONE_WORDS.noSignal}
      </Text>
    </View>
  );
}

/** "No signal · 3 changes wait on this phone", with the count: over a screen whose changes wait. */
export function WaitStrip({ waiting, inset }: { waiting: number; inset?: boolean }) {
  const { online } = useNetwork();
  if (online) return null;
  return (
    <View
      className={cn(
        'flex-row items-center gap-2 border-border bg-card-2 px-3.5 py-2',
        inset ? 'rounded-menu border' : 'border-b',
      )}
      testID="re-wait-strip"
    >
      <Icon as={CloudOff} className="size-4 text-text-3" />
      <Text className="flex-1 text-[13px] text-text-2">
        {waiting > 0
          ? `${RE_PHONE_WORDS.noSignal} · ${waiting === 1 ? '1 change waits' : `${waiting} changes wait`} on this phone`
          : RE_PHONE_WORDS.noSignal}
      </Text>
      {waiting > 0 ? (
        <Badge variant="pending">
          <Text>{waiting}</Text>
        </Badge>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------- bits

/** "LATE 1", "TODAY 3": a group's label, with how many are in it. */
export function GroupLabel({
  label,
  count,
  tone = 'muted',
  end,
  testID,
}: {
  label: string;
  count?: number;
  tone?: 'muted' | 'danger';
  end?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View className="flex-row items-center justify-between px-1 pt-2" testID={testID}>
      <Text variant="group" className={cn(tone === 'danger' ? 'text-danger-text' : 'text-text-3')}>
        {count === undefined ? label : `${label}  ${count}`}
      </Text>
      {end}
    </View>
  );
}

/** A filter chip: on (accent), off, or a danger one (At risk). */
export function Chip({
  label,
  on,
  danger,
  onPress,
  testID,
}: {
  label: string;
  on: boolean;
  danger?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      testID={testID}
      hitSlop={{ top: 6, bottom: 6 }}
      className={cn(
        'h-[30px] flex-row items-center rounded-full border px-3',
        on
          ? danger
            ? 'border-danger-soft bg-danger-soft'
            : 'border-accent-soft bg-accent-soft'
          : 'border-border-strong bg-card',
      )}
    >
      <Text
        className={cn(
          'text-[13px]',
          on
            ? danger
              ? 'text-danger-text'
              : 'text-accent-text'
            : danger
              ? 'text-danger-text'
              : 'text-text-2',
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** One choice of several in a sheet ("Removed: the buyers go ahead"), picked or not. */
export function Choice({
  label,
  detail,
  picked,
  onPress,
  testID,
}: {
  label: string;
  detail?: string;
  picked: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="radio"
      accessibilityState={{ checked: picked }}
      onPress={onPress}
      testID={testID}
      className={cn(
        'min-h-12 justify-center rounded-menu border px-3.5 py-2.5',
        picked ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
      )}
    >
      <Text className="text-[15px]">{label}</Text>
      {detail ? <Text className="text-[13px] text-text-3">{detail}</Text> : null}
    </Pressable>
  );
}

/** Tabs under a screen's top bar, underlined, scrolling sideways when they don't fit (Coordinate, a deal). */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
  testID,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: readonly { readonly value: T; readonly label: string }[];
  label: string;
  testID?: string;
}) {
  return (
    <View className="border-b border-border bg-card" testID={testID}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1 px-2"
        accessibilityLabel={label}
        role="tablist"
      >
        {tabs.map((t) => {
          const on = t.value === value;
          return (
            <Pressable
              key={t.value}
              role="tab"
              accessibilityState={{ selected: on }}
              onPress={() => onChange(t.value)}
              testID={`tab-${t.value}`}
              className={cn('border-b-2 px-2.5 py-3', on ? 'border-accent' : 'border-transparent')}
            >
              <Text
                className={cn('text-[15px]', on ? 'font-medium text-accent-text' : 'text-text-2')}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** A line of small words under a list, with an icon: what works with no signal and what doesn't. */
export function Footnote({ children, testID }: { children: string; testID?: string }) {
  return (
    <Text className="px-1 pt-1 text-[12.5px] leading-[17px] text-text-3" testID={testID}>
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------------------------- when

export type DueTone = 'danger' | 'pending' | 'gray';

/**
 * When a duty is due, as the lists on the phone say it (board 77): late ones "Yesterday" or the day; today "Today", or
 * the time when it isn't the end of the day ("3:00 PM"); this week the weekday ("Fri"); later the day ("Oct 14").
 */
export function dueChip(
  dueAt: string | null,
  timeZone: string,
  now: number,
  overdue: boolean,
): { readonly words: string; readonly tone: DueTone } | null {
  if (!dueAt) return null;
  const at = Date.parse(dueAt);
  const today = localDateOf(now, timeZone);
  const day = localDateOf(at, timeZone);
  const d = daysBetween(today, day);
  const time = fmtTime(at, timeZone);
  const endOfDay = time === '11:59 PM';
  const year = Number(today.slice(0, 4));
  if (overdue)
    return {
      words:
        d === 0
          ? endOfDay
            ? RE_DUTIES_WORDS.today
            : time
          : d === -1
            ? RE_DUTIES_WORDS.yesterday
            : fmtMonthDay(day, year),
      tone: 'danger',
    };
  if (d <= 0) return { words: endOfDay ? RE_DUTIES_WORDS.today : time, tone: 'pending' };
  if (d < 7) return { words: weekdayShort(day), tone: 'gray' };
  return { words: fmtMonthDay(day, year), tone: 'gray' };
}

/** Where a duty falls in My duties: late, today, this week, later or no deadline (waiting and blocked aside). */
export function dueGroup(
  dueAt: string | null,
  timeZone: string,
  now: number,
  overdue: boolean,
): 'late' | 'today' | 'week' | 'later' | 'none' {
  if (!dueAt) return 'none';
  if (overdue) return 'late';
  const d = daysBetween(localDateOf(now, timeZone), localDateOf(Date.parse(dueAt), timeZone));
  return d <= 0 ? 'today' : d < 7 ? 'week' : 'later';
}

/** A local day as a list shows it: "Oct 14", with the year when it isn't this one. */
export function dayOf(date: string | null, timeZone: string, now: number): string | null {
  if (!date) return null;
  return fmtMonthDay(date, Number(localDateOf(now, timeZone).slice(0, 4)));
}
