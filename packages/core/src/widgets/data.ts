/**
 * What the home-screen widgets show (docs/phone-widgets.md): one copy the app writes where the widgets can read it,
 * the App Group on iPhone and the app's own preferences on Android, under the shared store's `widgets` key.
 *
 * The widgets are drawn with no app running: SwiftUI on iPhone, the app's own drawing code started on its own by
 * Android. So everything is worked out here, ahead of time and in words: each row's time, title and line, the counts,
 * the money figures, every link. A widget only picks the moment it's in and lays the words out.
 *
 * **Moments.** A day moves on without the app: an appointment starts ("Now"), ends and drops off, and at midnight the
 * list becomes the next day's. So the copy holds the face of every widget for each moment that changes it, from now
 * to the end of tomorrow, and a widget shows the latest moment that has begun (`widgetFaceAt`). An iPhone hands them
 * to WidgetKit as its timeline; Android looks again each time it redraws.
 *
 * Browser-safe and pure: the phone gathers what it has, this decides what the widgets say.
 */
import { ATTENTION_KIND_LABELS, isAttentionKind } from '../attention/kinds';
import { areaOf, subtitleOf, type AgendaAppointment } from '../calendar/agenda';
import { addDays, localDateOf, startOfLocalDay } from '../calendar/engine/zoned';
import { fmtDateShort, fmtTime } from '../calendar/when';
import { money, moneyRounded } from '../money/format';
import { WIDGET_EMPTY_WORDS, WIDGET_WORDS as W } from './words';

/** Bumped when the shape changes: a widget reads only the versions it knows, and says to open the app otherwise. */
export const WIDGETS_DATA_VERSION = 1;

/** Where the app keeps the copy, under the shared store (modules/hfos-shared). */
export const WIDGETS_DATA_KEY = 'widgets';

/**
 * Kept small: the copy sits outside the app's encrypted copy of the business, and a widget has little memory. Eight
 * rows fill the largest widget; Android's lists scroll through them.
 */
export const WIDGET_LIMITS = {
  rows: 8,
  moments: 40,
  addonFigures: 3,
} as const;

/** The row counts a widget shows before its "+N more": a small one, a medium one and a large one. */
export const WIDGET_SHOWN = [1, 3, 6] as const;

export type WidgetTone = 'accent' | 'danger' | 'good' | 'muted' | null;

/** One line of a list: an appointment, or something that needs the person. */
export interface WidgetRow {
  readonly id: string;
  /** The column on the left: "2:30 PM", "Now", "Urgent", or empty. */
  readonly lead: string;
  readonly title: string;
  /** The line under it, or null. */
  readonly detail: string | null;
  readonly tone: WidgetTone;
  /** What tapping it opens (the app's own `handsfreeos://` link). */
  readonly url: string;
}

export interface WidgetList {
  readonly title: string;
  readonly count: number;
  /** "3 appointments", "5 need you". */
  readonly countWords: string;
  readonly rows: readonly WidgetRow[];
  /** What a widget showing 1, 3 or 6 rows says under them: "+4 more", or null when they all fit. */
  readonly more: Readonly<Record<'1' | '3' | '6', string | null>>;
  /** What it says with no rows. */
  readonly empty: string;
  readonly url: string;
}

export interface WidgetToday extends WidgetList {
  /** "Fri, Nov 28". */
  readonly date: string;
  /** "3 tasks due today", or null with none. */
  readonly tasks: string | null;
  readonly tasksUrl: string;
}

export interface WidgetNeeds extends WidgetList {
  readonly urgent: number;
}

export interface WidgetFigure {
  readonly label: string;
  readonly value: string;
  readonly tone: WidgetTone;
}

export interface WidgetMoney {
  readonly title: string;
  /** Whether this person manages money here. When not, `note` says who does and there are no figures. */
  readonly allowed: boolean;
  readonly figures: readonly WidgetFigure[];
  readonly note: string | null;
  readonly url: string;
}

