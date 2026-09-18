import {
  agendaEmptyWords,
  appointmentCount,
  dayHeadingShort,
  localDateOf,
  type AgendaRow as Row,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, View } from 'react-native';

import {
  useAgendaDay,
  useCalendarWeek,
  useCalendarZone,
  useNow,
  type PhoneAppointment,
} from '@/calendar/use-calendar';
import { AgendaRow, BusyRow, NowRow, TimeZoneProvider } from '@/components/calendar/agenda-row';
import { DayStrip } from '@/components/calendar/day-strip';
import { NewAppointmentSheet } from '@/components/calendar/new-appointment';
import { CalendarDays, Plus } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';

/**
 * **Your day and your week** (the canvas's Calendar): the week's date strip over the chosen day as a list, Everyone or
 * Just me, and the red line at the current time — the same agenda the web shows at 390 px, read from the phone's own
 * copy so it is there with no signal.
 *
 * A time asked for from this phone that HandsFreeOS hasn't confirmed sits in its place on the day, marked "Not booked
 * yet": nobody else's calendar has it, so nobody should ring the customer about it.
 *
 * The list is virtualized, so a day with fifty visits scrolls as smoothly as one with two.
 */
export default function Calendar() {
  const { business } = useBusiness();
  const { appt } = useLocalSearchParams<{ appt?: string }>();
  const timeZone = useCalendarZone();
  const now = useNow();
  const today = localDateOf(now, timeZone);
  const [date, setDate] = React.useState(today);
  const [mine, setMine] = React.useState(false);
  const [booking, setBooking] = React.useState(false);

  const week = useCalendarWeek(date, timeZone);
  const day = useAgendaDay(week, date, today, timeZone, mine, now);
  const empty = agendaEmptyWords(mine);

  // A notification or an email link (…/calendar?appt=<id>) opens the appointment itself.
  React.useEffect(() => {
    if (appt) router.push(businessHref(business.id, `calendar/${appt}`) as Href);
  }, [appt, business.id]);

  const open = React.useCallback(
    (a: PhoneAppointment) => router.push(businessHref(business.id, `calendar/${a.id}`) as Href),
    [business.id],
  );

  const renderRow = React.useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === 'now') return <NowRow at={item.at} />;
      if (item.kind === 'busy') return <BusyRow busy={item.busy} end={item.end} />;
      return <AgendaRow appt={item.appt as PhoneAppointment} now={now} onPress={open} />;
    },
    [now, open],
  );

  return (
    <TimeZoneProvider value={timeZone}>
      <Screen title="Calendar" testID="calendar" scroll={false}>
        <DayStrip
          days={week.days}
          date={date}
          today={today}
          marked={day.marked}
          timeZone={timeZone}
          onDate={setDate}
        />
        <View className="border-b border-border bg-card px-3 pb-3">
          <Segmented<'all' | 'mine'>
            label="Whose day"
            value={mine ? 'mine' : 'all'}
            onChange={(v) => setMine(v === 'mine')}
            options={[
              { value: 'all', label: 'Everyone', testID: 'calendar-everyone' },
              { value: 'mine', label: 'Just me', testID: 'calendar-just-me' },
            ]}
          />
        </View>
        <View className="flex-row items-center justify-between px-4 pb-2 pt-3">
          <Text className="text-[13px] font-medium" testID="calendar-day-heading">
            {dayHeadingShort(date, today, mine)}
          </Text>
          <Text className="text-xs text-text-3" testID="calendar-day-count">
            {appointmentCount(day.onDay.length)}
          </Text>
        </View>
        {day.onDay.length === 0 ? (
          <View className="border-y border-border bg-card px-6 py-11" testID="calendar-empty">
            <View className="mb-3 size-11 items-center justify-center self-center rounded-full bg-card-2">
              <Icon as={CalendarDays} className="size-5 text-text-3" />
            </View>
            <Text className="text-center text-[15px] font-semibold">{empty.title}</Text>
            <Text className="mt-1 text-center text-[13px] text-text-2">{empty.body}</Text>
            <Button
              variant="secondary"
              icon={Plus}
              className="mt-3.5 self-center"
              onPress={() => setBooking(true)}
              testID="calendar-new-empty"
            >
              {empty.action}
            </Button>
          </View>
        ) : (
          <FlatList
            data={day.rows}
            keyExtractor={rowKey}
            renderItem={renderRow}
            initialNumToRender={12}
            windowSize={7}
            className="border-t border-border"
            contentContainerClassName="pb-24"
            testID="agenda"
          />
        )}
        {day.onDay.length ? (
          // Round and icon-only, as the web's own phone layout draws it: a button with words on it covers the row
          // under it, and a day's last row is the one people reach for.
          <Button
            icon={Plus}
            accessibilityLabel={empty.action}
            className="absolute bottom-5 right-4 size-14 rounded-full px-0 shadow"
            onPress={() => setBooking(true)}
            testID="calendar-new"
          />
        ) : null}
        <NewAppointmentSheet
          open={booking}
          onClose={() => setBooking(false)}
          date={date}
          timeZone={timeZone}
          person={null}
        />
      </Screen>
    </TimeZoneProvider>
  );
}

const rowKey = (row: Row): string =>
  row.kind === 'appt' ? row.appt.id : row.kind === 'busy' ? `busy-${row.at}` : 'now';
