import {
  addDays,
  assignedToOf,
  assigneeShortOf,
  assignHeadingOf,
  assignNoteOf,
  ATTENTION_KIND_LABELS,
  ATTENTION_WORDS,
  attentionSnoozeChoices,
  attentionTargetOf,
  clockLabel,
  dayLabel,
  DISMISS_REASON_MAX,
  dismissAboutOf,
  dismissNoteOf,
  dismissReasonsOf,
  dismissSaid,
  localDateOf,
  localInstant,
  SNOOZE_MAX_DAYS,
  snoozePickError,
  type AttentionItemOut,
  type AttentionSnoozeChoice,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import {
  AlarmClock,
  ArchiveX,
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  Check,
  Info,
  Moon,
  Sun,
  UserRound,
} from '@/components/icons';
import { ROLE_LABELS } from '@/lib/businesses';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

import { KindTile, SheetLabel, SheetRow } from './bits';
import { useHomeEnv } from './home-context';

type Item = AttentionItemOut;

const SNOOZE_ICONS: Readonly<Record<AttentionSnoozeChoice['key'], LucideIcon>> = {
  hour: AlarmClock,
  evening: Moon,
  tomorrow: Sun,
  next_week: CalendarDays,
};

/** The item at the top of a sheet: its kind, its title, and whose it is. */
function SheetItem({ item }: { item: Item }) {
  const env = useHomeEnv();
  return (
    <View className="mb-2 flex-row items-center gap-2.5">
      <KindTile kind={item.kind} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-base font-medium">
          {item.title}
        </Text>
        <Text className="text-xs text-text-3">
          {ATTENTION_KIND_LABELS[item.kind]} · {assignedToOf(item, env.myUserId)}
        </Text>
      </View>
    </View>
  );
}

/** Who to assign it to: the team, with a tick on whoever has it now. */
function AssignList({
  item,
  onPick,
  onBack,
}: {
  item: Item;
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  const env = useHomeEnv();
  return (
    <View testID="assign-menu">
      <Pressable
        role="button"
        onPress={onBack}
        className="min-h-11 flex-row items-center gap-2 self-start px-1"
      >
        <Icon as={ArrowLeft} strokeWidth={1.75} className="size-4 text-accent-text" />
        <Text className="text-[13px] font-medium text-accent-text">{ATTENTION_WORDS.back}</Text>
      </Pressable>
      <SheetLabel>{assignHeadingOf(item)}</SheetLabel>
      {env.members.map((m) => (
        <Pressable
          key={m.id}
          role="button"
          onPress={() => onPick(m.id)}
          testID={`assign-${m.id}`}
          className="min-h-[52px] flex-row items-center gap-3 border-t border-border px-1 py-1.5 active:bg-card-2"
        >
          <Avatar name={m.fullName} seed={m.id} size="sm" />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-[15px]">
            {m.fullName}{' '}
            <Text className="text-[13px] text-text-3">
              · {ROLE_LABELS[m.role as keyof typeof ROLE_LABELS] ?? m.role}
            </Text>
          </Text>
          {item.assignee?.id === m.id ? (
            <Icon as={Check} strokeWidth={2} className="size-5 text-accent-text" />
          ) : null}
        </Pressable>
      ))}
      <View className="flex-row items-start gap-1.5 border-t border-border px-1 pt-2.5">
        <Icon as={Info} className="mt-px size-3.5 text-text-3" />
        <Text className="min-w-0 flex-1 text-xs leading-[17px] text-text-3">
          {assignNoteOf(item)}
        </Text>
      </View>
    </View>
  );
}

/** ⋯ on a card: Snooze first (it's used most), then Assign, Dismiss and the record, as the canvas draws it. */
export function ItemSheet({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const env = useHomeEnv();
  const [view, setView] = React.useState<'main' | 'assign'>('main');
  const [shown, setShown] = React.useState<Item | null>(item);
  // The choices as of the moment the sheet opened.
  const [choices, setChoices] = React.useState<AttentionSnoozeChoice[]>([]);
  React.useEffect(() => {
    if (!item) return;
    setShown(item);
    setView('main');
    setChoices(attentionSnoozeChoices(env.timeZone, Date.now()));
  }, [item, env.timeZone]);
  const it = item ?? shown;
  if (!it) return null;
  const a = it.actions;
  const target = attentionTargetOf(it, env.workspaceId);
  const then = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet open={!!item} onClose={onClose} testID="attention-sheet" scroll>
      <SheetItem item={it} />
      {view === 'assign' ? (
        <AssignList
          item={it}
          onBack={() => setView('main')}
          onPick={(id) => then(() => env.act.assign(it, id))()}
        />
      ) : (
        <>
          {a.snooze ? (
            <>
              <SheetLabel>{ATTENTION_WORDS.snooze}</SheetLabel>
              {choices.map((c, i) => (
                <SheetRow
                  key={c.key}
                  first={i === 0}
                  icon={SNOOZE_ICONS[c.key]}
                  label={c.label}
                  hint={c.hint}
                  onPress={then(() => env.act.snooze(it, c.until))}
                  testID={`snooze-${c.key}`}
                />
              ))}
              <SheetRow
                icon={CalendarClock}
                label={ATTENTION_WORDS.pickTime}
                hint={ATTENTION_WORDS.upTo30Days}
                onPress={then(() => env.act.pickTime(it))}
                testID="snooze-pick"
              />
            </>
          ) : null}
          <SheetLabel>{ATTENTION_WORDS.more}</SheetLabel>
          {a.assign ? (
            <SheetRow
              first
              icon={UserRound}
              label={ATTENTION_WORDS.assign}
              hint={assigneeShortOf(it, env.myUserId)}
              onPress={() => setView('assign')}
              testID="attention-assign"
            />
          ) : null}
          {a.dismiss ? (
            <SheetRow
              first={!a.assign}
              icon={ArchiveX}
              label={ATTENTION_WORDS.dismiss}
              danger
              onPress={then(() => env.act.dismiss(it))}
              testID="attention-dismiss"
            />
          ) : null}
          <SheetRow
            first={!a.assign && !a.dismiss}
            icon={ArrowUpRight}
            label={target.label}
            onPress={then(() => env.act.open(it))}
            testID="attention-open"
          />
        </>
      )}
      <Button variant="secondary" className="mt-3" onPress={onClose} testID="attention-sheet-close">
        {ATTENTION_WORDS.close}
      </Button>
    </Sheet>
  );
}

/**
 * "Dismiss this?": it asks why, but the reason is optional. The item stays off the list until something changes, like
 * a new message; the record itself doesn't change.
 */
export function DismissSheet({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const env = useHomeEnv();
  const colors = useColors();
  const [reason, setReason] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  const [shown, setShown] = React.useState<Item | null>(item);
  React.useEffect(() => {
    if (!item) return;
    setShown(item);
    setReason(null);
    setNote('');
  }, [item]);
  const it = item ?? shown;
  if (!it) return null;
  return (
    <Sheet
      open={!!item}
      onClose={onClose}
      title={ATTENTION_WORDS.dismissTitle}
      description={dismissAboutOf(it)}
      testID="dismiss-dialog"
      scroll
    >
      <Text className="mb-1.5 mt-4 text-[13.5px] font-medium">
        {ATTENTION_WORDS.why}{' '}
        <Text className="text-[13.5px] text-text-3">{ATTENTION_WORDS.optional}</Text>
      </Text>
      <View role="radiogroup" accessibilityLabel={ATTENTION_WORDS.why} className="gap-1.5">
        {dismissReasonsOf(it).map((r) => {
          const on = reason === r;
          return (
            <Pressable
              key={r}
              role="radio"
              accessibilityState={{ checked: on }}
              onPress={() => setReason(on ? null : r)}
              className={cn(
                'min-h-11 flex-row items-center gap-2.5 rounded-[9px] border px-3 py-2',
                on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
              )}
            >
              <View
                className={cn(
                  'size-4 items-center justify-center rounded-full border-[1.5px]',
                  on ? 'border-accent' : 'border-border-strong',
                )}
              >
                {on ? <View className="size-2 rounded-full bg-accent" /> : null}
              </View>
              <Text className="text-[14px]">{r}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        accessibilityLabel="A note for your team"
        placeholder={ATTENTION_WORDS.dismissNotePlaceholder}
        value={note}
        maxLength={DISMISS_REASON_MAX - 40}
        onChangeText={setNote}
        multiline
        placeholderTextColor={colors.placeholder}
        selectionColor={colors.accent}
        testID="dismiss-note"
        className="mt-2.5 min-h-16 rounded-menu border border-border-strong bg-card px-3.5 py-2.5 font-sans text-base text-text"
        style={{ textAlignVertical: 'top' }}
      />
      <View className="mt-3 flex-row items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px]">
        <Icon as={Info} className="mt-px size-4 text-text-2" />
        <Text className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-text-2">
          {dismissNoteOf(it)}
        </Text>
      </View>
      <View className="mt-4 gap-2">
        <Button
          variant="danger"
          testID="dismiss-confirm"
          onPress={() => {
            onClose();
            env.act.dismissNow(it, dismissSaid(reason, note));
          }}
        >
          {ATTENTION_WORDS.dismissConfirm}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {ATTENTION_WORDS.keepIt}
        </Button>
      </View>
    </Sheet>
  );
}

const zoneLabels = new Map<string, string>();

/** "Central Time" for America/Chicago, as the web says it; the zone's own name where the phone has no friendlier one. */
function zoneLabel(timeZone: string): string {
  let label = zoneLabels.get(timeZone);
  if (!label) {
    try {
      label =
        new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
          .formatToParts(Date.UTC(2026, 0, 15))
          .find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
    } catch {
      label = timeZone;
    }
    zoneLabels.set(timeZone, label);
  }
  return label;
}

const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
);

/** "Snooze until": a day and a time in the business's time zone, up to 30 days ahead. */
export function PickTimeSheet({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const env = useHomeEnv();
  const [bounds, setBounds] = React.useState(() => {
    const today = localDateOf(Date.now(), env.timeZone);
    return {
      today,
      days: Array.from({ length: SNOOZE_MAX_DAYS + 1 }, (_, i) => addDays(today, i)),
    };
  });
  const [date, setDate] = React.useState(bounds.days[1]!);
  const [time, setTime] = React.useState('09:00');
  const [error, setError] = React.useState<string | null>(null);
  const [shown, setShown] = React.useState<Item | null>(item);
  React.useEffect(() => {
    if (!item) return;
    const today = localDateOf(Date.now(), env.timeZone);
    const days = Array.from({ length: SNOOZE_MAX_DAYS + 1 }, (_, i) => addDays(today, i));
    setBounds({ today, days });
    setDate(days[1]!);
    setTime('09:00');
    setError(null);
    setShown(item);
  }, [item, env.timeZone]);
  const it = item ?? shown;
  if (!it) return null;

  const submit = () => {
    const until = localInstant(date, time, env.timeZone);
    const problem = snoozePickError(until, Date.now());
    if (problem) return setError(problem);
    onClose();
    env.act.snooze(it, until);
  };
  const dayWords = (d: string) => dayLabel(localInstant(d, '12:00', env.timeZone), env.timeZone);
  const timeWords = (t: string) => clockLabel(localInstant(date, t, env.timeZone), env.timeZone);

  return (
    <Sheet
      open={!!item}
      onClose={onClose}
      title={ATTENTION_WORDS.snoozeUntil}
      description={it.title}
      testID="snooze-pick-form"
    >
      <Text className="mb-1.5 mt-4 text-[13.5px] font-medium">{ATTENTION_WORDS.day}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1.5"
      >
        {bounds.days.map((d) => (
          <Choice key={d} on={d === date} onPress={() => setDate(d)} label={dayWords(d)} />
        ))}
      </ScrollView>
      <Text className="mb-1.5 mt-3.5 text-[13.5px] font-medium">{ATTENTION_WORDS.time}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1.5"
        contentOffset={{ x: 17 * 88, y: 0 }}
      >
        {TIMES.map((t) => (
          <Choice key={t} on={t === time} onPress={() => setTime(t)} label={timeWords(t)} />
        ))}
      </ScrollView>
      <Text
        className={cn('mt-2 text-[12.5px]', error ? 'text-danger-text' : 'text-text-3')}
        role={error ? 'alert' : undefined}
      >
        {error ?? ATTENTION_WORDS.pickZone(zoneLabel(env.timeZone))}
      </Text>
      <View className="mt-4 gap-2">
        <Button onPress={submit} testID="snooze-pick-save">
          {ATTENTION_WORDS.snooze}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {ATTENTION_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}

function Choice({ on, onPress, label }: { on: boolean; onPress: () => void; label: string }) {
  return (
    <Pressable
      role="radio"
      accessibilityState={{ checked: on }}
      onPress={onPress}
      className={cn(
        'h-11 items-center justify-center rounded-full border px-3.5',
        on ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
      )}
    >
      <Text className={cn('text-[14px] font-medium', on ? 'text-accent-text' : 'text-text-2')}>
        {label}
      </Text>
    </Pressable>
  );
}