/** An add-on's widget (Social Outreach's): its figures while it's on for the person, and why not otherwise. */
export interface WidgetAddon {
  readonly title: string;
  readonly on: boolean;
  readonly figures: readonly WidgetFigure[];
  readonly note: string | null;
  readonly url: string;
}

export type WidgetActionKey = 'contact' | 'receipt' | 'invoice' | 'calendar' | 'tasks' | 'ask';

export interface WidgetAction {
  /** Which icon the widget draws. */
  readonly key: WidgetActionKey;
  readonly label: string;
  readonly url: string;
}

/** The lock screen's widgets, which never name anyone (the owner's pick, 27 Nov 2026). */
export interface WidgetLock {
  /** "2:30 PM · Duct cleaning", or "Nothing else today". */
  readonly line: string;
  readonly time: string | null;
  readonly what: string | null;
  readonly needs: number;
  readonly needsWords: string;
}

export interface WidgetFace {
  readonly today: WidgetToday;
  readonly needs: WidgetNeeds;
  readonly money: WidgetMoney;
  readonly quick: { readonly title: string; readonly actions: readonly WidgetAction[] };
  readonly ask: { readonly title: string; readonly hint: string; readonly url: string };
  readonly lock: WidgetLock;
  /** By add-on id. */
  readonly addons: Readonly<Record<string, WidgetAddon>>;
}

export interface WidgetMoment {
  /** When this face begins (ISO). */
  readonly at: string;
  readonly face: WidgetFace;
}

export interface WidgetsData {
  readonly v: typeof WIDGETS_DATA_VERSION;
  readonly business: { readonly id: string; readonly name: string };
  /** Whether the widgets name the business: the person has more than one. */
  readonly showBusiness: boolean;
  readonly hideNames: boolean;
  /** When the app built it (ISO). */
  readonly updatedAt: string;
  /** The business's Home in the app: what tapping a widget's header opens. */
  readonly url: string;
  /** From now on, oldest first; the first begins when the copy was built. */
  readonly moments: readonly WidgetMoment[];
  readonly words: {
    readonly updated: string;
    readonly signedOut: string;
    readonly locked: string;
  };
}

// ---------- what the phone gathers ----------

/** An appointment the person sees in Calendar, with its service's name when it has one. */
export interface WidgetAppointment extends AgendaAppointment {
  readonly serviceName?: string | null;
}

/** One of the person's open tasks (Tasks' Mine). */
export interface WidgetTaskInput {
  readonly id: string;
  readonly dueAt: string | null;
  readonly allDay: boolean;
}

/** One Home card, as `attention.list` (and the phone's Home) gives it. */
export interface WidgetNeedsItem {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly urgent: boolean;
}

export interface WidgetNeedsInput {
  /** Ranked as Home ranks them. */
  readonly items: readonly WidgetNeedsItem[];
  readonly total: number;
  readonly urgent: number;
}

/** The money figures, for someone who manages money (Money's headline figures, and what came in). */
export interface WidgetMoneyInput {
  readonly outstandingCents: number;
  readonly outstandingCount: number;
  readonly overdueCents: number;
  readonly overdueCount: number;
  readonly todayCents: number;
  readonly weekCents: number;
}

/** What an add-on puts on its widget (its own words), and the page under the business a tap opens (`a/outreach…`). */
export interface AddonWidgetFacts {
  readonly figures: readonly WidgetFigure[];
  readonly note: string | null;
  readonly path: string;
}

export interface WidgetAddonInput {
  readonly addonId: string;
  /** Its name, for when it isn't on: "Social Outreach". */
  readonly name: string;
  /** Null while it isn't on for this person in the business. */
  readonly facts: AddonWidgetFacts | null;
}

