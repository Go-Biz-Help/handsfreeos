/**
 * What a funnel's parts say in a line, for the steps, the map, a person's funnel line, the timeline and the phone.
 * Browser-safe, and the one place each is worded, so the web and the phone say it the same way.
 */
import { clockLabel, dayLabel } from '../attention/wording';
import { INTAKE_NAMES } from '../crm/intake-kinds';
import {
  FUNNEL_EVENTS,
  type FunnelEntryRule,
  type FunnelLeftReason,
  type FunnelMove,
  type FunnelOnlyIf,
  type FunnelPauseReason,
  type FunnelStatus,
  type FunnelWhen,
} from './definition';

const DAY = 24 * 60;
const WEEK = 7 * DAY;

/** "5 minutes", "1 hour", "1 hour 30 minutes", "2 days", "1 week". */
export function funnelDurationWords(minutes: number): string {
  const m = Math.abs(Math.round(minutes));
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (m === 0) return '0 minutes';
  if (m % WEEK === 0) return n(m / WEEK, 'week');
  if (m % DAY === 0) return n(m / DAY, 'day');
  if (m >= DAY) {
    const d = Math.floor(m / DAY);
    const h = Math.round((m - d * DAY) / 60);
    return h ? `${n(d, 'day')} ${n(h, 'hour')}` : n(d, 'day');
  }
  if (m % 60 === 0) return n(m / 60, 'hour');
  if (m > 60) return `${n(Math.floor(m / 60), 'hour')} ${n(m % 60, 'minute')}`;
  return n(m, 'minute');
}

