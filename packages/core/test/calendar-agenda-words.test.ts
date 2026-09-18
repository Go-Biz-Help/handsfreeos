/**
 * The calendar's words and working out (M10 step 16), which the web's agenda and the phone's Calendar tab both show:
 * the day's heading, count and empty state, the rows of a day with its busy time and its "now" line, an
 * appointment's title line, status and chips, and the two ways a time can be "Not booked yet".
 */
import { describe, expect, it } from 'vitest';
import {
  agendaEmptyWords,
  agendaRows,
  appointmentChips,
  appointmentCount,
  appointmentsOnDay,
  areaOf,
  bookedSeatsOf,
  busyFrom,
  dayHeading,
  dayHeadingShort,
  daysWithAppointments,
  dayTime,
  fmtAt,
  fmtDateLong,
  fmtDateShort,
  fmtLength,
  fmtMonthYear,
  fmtRange,
  fmtTime,
  fmtWeekRange,
  fmtWhen,
  holdOf,
  holdWords,
  isNotBookedYet,
  isPast,
  namesText,
  NOT_BOOKED_YET,
  nowLabel,
  REQUESTED_LINE,
  reminderLabel,
  reminderNoun,
  reminderScheduleWords,
  reminderWhy,
  reservedText,
  rowTimeOf,
  seatsLabel,
  sourceLabel,
  staffLine,
  statusOf,
  subtitleOf,
  tellNote,
  upcomingDetail,
  zoneLabel,
  type AgendaAppointment,
  type AgendaInput,
  type CalendarConfig,
} from '../src/index';
import { defaultConfig } from '../src/calendar/config';

const TZ = 'America/Chicago';

/** Tuesday, 22 September 2026. The canvas's day. */
const at = (clock: string, day = '22'): string => `2026-09-${day}T${clock}:00.000Z`;

function appointment(over: Partial<AgendaAppointment> = {}): AgendaAppointment {
  return {
    id: 'a1',
    title: 'AC repair',
    // 8:30 AM – 10:00 AM Central.
    startsAt: at('13:30'),
    endsAt: at('15:00'),
    status: 'scheduled',
    source: 'staff',
    calendarName: 'Service calls',
    calendarColor: '#2563eb',
    customers: [{ id: 'p1', name: 'Mike Johnson' }],
    staff: [{ userId: 'u-marco', fullName: 'Marco Villanueva' }],
    resources: [],
    address: '5107 Evergreen St, Bellaire, TX 77401',
    capacity: 1,
    seatsTaken: 1,
    ...over,
  };
}

const input = (over: Partial<AgendaInput> = {}): AgendaInput => ({
  date: '2026-09-22',
  today: '2026-09-22',
  timeZone: TZ,
  appointments: [appointment()],
  mine: false,
  myUserId: 'u-marco',
  now: null,
  ...over,
});