export interface WidgetsInput {
  readonly now: number;
  /** The business's time zone: "today" is where the business is. */
  readonly timeZone: string;
  readonly business: { readonly id: string; readonly name: string };
  readonly showBusiness: boolean;
  readonly hideNames: boolean;
  /** Today's and tomorrow's appointments as Calendar shows them; cancelled and finished ones are left out here. */
  readonly appointments: readonly WidgetAppointment[];
  readonly tasks: readonly WidgetTaskInput[];
  readonly needs: WidgetNeedsInput;
  /** Null when this person doesn't manage money here. */
  readonly money: WidgetMoneyInput | null;
  /** What the person may start from Quick actions. */
  readonly can: {
    /** `records.write`: Add contact. */
    readonly contacts: boolean;
    /** `money.manage`: Snap receipt, an expense with its photo. */
    readonly receipts: boolean;
    /** `money.bill`: New invoice (written on the web). */
    readonly invoices: boolean;
  };
  readonly addons: readonly WidgetAddonInput[];
}

// ---------- links ----------

/**
 * The app's own link to a place in a business: `handsfreeos://app/w/<business>/calendar?appt=…`. The app reads it
 * through its route map (apps/mobile/src/links/route-map.ts), as it reads a notification's.
 */
export function widgetUrl(businessId: string, path = ''): string {
  const tail = !path ? '' : path.startsWith('?') ? path : `/${path.replace(/^\/+/, '')}`;
  return `handsfreeos://app/w/${businessId}${tail}`;
}

// ---------- building it ----------

const ms = (iso: string) => Date.parse(iso);

/** The appointments a widget lists: booked, and not finished, cancelled or a no-show. */
const listed = (a: WidgetAppointment) => a.status === 'scheduled';

/** What an appointment is, without anyone's name: its service, its calendar, or "Appointment". */
function whatOf(a: WidgetAppointment): string {
  return a.serviceName?.trim() || a.calendarName?.trim() || W.appointment;
}

function moreOf(count: number): Record<'1' | '3' | '6', string | null> {
  const [one, three, six] = WIDGET_SHOWN;
  return {
    '1': count > one ? W.more(count - one) : null,
    '3': count > three ? W.more(count - three) : null,
    '6': count > six ? W.more(count - six) : null,
  };
}

/** The moments that change what a widget shows: now, each start and end ahead, and the next two midnights. */
export function widgetMoments(
  appointments: readonly WidgetAppointment[],
  now: number,
  timeZone: string,
): readonly number[] {
  const today = localDateOf(now, timeZone);
  const last = startOfLocalDay(addDays(today, 2), timeZone);
  const times = new Set<number>([now]);
  times.add(startOfLocalDay(addDays(today, 1), timeZone));
  for (const a of appointments) {
    if (!listed(a)) continue;
    for (const t of [ms(a.startsAt), ms(a.endsAt)]) if (t > now && t <= last) times.add(t);
  }
  return [...times]
    .filter((t) => Number.isFinite(t))
    .sort((x, y) => x - y)
    .slice(0, WIDGET_LIMITS.moments);
}

function todayAt(input: WidgetsInput, at: number): WidgetToday {
  const { timeZone, business, hideNames } = input;
  const day = localDateOf(at, timeZone);
  const dayStart = startOfLocalDay(day, timeZone);
  const dayEnd = startOfLocalDay(addDays(day, 1), timeZone);
  const onDay = input.appointments
    .filter((a) => listed(a) && ms(a.endsAt) > at && ms(a.startsAt) < dayEnd)
    .sort((x, y) => ms(x.startsAt) - ms(y.startsAt) || x.id.localeCompare(y.id));
  const rows = onDay.slice(0, WIDGET_LIMITS.rows).map((a): WidgetRow => ({
    id: a.id,
    lead: ms(a.startsAt) <= at ? W.now : fmtTime(a.startsAt, timeZone),
    title: hideNames ? whatOf(a) : a.title || whatOf(a),
    detail: (hideNames ? areaOf(a.address) : subtitleOf(a)) || null,
    tone: ms(a.startsAt) <= at ? 'accent' : null,
    url: widgetUrl(business.id, `calendar?appt=${a.id}`),
  }));
  const due = input.tasks.filter((t) =>
    t.dueAt === null ? false : t.allDay ? t.dueAt.slice(0, 10) <= day : ms(t.dueAt) < dayEnd,
  );
  const late = due.filter((t) =>
    t.allDay ? t.dueAt!.slice(0, 10) < day : ms(t.dueAt!) < Math.max(dayStart, at),
  ).length;
  return {
    title: W.today,
    date: fmtDateShort(day),
    count: onDay.length,
    countWords: W.appointments(onDay.length),
    rows,
    more: moreOf(onDay.length),
    empty: W.nothingToday,
    url: widgetUrl(business.id, `calendar?date=${day}`),
    tasks:
      due.length === 0 ? null : late ? W.tasksOverdue(due.length, late) : W.tasksDue(due.length),
    tasksUrl: widgetUrl(business.id, 'tasks'),
  };
}

