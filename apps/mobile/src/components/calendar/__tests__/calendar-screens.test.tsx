import { render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { AgendaRow, BusyRow, NowRow, TimeZoneProvider } from '@/components/calendar/agenda-row';
import { DayStrip } from '@/components/calendar/day-strip';
import { StateBadge } from '@/components/money/money-rows';
import type { PhoneAppointment } from '@/calendar/use-calendar';

/**
 * The Calendar's and Money's own pieces with React Native Testing Library: a row of the day (with and without a time
 * anybody has been promised), the busy row and the now line, the week's strip, and a document's badge.
 */

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), push: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-09-22T13:50:00.000Z');

const appt = (over: Partial<PhoneAppointment> = {}): PhoneAppointment =>
  ({
    id: 'a1',
    title: 'AC repair',
    startsAt: '2026-09-22T13:30:00.000Z',
    endsAt: '2026-09-22T15:00:00.000Z',
    status: 'scheduled',
    source: 'booking_page',
    calendarName: 'Service calls',
    calendarColor: '#2563eb',
    customers: [{ id: 'p1', name: 'Mike Johnson' }],
    staff: [{ userId: 'u1', fullName: 'Marco Villanueva' }],
    resources: [],
    address: '5107 Evergreen St, Bellaire, TX 77401',
    capacity: 1,
    seatsTaken: 1,
    heldUntil: null,
    calendarId: 'c1',
    serviceName: null,
    priceCents: null,
    notes: null,
    kind: 'booking',
    bufferBefore: 0,
    bufferAfter: 0,
    seats: [],
    config: null,
    clientId: null,
    change: null,
    ...over,
  }) as PhoneAppointment;

const wrap = (node: React.ReactNode) => <TimeZoneProvider value={TZ}>{node}</TimeZoneProvider>;

describe('a row of the day', () => {
  it('shows the time, how long it takes, who it is for and roughly where', async () => {
    await render(wrap(<AgendaRow appt={appt()} now={NOW} onPress={() => undefined} />));
    expect(screen.getByText('8:30 AM')).toBeTruthy();
    expect(screen.getByText('1 h 30 min')).toBeTruthy();
    expect(screen.getByText('AC repair')).toBeTruthy();
    expect(screen.getByText('Mike Johnson · Bellaire')).toBeTruthy();
    expect(screen.getByText('Booked online')).toBeTruthy();
    expect(screen.queryByTestId('agenda-not-booked')).toBeNull();
  });

  it('says "Not booked yet" above everything else for a time asked for with no signal', async () => {
    await render(
      wrap(<AgendaRow appt={appt({ requested: true })} now={NOW} onPress={() => undefined} />),
    );
    expect(screen.getByTestId('agenda-not-booked')).toHaveTextContent(
      'Not booked yet · We’ll confirm this time when you’re back online',
    );
  });

  it('says what a time held for a deposit is waiting on, with the minutes left', async () => {
    await render(
      wrap(
        <AgendaRow
          appt={appt({ heldUntil: '2026-09-22T13:59:00.000Z' })}
          now={NOW}
          onPress={() => undefined}
        />,
      ),
    );
    expect(screen.getByTestId('agenda-not-booked')).toHaveTextContent(
      'Waiting on a deposit. Held until 8:59 AM · 9 minutes left to pay it.',
    );
  });

  it('counts seats on a class, and names what was reserved', async () => {
    await render(
      wrap(
        <AgendaRow
          appt={appt({ capacity: 8, seatsTaken: 3, resources: [{ name: 'Truck 2' }] })}
          now={NOW}
          onPress={() => undefined}
        />,
      ),
    );
    expect(screen.getByText('3/8 seats')).toBeTruthy();
    expect(screen.getByText('Truck 2')).toBeTruthy();
  });
});

describe('the rest of the day', () => {
  it('names busy time without saying what it is', async () => {
    await render(
      wrap(
        <BusyRow
          busy={{
            startsAt: '2026-09-22T16:00:00.000Z',
            endsAt: '2026-09-22T17:00:00.000Z',
            provider: null,
          }}
          end={Date.parse('2026-09-22T17:00:00.000Z')}
        />,
      ),
    );
    expect(screen.getByText('Busy')).toBeTruthy();
    expect(screen.getByText('From your calendar')).toBeTruthy();
    expect(screen.getByText('11:00 AM')).toBeTruthy();
  });

  it('draws the red line at the current time', async () => {
    await render(wrap(<NowRow at={NOW} />));
    expect(screen.getByTestId('agenda-now')).toHaveTextContent('Now · 8:50 AM');
  });

  it('marks today, the chosen day and the days with anything on them', async () => {
    const days = [
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
    ];
    await render(
      <DayStrip
        days={days}
        date="2026-09-22"
        today="2026-09-22"
        marked={new Set(['2026-09-22', '2026-09-24'])}
        timeZone={TZ}
        onDate={() => undefined}
      />,
    );
    expect(screen.getByText('September 2026')).toBeTruthy();
    expect(screen.getByTestId('calendar-zone')).toHaveTextContent('Central Time');
    expect(screen.getByTestId('agenda-day-2026-09-22')).toBeTruthy();
    expect(screen.getByLabelText('Thu 24')).toBeTruthy();
  });
});

describe('a document’s badge', () => {
  it('uses core’s words for each state', async () => {
    await render(<StateBadge state="partly_paid" kind="invoice" testID="b1" />);
    expect(screen.getByTestId('b1')).toHaveTextContent('Partly paid');
    await render(<StateBadge state="viewed" kind="estimate" testID="b2" />);
    expect(screen.getByTestId('b2')).toHaveTextContent('Opened');
    await render(<StateBadge state="past_due" kind="subscription" testID="b3" />);
    expect(screen.getByTestId('b3')).toHaveTextContent('Payment failed');
    await render(<StateBadge state="pending" kind="refund" testID="b4" />);
    expect(screen.getByTestId('b4')).toHaveTextContent('Refunding');
  });
});