describe('the day and the week in words', () => {
  it('heads the day the way the web does, and the way the phone does', () => {
    expect(dayHeading('2026-09-22', '2026-09-22')).toBe('Today · Tuesday, September 22');
    expect(dayHeading('2026-09-24', '2026-09-22')).toBe('Thursday, September 24');
    expect(dayHeadingShort('2026-09-22', '2026-09-22', true)).toBe('Today · Tue, Sep 22');
    expect(dayHeadingShort('2026-09-24', '2026-09-22', true)).toBe('Thu, Sep 24 · Just me');
    expect(dayHeadingShort('2026-09-24', '2026-09-22', false)).toBe('Thu, Sep 24');
  });

  it('counts appointments, and says nothing for none', () => {
    expect(appointmentCount(6)).toBe('6 appointments');
    expect(appointmentCount(1)).toBe('1 appointment');
    expect(appointmentCount(0)).toBe('');
  });

  it('says what an empty day means, differently for Everyone and Just me', () => {
    expect(agendaEmptyWords(false)).toEqual({
      title: 'Nothing booked',
      body: 'Open times can still be booked online.',
      action: 'New appointment',
    });
    expect(agendaEmptyWords(true).title).toBe('Nothing booked for you');
  });

  it('marks the days of the week strip that have anything on them', () => {
    const week = daysWithAppointments(
      input({
        appointments: [appointment(), appointment({ id: 'a2', startsAt: at('13:30', '24') })],
      }),
    );
    expect([...week].sort()).toEqual(['2026-09-22', '2026-09-24']);
  });

  it('Just me keeps only what this person is on', () => {
    const mine = input({
      mine: true,
      appointments: [
        appointment(),
        appointment({ id: 'a2', staff: [{ userId: 'u-priya', fullName: 'Priya Patel' }] }),
      ],
    });
    expect(appointmentsOnDay(mine).map((a) => a.id)).toEqual(['a1']);
    expect(appointmentsOnDay({ ...mine, mine: false }).map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('the rows of one day', () => {
  it('puts the appointments in time order', () => {
    const rows = agendaRows(
      input({
        appointments: [
          appointment({ id: 'late', startsAt: at('18:00'), endsAt: at('19:00') }),
          appointment({ id: 'early', startsAt: at('13:00'), endsAt: at('14:00') }),
        ],
      }),
    );
    expect(rows.map((r) => (r.kind === 'appt' ? r.appt.id : r.kind))).toEqual(['early', 'late']);
  });

  it('shows this person’s own busy time only under Just me, and names where it came from', () => {
    const busy = [{ startsAt: at('16:00'), endsAt: at('17:00'), provider: 'google' as const }];
    expect(agendaRows(input({ busy })).some((r) => r.kind === 'busy')).toBe(false);
    const rows = agendaRows(input({ busy, mine: true }));
    const row = rows.find((r) => r.kind === 'busy');
    expect(row).toBeTruthy();
    expect(busyFrom('google')).toBe('From Google Calendar');
    expect(busyFrom('microsoft')).toBe('From Outlook');
    expect(busyFrom(null)).toBe('From your calendar');
  });

  it('drops the now line in where it belongs, and only on today with something on it', () => {
    const now = Date.parse(at('14:00'));
    const rows = agendaRows(
      input({
        now,
        appointments: [
          appointment({ id: 'before', startsAt: at('13:00'), endsAt: at('13:30') }),
          appointment({ id: 'after', startsAt: at('16:00'), endsAt: at('17:00') }),
        ],
      }),
    );
    expect(rows.map((r) => (r.kind === 'appt' ? r.appt.id : r.kind))).toEqual([
      'before',
      'now',
      'after',
    ]);
    expect(nowLabel(now, TZ)).toBe('Now · 9:00 AM');
    // Another day, and a day with nothing on it, get no line.
    expect(agendaRows(input({ now, date: '2026-09-24' })).some((r) => r.kind === 'now')).toBe(
      false,
    );
    expect(agendaRows(input({ now, appointments: [] })).some((r) => r.kind === 'now')).toBe(false);
  });

  it('sits the now line last when everything today is over', () => {
    const now = Date.parse(at('20:00'));
    const rows = agendaRows(input({ now }));
    expect(rows[rows.length - 1]!.kind).toBe('now');
  });
});

describe('one appointment’s lines', () => {
  it('says who it is for and roughly where', () => {
    expect(subtitleOf(appointment())).toBe('Mike Johnson · Bellaire');
    expect(subtitleOf(appointment({ customers: [], address: null }))).toBe('Service calls');
    expect(subtitleOf(appointment({ title: 'Service calls', customers: [], address: null }))).toBe(
      '',
    );
    expect(
      subtitleOf(
        appointment({
          customers: [
            { id: 'p1', name: 'Mike Johnson' },
            { id: 'p2', name: 'Maria Lopez' },
          ],
        }),
      ),
    ).toBe('2 customers · Bellaire');
  });

  it('reads the neighbourhood out of an address', () => {
    expect(areaOf('5107 Evergreen St, Bellaire, TX 77401')).toBe('Bellaire');
    expect(areaOf('Bellaire')).toBe('Bellaire');
    expect(areaOf(null)).toBe(null);
  });

  it('names who is going, and what is reserved', () => {
    expect(
      staffLine(
        appointment({
          staff: [
            { userId: 'u1', fullName: 'Priya Patel' },
            { userId: 'u2', fullName: 'Marco Villanueva' },
          ],
        }),
      ),
    ).toBe('Priya and Marco');
    expect(namesText(['Priya', 'Marco', 'Dale'])).toBe('Priya, Marco and Dale');
    expect(namesText([])).toBe('');
    expect(reservedText(1, 'Red light bed')).toBe('1 Red light bed');
    expect(reservedText(2, 'Truck')).toBe('2 × Truck');
  });

  it('gives the time column its two halves', () => {
    expect(rowTimeOf(appointment(), TZ)).toEqual({ at: '8:30 AM', length: '1 h 30 min' });
  });

  it('chips what was reserved, how many seats and where it was booked', () => {
    expect(appointmentChips(appointment())).toEqual([]);
    expect(
      appointmentChips(
        appointment({
          source: 'booking_page',
          capacity: 8,
          seatsTaken: 3,
          resources: [{ name: 'Truck 2' }, { name: 'Ladder', quantity: 2 }],
        }),
      ),
    ).toEqual([
      { kind: 'resource', label: 'Truck 2' },
      { kind: 'resource', label: '2 × Ladder' },
      { kind: 'seats', label: '3/8 seats' },
      { kind: 'source', label: 'Booked online' },
    ]);
    expect(sourceLabel('ai_teammate')).toBe('Booked by AI');
    expect(sourceLabel('staff')).toBe(null);
    expect(seatsLabel(3, 8)).toBe('3/8 seats');
  });

  it('lists an upcoming appointment on one line', () => {
    expect(upcomingDetail(appointment({ resources: [{ name: 'Truck 2' }] }), TZ)).toBe(
      '8:30–10:00 AM · Marco · Truck 2',
    );
  });

  it('drops the seats that cancelled off it', () => {
    expect(
      bookedSeatsOf([
        { id: 's1', status: 'booked' },
        { id: 's2', status: 'cancelled' },
      ]).map((s) => s.id),
    ).toEqual(['s1']);
  });
});

describe('what state an appointment is in', () => {
  const now = Date.parse(at('14:00'));

  it('is scheduled, happening now, or over', () => {
    expect(statusOf(appointment(), now)).toEqual({ label: 'Happening now', tone: 'pending' });
    expect(statusOf(appointment({ startsAt: at('16:00'), endsAt: at('17:00') }), now).label).toBe(
      'Scheduled',
    );
    expect(statusOf(appointment({ status: 'completed' }), now)).toEqual({
      label: 'Completed',
      tone: 'ok',
    });
    expect(statusOf(appointment({ status: 'no_show' }), now).label).toBe('No-show');
    expect(statusOf(appointment({ status: 'cancelled' }), now)).toEqual({
      label: 'Cancelled',
      tone: 'danger',
    });
    expect(isPast(appointment(), now)).toBe(false);
    expect(isPast(appointment(), Date.parse(at('16:00')))).toBe(true);
  });

  it('never calls a time nobody has paid for "happening now"', () => {
    const held = appointment({ heldUntil: at('14:10') });
    expect(statusOf(held, now)).toEqual({ label: NOT_BOOKED_YET, tone: 'pending' });
    expect(isNotBookedYet(held, now)).toBe(true);
  });

  it('treats a time asked for from a phone with no signal the same way', () => {
    const asked = appointment({ requested: true });
    expect(statusOf(asked, now).label).toBe(NOT_BOOKED_YET);
    expect(isNotBookedYet(asked, now)).toBe(true);
    expect(REQUESTED_LINE).toBe('Not booked yet · We’ll confirm this time when you’re back online');
  });

  it('tells a hold’s minutes, and says when it has run out', () => {
    expect(holdOf(appointment(), now)).toBe(null);
    const hold = holdOf(appointment({ heldUntil: at('14:09') }), now)!;
    expect(hold.minutesLeft).toBe(9);
    expect(hold.over).toBe(false);
    expect(holdWords(hold, TZ)).toBe(
      'Waiting on a deposit. Held until 9:09 AM · 9 minutes left to pay it.',
    );
    const gone = holdOf(appointment({ heldUntil: at('13:59') }), now)!;
    expect(gone.over).toBe(true);
    expect(holdWords(gone, TZ)).toBe(
      'Waiting on a deposit. The time is up, so this slot is going back.',
    );
    // A cancelled appointment's hold is history.
    expect(holdOf(appointment({ status: 'cancelled', heldUntil: at('14:09') }), now)).toBe(null);
  });
});

describe('dates and times in the business’s zone', () => {
  it('prints the clock, ranges and lengths by hand, so every engine matches', () => {
    expect(fmtTime(at('13:30'), TZ)).toBe('8:30 AM');
    expect(fmtRange(at('13:00'), at('14:00'), TZ)).toBe('8:00–9:00 AM');
    expect(fmtRange(at('16:00'), at('17:30'), TZ)).toBe('11:00 AM–12:30 PM');
    expect(fmtLength(90)).toBe('1 h 30 min');
    expect(fmtLength(45)).toBe('45 min');
    expect(fmtLength(120)).toBe('2 h');
  });

  it('prints the days, months and weeks the calendar heads itself with', () => {
    expect(fmtDateLong('2026-09-22')).toBe('Tuesday, September 22');
    expect(fmtDateShort('2026-09-22')).toBe('Tue, Sep 22');
    expect(fmtMonthYear('2026-09-22')).toBe('September 2026');
    expect(fmtWeekRange('2026-09-20', '2026-09-26')).toBe('September 20–26, 2026');
    expect(fmtWeekRange('2026-09-28', '2026-10-04')).toBe('September 28 – October 4, 2026');
    expect(fmtWeekRange('2026-12-28', '2027-01-03')).toBe('December 28, 2026 – January 3, 2027');
    expect(fmtWhen(at('13:30'), at('15:00'), TZ)).toBe('Tue, Sep 22 · 8:30–10:00 AM');
    expect(fmtAt(at('13:30'), TZ)).toBe('Tue, Sep 22 at 8:30 AM');
  });

  it('dates something close to now the way a person would', () => {
    const now = Date.parse(at('14:00'));
    expect(dayTime(at('16:00'), TZ, now)).toBe('Today 11:00 AM');
    expect(dayTime(at('14:00', '24'), TZ, now)).toBe('Thu 9:00 AM');
    expect(dayTime(at('14:00', '30'), TZ, now)).toBe('Sep 30, 9:00 AM');
  });

  it('names the zone in plain words, with no narrow spaces from Intl', () => {
    const label = zoneLabel(TZ);
    expect(label).toBe('Central Time');
    expect(/[\u00a0\u2007\u2009\u202f]/.test(label)).toBe(false);
  });
});

describe('what the customer is told', () => {
  const config = (): CalendarConfig => defaultConfig();

  it('names each reminder, on a row and inside a sentence', () => {
    expect(reminderLabel('confirmation')).toBe('Confirmation');
    expect(reminderLabel('day_before')).toBe('Day before');
    expect(reminderLabel('before_120')).toBe('2 hours before');
    expect(reminderNoun('before_120')).toBe('2-hour reminder');
    expect(reminderNoun('day_before')).toBe('day-before reminder');
  });

  it('says why one was skipped, or went by email, in words anyone can act on', () => {
    expect(reminderWhy('no_consent', 'Mike')).toBe('Mike hasn’t agreed to texts');
    expect(reminderWhy('quiet_hours', 'Mike')).toBe('it was quiet hours');
    expect(reminderWhy('booked_late', 'Mike')).toBe('booked too close to the time');
    expect(reminderWhy(null, 'Mike')).toBe(null);
  });

  it('reads the schedule out, and the line under Tell', () => {
    const n = config().notifications;
    const schedule = reminderScheduleWords(n.reminders);
    expect(schedule).toContain('before');
    const note = tellNote(n, { name: 'Mike', phone: true, email: true, textingReady: true }, true);
    expect(note.startsWith('Texts now')).toBe(true);
    expect(
      tellNote(n, { name: 'Mike', phone: false, email: false, textingReady: true }, true),
    ).toContain('nothing is sent');
    expect(
      tellNote(n, { name: 'Mike', phone: true, email: true, textingReady: true }, false),
    ).toContain('No confirmation now');
  });
});