function needsOf(input: WidgetsInput): WidgetNeeds {
  const { business, hideNames, needs } = input;
  const label = (kind: string) => (isAttentionKind(kind) ? ATTENTION_KIND_LABELS[kind] : W.needs);
  const rows = needs.items.slice(0, WIDGET_LIMITS.rows).map((i): WidgetRow => ({
    id: i.id,
    lead: i.urgent ? W.urgent : '',
    title: hideNames ? label(i.kind) : i.title,
    detail: hideNames ? null : i.detail,
    tone: i.urgent ? 'danger' : null,
    url: widgetUrl(business.id, `?item=${i.id}`),
  }));
  return {
    title: W.needs,
    count: needs.total,
    countWords: needs.total ? W.needCount(needs.total) : W.nothingNeeds,
    urgent: needs.urgent,
    rows,
    more: moreOf(needs.total),
    empty: W.nothingNeeds,
    url: widgetUrl(business.id),
  };
}

function moneyOf(input: WidgetsInput): WidgetMoney {
  const url = widgetUrl(input.business.id, 'money');
  const m = input.money;
  const P = W.moneyParts;
  if (!m) return { title: W.money, allowed: false, figures: [], note: P.notYours, url };
  return {
    title: W.money,
    allowed: true,
    figures: [
      { label: P.owed, value: money(m.outstandingCents), tone: null },
      { label: P.late, value: money(m.overdueCents), tone: m.overdueCents > 0 ? 'danger' : null },
      {
        label: P.inToday,
        value: moneyRounded(m.todayCents),
        tone: m.todayCents > 0 ? 'good' : null,
      },
      { label: P.inWeek, value: moneyRounded(m.weekCents), tone: null },
    ],
    note: m.outstandingCount
      ? `${P.waiting(m.outstandingCount)}${m.overdueCount ? ` · ${P.lateNote(m.overdueCount)}` : ''}`
      : P.nothingWaiting,
    url,
  };
}

/**
 * Quick actions: three things to start, then Ask. Each only for someone who may do it; Calendar and Tasks fill a
 * place someone can't use, so the row is always four.
 */
export function widgetActions(input: Pick<WidgetsInput, 'business' | 'can'>): WidgetAction[] {
  const id = input.business.id;
  const A = W.quickActions;
  const wanted: WidgetAction[] = [
    ...(input.can.contacts
      ? [{ key: 'contact' as const, label: A.contact, url: widgetUrl(id, 'customers/new') }]
      : []),
    ...(input.can.receipts
      ? [{ key: 'receipt' as const, label: A.receipt, url: widgetUrl(id, 'money/expenses?add=1') }]
      : []),
    ...(input.can.invoices
      ? [{ key: 'invoice' as const, label: A.invoice, url: widgetUrl(id, 'money/invoices/new') }]
      : []),
    { key: 'calendar', label: A.calendar, url: widgetUrl(id, 'calendar') },
    { key: 'tasks', label: A.tasks, url: widgetUrl(id, 'tasks') },
  ];
  return [
    ...wanted.slice(0, 3),
    { key: 'ask', label: A.ask, url: widgetUrl(id, 'assistant?talk=1') },
  ];
}

