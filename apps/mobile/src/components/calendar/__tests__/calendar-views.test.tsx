import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import Calendar from '@/app/app/w/[workspaceId]/(tabs)/calendar';
import {
  APPOINTMENTS_SQL,
  APPOINTMENT_STAFF_SQL,
  BUSY_SQL,
  WORKSPACE_SQL,
} from '@/calendar/queries';
import { BusinessProvider } from '@/components/shell/business-context';
import type { Me } from '@/lib/businesses';

/**
 * The Calendar tab's three views on the phone's own copy: the day it opens on, the week as one list, the month as
 * six rows of dots, the arrows that walk a week or a month, and a day of the month handing itself back to Day.
 *
 * The copy is stood in for by `useQuery`, which answers each of the Calendar's queries with rows.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const DALE = '22222222-2222-4222-8222-222222222222';
const TZ = 'America/Chicago';
// A Tuesday. 15:00 UTC is 10:00 in Chicago.
const NOW = Date.parse('2026-09-22T15:30:00.000Z');

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
  usePathname: () => `/app/w/${WS}/calendar`,
}));

const appointment = (id: string, startsAt: string, title: string) => ({
  id,
  title,
  starts_at: startsAt,
  ends_at: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  status: 'scheduled',
  source: 'staff',
  kind: 'booking',
  notes: null,
  location: null,
  capacity: 1,
  seats_taken: 1,
  buffer_before: 0,
  buffer_after: 0,
  calendar_id: 'c1',
  calendar_name: 'Service calls',
  calendar_color: '#2d69d8',
  calendar_config: null,
  service_id: null,
  service_name: null,
  service_price_cents: null,
  lead_id: null,
  client_id: null,
});

const APPTS = [
  appointment('a1', '2026-09-22T15:00:00.000Z', 'AC tune-up'),
  appointment('a2', '2026-09-24T15:00:00.000Z', 'Duct clean'),
  // Outside the week, inside the month: it shows on the month grid and nowhere else.
  appointment('a3', '2026-09-08T15:00:00.000Z', 'Install'),
];
const BUSY = [{ starts_at: '2026-09-23T16:00:00.000Z', ends_at: '2026-09-23T17:00:00.000Z' }];

/** The rows the copy would answer each of the Calendar's queries with, narrowed to the window asked for. */
function mockRowsFor(sql: string, params: readonly unknown[]): unknown[] {
  if (sql === WORKSPACE_SQL) return [{ timezone: TZ }];
  if (sql === APPOINTMENTS_SQL) {
    const [, from, to] = params as [string, string, string];
    return APPTS.filter((a) => a.ends_at >= from && a.starts_at < to);
  }
  if (sql === APPOINTMENT_STAFF_SQL)
    return APPTS.map((a) => ({
      appointment_id: a.id,
      user_id: DALE,
      role: 'host',
      full_name: 'Dale Porter',
    }));
  if (sql === BUSY_SQL) return BUSY;
  return [];
}

jest.mock('@powersync/react-native', () => ({
  ...jest.requireActual<object>('@powersync/common'),
  useQuery: (sql: string, params: readonly unknown[] = []) => ({
    data: mockRowsFor(sql, params),
    isLoading: false,
    isFetching: false,
  }),
  usePowerSync: () => ({ getOptional: jest.fn(async () => null) }),
}));

const me: Me = {
  user: { id: DALE, email: 'dale@lonestarhvac.test', fullName: 'Dale Porter' },
  businesses: [
    {
      id: WS,
      name: 'Lone Star HVAC & Roofing',
      organizationId: 'org',
      organizationName: 'Lone Star HVAC & Roofing',
      role: 'owner',
      timezone: TZ,
    },
  ],
  organizations: [],
  fetchedAt: 0,
};

const open = () =>
  render(
    <BusinessProvider
      value={{ userId: DALE, me, business: me.businesses[0]!, openSwitcher: () => undefined }}
    >
      <Calendar />
    </BusinessProvider>,
  );

