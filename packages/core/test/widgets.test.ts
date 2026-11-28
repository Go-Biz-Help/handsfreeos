import { describe, expect, it } from 'vitest';
import { outreachWidgetFacts } from '../src/addons/outreach/widget';
import {
  buildWidgetsData,
  readWidgetsData,
  WIDGET_GALLERY,
  WIDGET_LIMITS,
  widgetActions,
  widgetFaceAt,
  widgetMoments,
  widgetsKey,
  widgetUrl,
  WIDGETS_DATA_VERSION,
  type WidgetAppointment,
  type WidgetsInput,
} from '../src/widgets';

const TZ = 'America/Chicago';
const BIZ = '11111111-1111-4111-8111-111111111111';
// 28 Nov 2026, 9:00 AM in Chicago (15:00 UTC).
const NOW = Date.parse('2026-11-28T15:00:00Z');

function appt(
  id: string,
  start: string,
  end: string,
  over: Partial<WidgetAppointment> = {},
): WidgetAppointment {
  return {
    id,
    title: `Duct cleaning for Mike Johnson`,
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

const base: WidgetsInput = {
  now: NOW,
  timeZone: TZ,
  business: { id: BIZ, name: 'Lone Star HVAC' },
  showBusiness: false,
  hideNames: false,
  appointments: [
    // 8:30–9:30: going on now.
    appt('a1', '2026-11-28T14:30:00Z', '2026-11-28T15:30:00Z'),
    // 11:00–12:00.
    appt('a2', '2026-11-28T17:00:00Z', '2026-11-28T18:00:00Z', { title: 'Tune-up, Sara Lee' }),
    // Earlier today and over: not listed.
    appt('a0', '2026-11-28T13:00:00Z', '2026-11-28T14:00:00Z'),
    // Cancelled: never listed.
    appt('ax', '2026-11-28T19:00:00Z', '2026-11-28T20:00:00Z', { status: 'cancelled' }),
    // Tomorrow 10:00.
    appt('b1', '2026-11-29T16:00:00Z', '2026-11-29T17:00:00Z'),
  ],
  tasks: [
    { id: 't1', dueAt: '2026-11-28T22:00:00Z', allDay: false },
    { id: 't2', dueAt: '2026-11-27', allDay: true },
    { id: 't3', dueAt: '2026-12-05T22:00:00Z', allDay: false },
    { id: 't4', dueAt: null, allDay: false },
  ],
  needs: {
    items: [
      {
        id: 'i1',
        kind: 'hot_lead',
        title: 'Jane Smith',
        detail: 'Asked for a quote',
        urgent: true,
      },
      {
        id: 'i2',
        kind: 'customer_waiting',
        title: 'Bob Ray',
        detail: 'Waiting 2 h',
        urgent: false,
      },
    ],
    total: 5,
    urgent: 1,
  },
  money: {
    outstandingCents: 420_000,
    outstandingCount: 3,
    overdueCents: 90_050,
    overdueCount: 1,
    todayCents: 35_000,
    weekCents: 210_000,
  },
  can: { contacts: true, receipts: true, invoices: true },
  addons: [
    {
      addonId: 'outreach',
      name: 'Social Outreach',
      facts: outreachWidgetFacts({ goals: [{ done: 12, most: 20 }], replies: 2, messages: 1 }),
    },
  ],
};

describe('the widgets copy', () => {
  it('is versioned, names the business and links to it', () => {
    const data = buildWidgetsData(base);
    expect(data.v).toBe(WIDGETS_DATA_VERSION);
    expect(data.business).toEqual({ id: BIZ, name: 'Lone Star HVAC' });
    expect(data.url).toBe(`handsfreeos://app/w/${BIZ}`);
    expect(data.updatedAt).toBe(new Date(NOW).toISOString());
    expect(data.moments[0]!.at).toBe(new Date(NOW).toISOString());
  });

  it('lists today’s appointments still to come, the one going on now first', () => {
    const today = buildWidgetsData(base).moments[0]!.face.today;
    expect(today.rows.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(today.rows[0]).toMatchObject({
      lead: 'Now',
      title: 'Duct cleaning for Mike Johnson',
      detail: 'Mike Johnson · Houston',
      tone: 'accent',
      url: `handsfreeos://app/w/${BIZ}/calendar?appt=a1`,
    });
    expect(today.rows[1]!.lead).toBe('11:00 AM');
    expect(today.count).toBe(2);
    expect(today.countWords).toBe('2 appointments');
    expect(today.more).toEqual({ '1': '+1 more', '3': null, '6': null });
    expect(today.date).toBe('Sat, Nov 28');
    expect(today.url).toBe(`handsfreeos://app/w/${BIZ}/calendar?date=2026-11-28`);
  });

  it('counts the tasks due today, overdue ones named', () => {
    const today = buildWidgetsData(base).moments[0]!.face.today;
    expect(today.tasks).toBe('2 tasks due · 1 overdue');
    expect(today.tasksUrl).toBe(`handsfreeos://app/w/${BIZ}/tasks`);
    const none = buildWidgetsData({ ...base, tasks: [] }).moments[0]!.face.today;
    expect(none.tasks).toBeNull();
  });

  it('moves on by itself: a moment at each start and end, and at midnight', () => {
    const moments = widgetMoments(base.appointments, NOW, TZ).map((t) => new Date(t).toISOString());
    expect(moments).toEqual([
      '2026-11-28T15:00:00.000Z', // now
      '2026-11-28T15:30:00.000Z', // a1 ends
      '2026-11-28T17:00:00.000Z', // a2 starts
      '2026-11-28T18:00:00.000Z', // a2 ends
      '2026-11-29T06:00:00.000Z', // midnight in Chicago
      '2026-11-29T16:00:00.000Z', // b1 starts
      '2026-11-29T17:00:00.000Z', // b1 ends
    ]);
    const data = buildWidgetsData(base);
    const at = (iso: string) => widgetFaceAt(data, Date.parse(iso)).today;
    expect(at('2026-11-28T15:45:00Z').rows.map((r) => r.id)).toEqual(['a2']);
    expect(at('2026-11-28T17:10:00Z').rows[0]!.lead).toBe('Now');
    expect(at('2026-11-28T18:30:00Z').rows).toEqual([]);
    expect(at('2026-11-28T18:30:00Z').empty).toBe('Nothing else today');
    const tomorrow = at('2026-11-29T07:00:00Z');
    expect(tomorrow.date).toBe('Sun, Nov 29');
    expect(tomorrow.rows.map((r) => r.id)).toEqual(['b1']);
    // Before the first moment (a clock set back), the first face shows.
    expect(widgetFaceAt(data, NOW - 60_000).today.rows.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('keeps to its limits', () => {
    const many = Array.from({ length: 30 }, (_, i) => {
      const start = NOW + (i + 1) * 10 * 60_000;
      return appt(
        `m${i}`,
        new Date(start).toISOString(),
        new Date(start + 5 * 60_000).toISOString(),
      );
    });
    const data = buildWidgetsData({ ...base, appointments: many });
    expect(data.moments.length).toBeLessThanOrEqual(WIDGET_LIMITS.moments);
    const today = data.moments[0]!.face.today;
    expect(today.rows).toHaveLength(WIDGET_LIMITS.rows);
    expect(today.count).toBe(30);
    expect(today.more['6']).toBe('+24 more');
  });

  it('lists what needs the person as Home ranks it, urgent ones marked', () => {
    const needs = buildWidgetsData(base).moments[0]!.face.needs;
    expect(needs.count).toBe(5);
    expect(needs.countWords).toBe('5 need you');
    expect(needs.urgent).toBe(1);
    expect(needs.rows[0]).toEqual({
      id: 'i1',
      lead: 'Urgent',
      title: 'Jane Smith',
      detail: 'Asked for a quote',
      tone: 'danger',
      url: `handsfreeos://app/w/${BIZ}?item=i1`,
    });
    expect(needs.more['1']).toBe('+4 more');
    const clear = buildWidgetsData({ ...base, needs: { items: [], total: 0, urgent: 0 } });
    expect(clear.moments[0]!.face.needs.countWords).toBe('You’re all caught up');
  });

  it('shows no names when they’re hidden, and never on the lock screen', () => {
    const data = buildWidgetsData({ ...base, hideNames: true });
    const face = data.moments[0]!.face;
    expect(data.hideNames).toBe(true);
    expect(face.today.rows[0]).toMatchObject({ title: 'Duct cleaning', detail: 'Houston' });
    expect(face.needs.rows.map((r) => [r.title, r.detail])).toEqual([
      ['Hot lead', null],
      ['Customer waiting', null],
    ]);
    expect(JSON.stringify(data)).not.toMatch(/Mike|Jane|Bob|Sara/);

    const shown = buildWidgetsData(base).moments[0]!.face.lock;
    expect(shown).toEqual({
      line: 'Now · Duct cleaning',
      time: 'Now',
      what: 'Duct cleaning',
      needs: 5,
      needsWords: '5 need you',
    });
    const later = widgetFaceAt(buildWidgetsData(base), Date.parse('2026-11-28T18:30:00Z')).lock;
    expect(later.line).toBe('Nothing else today');
  });

  it('names an appointment by its calendar when it has no service', () => {
    const data = buildWidgetsData({
      ...base,
      hideNames: true,
      appointments: [
        appt('c1', '2026-11-28T17:00:00Z', '2026-11-28T18:00:00Z', { serviceName: null }),
      ],
    });
    expect(data.moments[0]!.face.today.rows[0]!.title).toBe('Repairs');
  });

  it('shows money only to someone who manages it', () => {
    const money = buildWidgetsData(base).moments[0]!.face.money;
    expect(money.allowed).toBe(true);
    expect(money.figures).toEqual([
      { label: 'Owed', value: '$4,200', tone: null },
      { label: 'Late', value: '$900.50', tone: 'danger' },
      { label: 'In today', value: '$350', tone: 'good' },
      { label: 'Last 7 days', value: '$2,100', tone: null },
    ]);
    expect(money.note).toBe('3 invoices waiting · 1 is late');
    expect(money.url).toBe(`handsfreeos://app/w/${BIZ}/money`);
    const theirs = buildWidgetsData({ ...base, money: null }).moments[0]!.face.money;
    expect(theirs.allowed).toBe(false);
    expect(theirs.figures).toEqual([]);
    expect(theirs.note).toMatch(/Ask an owner/);
  });

  it('offers quick actions the person may take, always four with Ask last', () => {
    expect(widgetActions(base).map((a) => [a.key, a.url])).toEqual([
      ['contact', `handsfreeos://app/w/${BIZ}/customers/new`],
      ['receipt', `handsfreeos://app/w/${BIZ}/money/expenses?add=1`],
      ['invoice', `handsfreeos://app/w/${BIZ}/money/invoices/new`],
      ['ask', `handsfreeos://app/w/${BIZ}/assistant?talk=1`],
    ]);
    const member = widgetActions({
      ...base,
      can: { contacts: true, receipts: false, invoices: false },
    });
    expect(member.map((a) => a.key)).toEqual(['contact', 'calendar', 'tasks', 'ask']);
    const none = widgetActions({
      ...base,
      can: { contacts: false, receipts: false, invoices: false },
    });
    expect(none.map((a) => a.key)).toEqual(['calendar', 'tasks', 'ask']);
  });

  it('carries an add-on’s own figures, or why it isn’t on', () => {
    const on = buildWidgetsData(base).moments[0]!.face.addons.outreach!;
    expect(on).toEqual({
      title: 'Social Outreach',
      on: true,
      figures: [
        { label: 'First messages', value: '12 of 20', tone: null },
        { label: 'Replies to OK', value: '2', tone: 'accent' },
        { label: 'To OK', value: '1', tone: 'accent' },
      ],
      note: '3 messages wait for your OK.',
      url: `handsfreeos://app/w/${BIZ}/a/outreach?view=waiting`,
    });
    const off = buildWidgetsData({
      ...base,
      addons: [{ addonId: 'outreach', name: 'Social Outreach', facts: null }],
    }).moments[0]!.face.addons.outreach!;
    expect(off.on).toBe(false);
    expect(off.note).toBe(
      'Social Outreach isn’t on for you in Lone Star HVAC. Ask an owner of this business to turn it on in Add-ons.',
    );
  });

  it('words Social Outreach’s goal before it can be asked for, and once it’s met', () => {
    expect(outreachWidgetFacts({ goals: null, replies: 0, messages: 0 }).figures[0]!.value).toBe(
      '–',
    );
    expect(outreachWidgetFacts({ goals: [], replies: 0, messages: 0 }).figures[0]!.value).toBe(
      'No goal today',
    );
    const met = outreachWidgetFacts({
      goals: [
        { done: 10, most: 10 },
        { done: 5, most: 4 },
      ],
      replies: 0,
      messages: 0,
    });
    expect(met.figures[0]).toEqual({ label: 'First messages', value: '15 of 14', tone: 'good' });
    expect(met.note).toBe('Nothing waiting for your OK.');
  });

  it('reads back only a version it knows', () => {
    const data = buildWidgetsData(base);
    expect(readWidgetsData(JSON.stringify(data))).toEqual(data);
    expect(readWidgetsData(null)).toBeNull();
    expect(readWidgetsData('not json')).toBeNull();
    expect(readWidgetsData(JSON.stringify({ ...data, v: 2 }))).toBeNull();
    expect(readWidgetsData(JSON.stringify({ ...data, moments: [] }))).toBeNull();
  });

  it('is the same copy when nothing changed but the time it was built', () => {
    const a = buildWidgetsData(base);
    const b = buildWidgetsData({ ...base, now: NOW + 1000 });
    expect(widgetsKey(a)).toBe(widgetsKey(b));
    const c = buildWidgetsData({ ...base, hideNames: true });
    expect(widgetsKey(a)).not.toBe(widgetsKey(c));
  });

  it('links with the app’s own scheme', () => {
    expect(widgetUrl(BIZ)).toBe(`handsfreeos://app/w/${BIZ}`);
    expect(widgetUrl(BIZ, '?item=x')).toBe(`handsfreeos://app/w/${BIZ}?item=x`);
    expect(widgetUrl(BIZ, '/money')).toBe(`handsfreeos://app/w/${BIZ}/money`);
  });

  it('names every widget for the gallery', () => {
    expect(Object.keys(WIDGET_GALLERY)).toEqual([
      'myday',
      'today',
      'needs',
      'quick',
      'money',
      'outreach',
      'ask',
      'lock',
    ]);
    for (const w of Object.values(WIDGET_GALLERY)) {
      expect(w.name.length).toBeGreaterThan(0);
      expect(w.description.length).toBeLessThanOrEqual(80);
    }
  });
});
