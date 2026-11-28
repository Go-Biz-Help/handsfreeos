import { buildWidgetsData, type WidgetAppointment, type WidgetsInput } from '@hfos/core';

/** A business's day for the widgets' tests: 28 Nov 2026, 9:00 AM in Chicago. */
export const TZ = 'America/Chicago';
export const BIZ = '11111111-1111-4111-8111-111111111111';
export const NOW = Date.parse('2026-11-28T15:00:00Z');

function appt(
  id: string,
  start: string,
  end: string,
  over: Partial<WidgetAppointment> = {},
): WidgetAppointment {
  return {
    id,
    title: 'Duct cleaning for Mike Johnson',
    startsAt: start,
    endsAt: end,
    status: 'scheduled',
    source: 'manual',
    calendarName: 'Repairs',
    calendarColor: '#2d69d8',
    customers: [{ id: 'p1', name: 'Mike Johnson' } as never],
    staff: [],
    resources: [],
    address: '12 Oak Hollow Dr, Houston, TX 77001',
    capacity: 1,
    seatsTaken: 1,
    serviceName: 'Duct cleaning',
    ...over,
  };
}

export const INPUT: WidgetsInput = {
  now: NOW,
  timeZone: TZ,
  business: { id: BIZ, name: 'Lone Star HVAC' },
  showBusiness: true,
  hideNames: false,
  appointments: [
    appt('a1', '2026-11-28T14:30:00Z', '2026-11-28T15:30:00Z'),
    appt('a2', '2026-11-28T17:00:00Z', '2026-11-28T18:00:00Z', { title: 'Tune-up, Sara Lee' }),
    appt('b1', '2026-11-29T16:00:00Z', '2026-11-29T17:00:00Z'),
  ],
  tasks: [{ id: 't1', dueAt: '2026-11-28', allDay: true }],
  needs: {
    items: [
      { id: 'n1', kind: 'hot_lead', title: 'Dana Fox', detail: 'Asked for a quote', urgent: true },
      { id: 'n2', kind: 'customer_waiting', title: 'Sam Ortiz', detail: null, urgent: false },
    ],
    total: 2,
    urgent: 1,
  },
  money: {
    outstandingCents: 420000,
    outstandingCount: 5,
    overdueCents: 90050,
    overdueCount: 1,
    todayCents: 35000,
    weekCents: 210000,
  },
  can: { contacts: true, receipts: true, invoices: true },
  addons: [
    {
      addonId: 'outreach',
      name: 'Social Outreach',
      facts: {
        figures: [{ label: 'First messages', value: '6 of 20', tone: null }],
        note: '2 messages wait for your OK.',
        path: 'a/outreach?view=waiting',
      },
    },
  ],
};

export const DATA = buildWidgetsData(INPUT);
