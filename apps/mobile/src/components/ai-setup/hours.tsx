import {
  clockOfMinutes,
  minutesToClock,
  parseClock,
  timeOptionsWith,
  weeklyHoursDayProblem,
  type WeeklyHours,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { AI_SETUP_PHONE_WORDS as P } from '@/ai-setup/words';
import { Check, Plus, X } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { FieldError } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** Monday first, as the web's hours editor (components/calendars/weekly-hours.tsx). */
const DAYS: readonly (readonly [number, string, string])[] = [
  [1, 'Mon', 'Monday'],
  [2, 'Tue', 'Tuesday'],
  [3, 'Wed', 'Wednesday'],
  [4, 'Thu', 'Thursday'],
  [5, 'Fri', 'Friday'],
  [6, 'Sat', 'Saturday'],
  [0, 'Sun', 'Sunday'],
];
/** A day holds at most this many stretches, as on the web. */
const MOST = 6;

type Stretch = WeeklyHours[number];

/** The time the sheet is picking: a stretch's start or end. */
interface Picking {
  readonly day: number;
  readonly index: number;
  readonly which: 'start' | 'end';
}

/** "9:30 AM", or Midnight for the end of the day. */
const timeWords = (minutes: number) => (minutes >= 1440 ? P.midnight : clockOfMinutes(minutes));

/**
 * Weekly hours on the phone, as the web's editor: a switch per day, one or more stretches (Add hours adds a second,
 * for a lunch break), none crossing midnight. A time opens a sheet of the half hours; one between them stays on it.
 * What's wrong with a day shows under it (core's `weeklyHoursDayProblem`).
 */
export function HoursField({
  value,
  onChange,
  idPrefix,
  error,
}: {
  value: WeeklyHours;
  onChange: (next: WeeklyHours) => void;
  idPrefix: string;
  error?: string;
}) {
  /** The time the sheet picks; it stays while the sheet slides away, so its words don't change as it goes. */
  const [picking, setPicking] = React.useState<Picking | null>(null);
  const [open, setOpen] = React.useState(false);
  const pick = (p: Picking) => {
    setPicking(p);
    setOpen(true);
  };
  const daysOf = (day: number) =>
    value.filter((h) => h.day === day).sort((a, b) => a.start.localeCompare(b.start));
  const setDay = (day: number, windows: Stretch[]) =>
    onChange(
      [...value.filter((h) => h.day !== day), ...windows].sort(
        (a, b) => a.day - b.day || a.start.localeCompare(b.start),
      ),
    );

  const picked = picking ? daysOf(picking.day)[picking.index] : undefined;
  const current =
    picking && picked ? parseClock(picking.which === 'start' ? picked.start : picked.end) : 540;

  return (
    <View testID={`${idPrefix}-editor`}>
      {DAYS.map(([day, short, long], row) => {
        const windows = daysOf(day);
        const on = windows.length > 0;
        const problem = weeklyHoursDayProblem(windows);
        const addStretch = () => {
          const last = windows[windows.length - 1];
          const from = last ? Math.min(parseClock(last.end) + 60, 1380) : 540;
          const to = Math.min(from + 240, 1440);
          setDay(day, [...windows, { day, start: minutesToClock(from), end: minutesToClock(to) }]);
        };
        return (
          <View
            key={day}
            className={cn('flex-row items-start gap-3 py-2', row > 0 && 'border-t border-border')}
            testID={`${idPrefix}-day-${short.toLowerCase()}`}
          >
            <View className="h-11 justify-center">
              <Switch
                checked={on}
                label={`${long} ${on ? 'on' : 'off'}`}
                onCheckedChange={(next) =>
                  setDay(day, next ? [{ day, start: '09:00', end: '17:00' }] : [])
                }
                testID={`${idPrefix}-day-${short.toLowerCase()}-switch`}
              />
            </View>
            <Text className="mt-3 w-9 text-[14px] font-medium">{short}</Text>
            <View className="min-w-0 flex-1 gap-1.5">
              {on ? (
                windows.map((w, i) => (
                  <View key={`${w.start}-${i}`} className="flex-row items-center gap-1.5">
                    <TimeButton
                      label={timeWords(parseClock(w.start))}
                      a11y={`${long} ${P.opens}${i ? ` ${i + 1}` : ''}`}
                      onPress={() => pick({ day, index: i, which: 'start' })}
                      testID={`${idPrefix}-${short.toLowerCase()}-${i}-start`}
                    />
                    <Text className="text-text-3">–</Text>
                    <TimeButton
                      label={timeWords(parseClock(w.end))}
                      a11y={`${long} ${P.closes}${i ? ` ${i + 1}` : ''}`}
                      onPress={() => pick({ day, index: i, which: 'end' })}
                      testID={`${idPrefix}-${short.toLowerCase()}-${i}-end`}
                    />
                    {i > 0 ? (
                      <Pressable
                        role="button"
                        accessibilityLabel={`${P.removeHours}, ${long} ${i + 1}`}
                        onPress={() =>
                          setDay(
                            day,
                            windows.filter((_, j) => j !== i),
                          )
                        }
                        hitSlop={6}
                        className="size-9 items-center justify-center rounded-full active:bg-card-2"
                        testID={`${idPrefix}-${short.toLowerCase()}-${i}-remove`}
                      >
                        <Icon as={X} className="size-4 text-text-3" />
                      </Pressable>
                    ) : null}
                  </View>
                ))
              ) : (
                <Text className="mt-3 text-[13.5px] text-text-3">{P.closed}</Text>
              )}
              {on && windows.length < MOST ? (
                <Pressable
                  role="button"
                  accessibilityLabel={`${P.addHours}, ${long}`}
                  onPress={addStretch}
                  className="h-9 flex-row items-center gap-1.5 self-start rounded-control px-1 active:bg-card-2"
                  testID={`${idPrefix}-${short.toLowerCase()}-add`}
                >
                  <Icon as={Plus} className="size-4 text-accent-text" />
                  <Text className="text-[13px] font-medium text-accent-text">{P.addHours}</Text>
                </Pressable>
              ) : null}
              {problem ? <FieldError>{problem}</FieldError> : null}
            </View>
          </View>
        );
      })}
      <FieldError>{error}</FieldError>
      <TimeSheet
        open={open && !!picked}
        title={picking?.which === 'end' ? P.closes : P.opens}
        end={picking?.which === 'end'}
        current={current}
        onClose={() => setOpen(false)}
        onPick={(minutes) => {
          setOpen(false);
          if (!picking || !picked) return;
          const windows = daysOf(picking.day);
          const clock = minutesToClock(minutes);
          setDay(
            picking.day,
            windows.map((w, j) => (j === picking.index ? { ...w, [picking.which]: clock } : w)),
          );
        }}
        testID={`${idPrefix}-time-sheet`}
      />
    </View>
  );
}

function TimeButton({
  label,
  a11y,
  onPress,
  testID,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={`${a11y}: ${label}`}
      onPress={onPress}
      testID={testID}
      className="h-11 min-w-[92px] items-center justify-center rounded-control border border-border-strong bg-card px-2.5 active:bg-card-2"
    >
      <Text className="text-[14px] font-medium">{label}</Text>
    </Pressable>
  );
}

/** The half hours of the day to pick from, and the time already set when it falls between them. */
function TimeSheet({
  open,
  title,
  end,
  current,
  onClose,
  onPick,
  testID,
}: {
  open: boolean;
  title: string;
  end: boolean;
  current: number;
  onClose: () => void;
  onPick: (minutes: number) => void;
  testID: string;
}) {
  const times = React.useMemo(() => {
    const day = timeOptionsWith(current % 1440)
      .map(([m]) => m)
      .filter((m) => m % 30 === 0 || m === current);
    // An end runs to midnight and never starts the day; a start is the other way round.
    return end ? [...day.filter((m) => m > 0), 1440] : day;
  }, [current, end]);
  return (
    <Sheet open={open} onClose={onClose} title={title} scroll testID={testID}>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {times.map((m) => {
          const on = m === current;
          return (
            <Pressable
              key={m}
              role="radio"
              aria-checked={on}
              accessibilityLabel={timeWords(m)}
              onPress={() => onPick(m)}
              testID={`${testID}-${m}`}
              className={cn(
                'h-11 w-[23%] flex-row items-center justify-center gap-1 rounded-control border',
                on
                  ? 'border-transparent bg-accent-soft'
                  : 'border-border-strong bg-card active:bg-card-2',
              )}
            >
              {on ? <Icon as={Check} className="size-3 text-accent-text" /> : null}
              <Text
                className={cn('text-[13px] font-medium', on ? 'text-accent-text' : 'text-text-2')}
                numberOfLines={1}
              >
                {timeWords(m)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}