/** "16:00" as "4:00 PM". */
export function funnelClockWords(clock: string): string {
  const [h = 0, mm = 0] = clock.split(':').map(Number);
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Right away", "30 minutes after they arrive", "1 hour before it starts", "The day before, at 4:00 PM". */
export function funnelWhenWords(w: FunnelWhen): string {
  switch (w.kind) {
    case 'arrive':
      return w.minutes === 0 ? 'Right away' : `${funnelDurationWords(w.minutes)} after they arrive`;
    case 'booking':
      if (w.minutes === 0) return 'When it starts';
      return w.minutes < 0
        ? `${funnelDurationWords(w.minutes)} before it starts`
        : `${funnelDurationWords(w.minutes)} after it starts`;
    case 'booking_day': {
      const at = funnelClockWords(w.at);
      if (w.daysBefore === 0) return `On the day, at ${at}`;
      if (w.daysBefore === 1) return `The day before, at ${at}`;
      return `${w.daysBefore} days before, at ${at}`;
    }
  }
}

/** The same, short, for a box on the map: "Day before, 4:00 PM", "1 hr before", "7:05 PM, 5 min in". */
export function funnelWhenShort(w: FunnelWhen): string {
  const short = (minutes: number) =>
    funnelDurationWords(minutes)
      .replace(/ hours?/, ' hr')
      .replace(/ minutes?/, ' min');
  switch (w.kind) {
    case 'arrive':
      return w.minutes === 0 ? 'On arriving' : `${short(w.minutes)} after arriving`;
    case 'booking':
      if (w.minutes === 0) return 'At the start';
      return w.minutes < 0 ? `${short(w.minutes)} before` : `${short(w.minutes)} in`;
    case 'booking_day':
      return `${w.daysBefore === 0 ? 'On the day' : w.daysBefore === 1 ? 'Day before' : `${w.daysBefore} days before`}, ${funnelClockWords(w.at)}`;
  }
}

/** "Only if they haven’t joined", "Only if they’ve written back". */
export function funnelOnlyIfWords(o: FunnelOnlyIf): string {
  const past = FUNNEL_EVENTS[o.event].past;
  return o.has ? `Only if they’ve ${past}` : `Only if they haven’t ${past}`;
}

export interface FunnelNames {
  /** Pipeline stage names by id. */
  readonly stages: ReadonlyMap<string, string>;
  readonly forms?: ReadonlyMap<string, string>;
  readonly calendars?: ReadonlyMap<string, string>;
}

/** What causes a move, as its arrow's label says it: "they book", "they say they’re interested", "3 days quiet". */
export function funnelMoveCause(m: FunnelMove, names?: FunnelNames): string {
  switch (m.kind) {
    case 'event': {
      const base: string = FUNNEL_EVENTS[m.event].label;
      const form = m.formId ? names?.forms?.get(m.formId) : null;
      const cal = m.calendarId ? names?.calendars?.get(m.calendarId) : null;
      if (form) return `${base}: ${form}`;
      if (cal) return `${base}: ${cal}`;
      return base;
    }
    case 'reply':
      return m.says;
    case 'quiet':
      return `${funnelDurationWords(m.minutes)} quiet`;
  }
}

/** "They book → Booked". */
export function funnelMoveWords(m: FunnelMove, names: FunnelNames): string {
  const cause = funnelMoveCause(m, names);
  const to = names.stages.get(m.to) ?? 'a stage that’s gone';
  return `${cause.charAt(0).toUpperCase()}${cause.slice(1)} → ${to}`;
}

/** "A new lead in Recruiting", "A new lead from a Facebook lead ad or Indeed", "They send Join our team". */
export function funnelEntryWords(
  r: FunnelEntryRule,
  pipelineName: string,
  names?: Pick<FunnelNames, 'forms' | 'calendars'>,
): string {
  switch (r.kind) {
    case 'new_lead':
      return `A new lead in ${pipelineName}`;
    case 'came_in': {
      const ways = r.ways.map((w) => INTAKE_NAMES[w]);
      const list =
        ways.length <= 1
          ? (ways[0] ?? '')
          : `${ways.slice(0, -1).join(', ')} or ${ways[ways.length - 1]}`;
      return `A new lead from ${/^[AEIOU]/.test(list) ? 'an' : 'a'} ${list}`;
    }
    case 'form':
      return `They send ${names?.forms?.get(r.formId) ?? 'a form'}`;
    case 'booking':
      return `They book ${names?.calendars?.get(r.calendarId) ?? 'a calendar'}`;
  }
}

export const FUNNEL_STATUS_WORDS: Readonly<Record<FunnelStatus, string>> = {
  draft: 'Draft',
  on: 'On',
  paused: 'Paused',
  archived: 'Archived',
};

export const FUNNEL_PAUSE_WORDS: Readonly<Record<FunnelPauseReason, string>> = {
  taken_over: 'someone on the team is talking to them',
  handed_off: 'the teammate handed them to the team',
  by_hand: 'paused by hand',
};

/**
 * A customer's funnel line, on the web (their page, their lead, beside the conversation) and on the phone: what it
 * says and what its buttons say.
 */
export const FUNNEL_PERSON_WORDS = {
  paused: (reason: FunnelPauseReason | null) =>
    !reason || reason === 'by_hand' ? 'Paused by hand' : `Paused: ${FUNNEL_PAUSE_WORDS[reason]}`,
  next: (text: string, dueAt: number, timeZone: string) =>
    `Next: ${funnelNextWords(text, dueAt, timeZone)}`,
  pause: 'Pause',
  resume: 'Resume',
  moveTo: 'Move to',
  remove: (funnel: string) => `Remove from ${funnel}`,
  add: 'Add to a funnel',
  suggested: (funnel: string, why: string | null) =>
    `Suggested for ${funnel}${why ? `: ${why}` : ''}`,
  yes: 'Yes, put them in',
  no: 'No',
  pausedDone: (funnel: string, name: string) =>
    `${funnel} is paused for ${name}. Nothing goes out until you resume it.`,
  resumedDone: (funnel: string, name: string) => `${funnel} picks back up for ${name}.`,
  movedDone: (name: string, stage: string) => `${name} is at ${stage} now.`,
  removedDone: (funnel: string, name: string) =>
    `${name} is out of ${funnel}. Their lead stays where it is.`,
  addedDone: (funnel: string) => `They’re in ${funnel} now.`,
  declinedDone: (funnel: string) => `They won’t be suggested for ${funnel} again.`,
} as const;

export const FUNNEL_LEFT_WORDS: Readonly<Record<FunnelLeftReason, string>> = {
  won: 'they reached a won stage',
  lost: 'they reached a lost stage',
  removed: 'taken out by hand',
  outside: 'moved to a stage the funnel doesn’t use',
  other_funnel: 'they joined another funnel',
  opted_out: 'they asked for no more texts',
  funnel_archived: 'the funnel was archived',
  lead_gone: 'their lead was archived or deleted',
};

/** "Booked for Thu, Oct 29 at 7:00 PM", or the stage alone. */
export function funnelWhereWords(
  stageName: string,
  booking: { readonly startsAt: number } | null,
  timeZone: string,
): string {
  if (!booking) return stageName;
  return `${stageName} for ${dayLabel(booking.startsAt, timeZone)} at ${clockLabel(booking.startsAt, timeZone)}`;
}

/** "Thu, Oct 29, 7:00 PM": a moment in the funnel, where the business is (trying it as a lead, a person's line). */
export function funnelAtWords(at: number, timeZone: string): string {
  return `${dayLabel(at, timeZone)}, ${clockLabel(at, timeZone)}`;
}

/** "“Starts in an hour” at Thu, Oct 29 at 6:00 PM": a message's first words and when it's due. */
export function funnelNextWords(text: string, dueAt: number, timeZone: string): string {
  const words = text.replace(/\s+/g, ' ').trim();
  const cut = words.length > 48 ? `${words.slice(0, 46).trimEnd()}…` : words;
  return `“${cut}” at ${dayLabel(dueAt, timeZone)}, ${clockLabel(dueAt, timeZone)}`;
}

/**
 * What the timeline says someone did, after who did it (subtype `funnel_*`): "put them in Recruiting at New lead",
 * "took them out of Recruiting: they reached a won stage", "paused Recruiting for them".
 */
export function funnelTimelineWords(subtype: string, meta: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : '');
  const funnel = s('funnel') || 'a funnel';
  switch (subtype) {
    case 'funnel_joined':
      return `put them in ${funnel}${s('stage') ? ` at ${s('stage')}` : ''}`;
    case 'funnel_left': {
      const reason = s('reason') as FunnelLeftReason;
      const why = reason === 'removed' ? null : FUNNEL_LEFT_WORDS[reason];
      return `took them out of ${funnel}${why ? `: ${why}` : ''}`;
    }
    case 'funnel_paused': {
      const reason = s('reason') as FunnelPauseReason;
      const why = reason === 'by_hand' ? null : FUNNEL_PAUSE_WORDS[reason];
      return `paused ${funnel} for them${why ? `: ${why}` : ''}`;
    }
    case 'funnel_resumed':
      return `picked ${funnel} back up for them`;
    default:
      return null;
  }
}