// The clock is fixed so the dates below are, but `useNow`'s interval stays real: a faked one fires inside the
// render and React warns about overlapping act() calls.
beforeAll(() =>
  jest.useFakeTimers({ doNotFake: ['setInterval', 'clearInterval'] }).setSystemTime(NOW),
);
afterAll(() => jest.useRealTimers());

describe('the Calendar tab’s three views', () => {
  it('opens on the day, with the week’s strip over it', async () => {
    await open();
    expect(screen.getByTestId('calendar-title')).toHaveTextContent('September 2026');
    expect(screen.getByTestId('calendar-strip')).toBeTruthy();
    expect(screen.getByTestId('calendar-day-heading')).toHaveTextContent('Today · Tue, Sep 22');
    expect(screen.getByTestId('agenda-appt-a1')).toBeTruthy();
    // Thursday's booking is in the week, not on today's list.
    expect(screen.queryByTestId('agenda-appt-a2')).toBeNull();
  });

  it('lists the whole week under a heading a day, dated Monday to Sunday', async () => {
    await open();
    await fireEvent.press(screen.getByTestId('calendar-view-week'));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent('Sep 21–27');
    expect(screen.queryByTestId('calendar-strip')).toBeNull();
    // A heading is the day and what is on it, side by side.
    expect(screen.getByTestId('agenda-week-day-2026-09-21')).toHaveTextContent(
      'Mon, Sep 21Nothing booked',
    );
    expect(screen.getByTestId('agenda-week-day-2026-09-22')).toHaveTextContent(
      'Today · Tue, Sep 221 appointment',
    );
    expect(screen.getByTestId('agenda-appt-a1')).toBeTruthy();
    expect(screen.getByTestId('agenda-appt-a2')).toBeTruthy();
  });

  it('shows the month as six weeks of dots, and hands a day back to the day list', async () => {
    await open();
    await fireEvent.press(screen.getByTestId('calendar-view-month'));
    expect(screen.getByTestId('calendar-month')).toBeTruthy();
    // September 2026 starts on a Tuesday, so the grid opens on Monday the 31st of August.
    expect(screen.getByTestId('month-day-2026-08-31')).toBeTruthy();
    expect(screen.getByTestId('month-day-2026-10-11')).toBeTruthy();
    // The whole month is read at once, so a booking two weeks back has its dot.
    expect(screen.getByTestId('month-dot-a3')).toBeTruthy();
    expect(screen.getByTestId('month-dot-a1')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('month-day-2026-09-24'));
    expect(screen.getByTestId('calendar-day-heading')).toHaveTextContent('Thu, Sep 24');
    expect(screen.getByTestId('agenda-appt-a2')).toBeTruthy();
  });

  it('walks a week at a time, a month on the month, and comes back to today', async () => {
    await open();
    await fireEvent.press(screen.getByTestId('calendar-next'));
    expect(screen.getByTestId('calendar-day-heading')).toHaveTextContent('Tue, Sep 29');
    await fireEvent.press(screen.getByTestId('calendar-prev'));
    expect(screen.getByTestId('calendar-day-heading')).toHaveTextContent('Today · Tue, Sep 22');

    await fireEvent.press(screen.getByTestId('calendar-view-month'));
    await fireEvent.press(screen.getByTestId('calendar-next'));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent('October 2026');
    await fireEvent.press(screen.getByTestId('calendar-today'));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent('September 2026');
  });

  it('keeps busy time to Just me, on the day and on the month alike', async () => {
    await open();
    expect(screen.queryByTestId('month-busy')).toBeNull();
    await fireEvent.press(screen.getByTestId('calendar-just-me'));
    await fireEvent.press(screen.getByTestId('calendar-view-month'));
    expect(screen.getByTestId('month-busy')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('calendar-everyone'));
    expect(screen.queryByTestId('month-busy')).toBeNull();
  });
});