function addonsOf(input: WidgetsInput): Record<string, WidgetAddon> {
  const out: Record<string, WidgetAddon> = {};
  for (const a of input.addons) {
    out[a.addonId] = a.facts
      ? {
          title: a.name,
          on: true,
          figures: a.facts.figures.slice(0, WIDGET_LIMITS.addonFigures),
          note: a.facts.note,
          url: widgetUrl(input.business.id, a.facts.path),
        }
      : {
          title: a.name,
          on: false,
          figures: [],
          note: W.addonOff(a.name, input.business.name),
          url: widgetUrl(input.business.id),
        };
  }
  return out;
}

function lockOf(
  today: WidgetToday,
  needs: WidgetNeeds,
  input: WidgetsInput,
  at: number,
): WidgetLock {
  const next = input.appointments
    .filter((a) => listed(a) && ms(a.endsAt) > at)
    .sort((x, y) => ms(x.startsAt) - ms(y.startsAt))
    .find((a) => today.rows.some((r) => r.id === a.id));
  const time = next
    ? ms(next.startsAt) <= at
      ? W.now
      : fmtTime(next.startsAt, input.timeZone)
    : null;
  const what = next ? whatOf(next) : null;
  return {
    line: time && what ? W.lockNext(time, what) : W.lockNothing,
    time,
    what,
    needs: needs.count,
    needsWords: needs.countWords,
  };
}

/** Every widget's face at one moment. */
function faceAt(
  input: WidgetsInput,
  at: number,
  fixed: Omit<WidgetFace, 'today' | 'lock'>,
): WidgetFace {
  const today = todayAt(input, at);
  return { ...fixed, today, lock: lockOf(today, fixed.needs, input, at) };
}

/** The copy the widgets read, from what the phone has. */
export function buildWidgetsData(input: WidgetsInput): WidgetsData {
  const id = input.business.id;
  const fixed: Omit<WidgetFace, 'today' | 'lock'> = {
    needs: needsOf(input),
    money: moneyOf(input),
    quick: { title: W.quick, actions: widgetActions(input) },
    ask: { title: W.ask, hint: W.askHint, url: widgetUrl(id, 'assistant?talk=1') },
    addons: addonsOf(input),
  };
  return {
    v: WIDGETS_DATA_VERSION,
    business: { id, name: input.business.name },
    showBusiness: input.showBusiness,
    hideNames: input.hideNames,
    updatedAt: new Date(input.now).toISOString(),
    url: widgetUrl(id),
    moments: widgetMoments(input.appointments, input.now, input.timeZone).map((at) => ({
      at: new Date(at).toISOString(),
      face: faceAt(input, at, fixed),
    })),
    words: { updated: W.updated, ...WIDGET_EMPTY_WORDS },
  };
}

// ---------- reading it back ----------

/** The copy as saved, or null when there's none, it can't be read, or it's a version this app doesn't know. */
export function readWidgetsData(json: string | null | undefined): WidgetsData | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as Partial<WidgetsData> | null;
    if (!data || data.v !== WIDGETS_DATA_VERSION || !Array.isArray(data.moments)) return null;
    if (!data.moments.length || !data.business) return null;
    return data as WidgetsData;
  } catch {
    return null;
  }
}

/** The face a widget shows now: the latest moment that has begun, or the first while none has. */
export function widgetFaceAt(data: WidgetsData, now: number): WidgetFace {
  let face = data.moments[0]!.face;
  for (const m of data.moments) {
    if (ms(m.at) <= now) face = m.face;
    else break;
  }
  return face;
}

/**
 * Whether two copies say the same, whenever they were built: what the app compares before saving again, so a
 * widget isn't reloaded for nothing (an iPhone limits how often a widget may reload).
 */
export function widgetsKey(data: WidgetsData): string {
  return JSON.stringify({
    ...data,
    updatedAt: '',
    moments: data.moments.map((m, i) => ({ at: i === 0 ? '' : m.at, face: m.face })),
  });
}
