/**
 * Each person's hours, time off and busy times in words, as the Calendar's Team, Week and Day views and Settings → My
 * calendar show them (`schedule.team`). The open windows the query also spells out day by day are left out: the
 * weekly hours and the time off say the same in a few lines, and the whole list is far too long to read.
 */
import { formatHours, localDateOf } from '@hfos/core/server';
import { dayLabel, rangeLabel, zoneLabel } from './calendar-format';

interface Span {
  startsAt: string;
  endsAt: string;
}
interface Exception extends Span {
  id: string;
  kind: 'unavailable' | 'available';
  allDay: boolean;
  note: string | null;
}
/** What `schedule.team` answers, as far as these words need it. */
export interface TeamSchedule {
  timezone: string;
  people: {
    userId: string;
    fullName: string;
    timezone: string;
    ownTimezone: string | null;
    weekly: { day: number; start: string; end: string }[];
    defaultHours: boolean;
    timeOff: Exception[];
    busy: Span[];
    privateBusy: Span[];
    elsewhereBusy: Span[];
    connection: { provider: 'google' | 'microsoft'; status: string } | null;
  }[];
}

/** The most of one person's busy times listed; the rest are counted. */
const MOST_BUSY = 25;

/** "Mon, Nov 9 to Wed, Nov 11, all day", "Tue, Nov 10, all day", or part of a day. */
function spanWords(s: Span, allDay: boolean, timeZone: string): string {
  const start = Date.parse(s.startsAt);
  const end = Date.parse(s.endsAt);
  if (!allDay) return rangeLabel(start, end, timeZone);
  // An all-day span ends at the midnight after its last day.
  const last = end - 1;
  return localDateOf(start, timeZone) === localDateOf(last, timeZone)
    ? `${dayLabel(start, timeZone)}, all day`
    : `${dayLabel(start, timeZone)} to ${dayLabel(last, timeZone)}, all day`;
}

const PROVIDER: Record<string, string> = { google: 'Google Calendar', microsoft: 'Outlook' };
/** A calendar link's state, as Settings → My calendar and the Calendar's notice say it. */
const LINK_STATE: Record<string, string> = {
  pending: 'connecting',
  active: 'connected',
  reauth_required: 'needs reconnecting',
  error: 'not syncing',
};

/** The schedules in words: times in the business's zone, all-day time off on the days the person picked. */
export function scheduleWords(out: TeamSchedule) {
  const tz = out.timezone;
  return {
    timeZone: tz,
    people: out.people.map((p) => {
      const entry = (t: Exception) => ({
        exceptionId: t.id,
        when: spanWords(t, t.allDay, t.allDay ? p.timezone : tz),
        ...(t.note ? { note: t.note } : {}),
      });
      const busy = (key: string, list: Span[]) =>
        list.length
          ? {
              [key]: list
                .slice(0, MOST_BUSY)
                .map((b) => rangeLabel(Date.parse(b.startsAt), Date.parse(b.endsAt), tz)),
              ...(list.length > MOST_BUSY ? { [`${key}More`]: list.length - MOST_BUSY } : {}),
            }
          : {};
      const extra = p.timeOff.filter((t) => t.kind === 'available');
      return {
        name: p.fullName,
        userId: p.userId,
        weeklyHours: p.defaultHours
          ? 'No hours saved yet, so weekdays 9 to 5 apply'
          : p.weekly.length
            ? formatHours(p.weekly)
            : 'Off every day',
        hoursIn: p.ownTimezone
          ? `their own time zone, ${zoneLabel(p.ownTimezone)}`
          : `the business’s time zone, ${zoneLabel(tz)}`,
        timeOff: p.timeOff.filter((t) => t.kind === 'unavailable').map(entry),
        ...(extra.length ? { extraOpenTime: extra.map(entry) } : {}),
        ...busy('busyInTheirCalendar', p.busy),
        ...busy('busyOnAPrivateDeal', p.privateBusy),
        ...busy('busyInAnotherBusiness', p.elsewhereBusy),
        calendarLink: p.connection
          ? `${PROVIDER[p.connection.provider] ?? p.connection.provider}, ${LINK_STATE[p.connection.status] ?? p.connection.status}`
          : 'No calendar linked',
      };
    }),
  };
}
