/**
 * The calendar's URL state: `?view=&date=&people=&calendars=&appt=`, and New appointment with its prefill:
 * `?new=1&date=YYYY-MM-DD&start=HH:MM&person=<userId>&service=<serviceId>&calendar=<calendarId>&customer=<personId>`.
 * Everything on screen can be linked to (the Assistant does) and survives a reload.
 */
import { isLocalDate } from '@hfos/core';

export const CALENDAR_VIEWS = ['team', 'week', 'day', 'month', 'resources'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export interface CalendarQuery {
  readonly view: CalendarView;
  readonly date: string;
  /** Team: the people shown (null is everyone). Week, Day and Month: the one person (null is you). */
  readonly people: readonly string[] | null;
  /** The calendars shown; null is all of them. */
  readonly calendars: readonly string[] | null;
  /** The appointment open in the side sheet. */
  readonly appt: string | null;
  /** New appointment is open. */
  readonly new: boolean;
  /** Its prefill: start time ('HH:MM'), who does it, service, calendar and customer. */
  readonly start: string | null;
  readonly person: string | null;
  readonly service: string | null;
  readonly calendar: string | null;
  readonly customer: string | null;
}

type Search = Record<string, string | string[] | undefined>;

const ID = /^[0-9a-f-]{36}$/i;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
const id = (v: string | string[] | undefined) => {
  const s = one(v);
  return s && ID.test(s) ? s : null;
};
const ids = (v: string | string[] | undefined): string[] | null => {
  const list = (one(v) ?? '').split(',').filter((s) => ID.test(s));
  return list.length ? list : null;
};

export function parseCalendarQuery(sp: Search, today: string): CalendarQuery {
  const view = one(sp.view);
  const date = one(sp.date);
  const start = one(sp.start);
  return {
    view: (CALENDAR_VIEWS as readonly string[]).includes(view ?? '')
      ? (view as CalendarView)
      : 'team',
    date: date && isLocalDate(date) ? date : today,
    people: ids(sp.people),
    calendars: ids(sp.calendars),
    appt: id(sp.appt),
    new: one(sp.new) === '1',
    start: start && CLOCK.test(start) ? start : null,
    person: id(sp.person),
    service: id(sp.service),
    calendar: id(sp.calendar),
    customer: id(sp.customer),
  };
}

/** The calendar's address for a state; defaults (Team view, today, everyone) are left out. */
export function calendarHref(
  workspaceId: string,
  q: Partial<CalendarQuery>,
  today?: string,
): string {
  const p = new URLSearchParams();
  if (q.view && q.view !== 'team') p.set('view', q.view);
  if (q.date && q.date !== today) p.set('date', q.date);
  if (q.people?.length) p.set('people', q.people.join(','));
  if (q.calendars?.length) p.set('calendars', q.calendars.join(','));
  if (q.appt) p.set('appt', q.appt);
  if (q.new) {
    p.set('new', '1');
    if (q.start) p.set('start', q.start);
    if (q.person) p.set('person', q.person);
    if (q.service) p.set('service', q.service);
    if (q.calendar) p.set('calendar', q.calendar);
    if (q.customer) p.set('customer', q.customer);
  }
  const s = p.toString();
  return `/app/w/${workspaceId}/calendar${s ? `?${s}` : ''}`;
}

/** Closing New appointment: the flag and its prefill go. */
export const CLOSED_NEW: Partial<CalendarQuery> = {
  new: false,
  start: null,
  person: null,
  service: null,
  calendar: null,
  customer: null,
};
