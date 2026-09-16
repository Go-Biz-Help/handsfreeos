import type { ScriptRule } from '@hfos/ai';
import { addDays, localDateOf, localInstant, weekdayOf } from '@hfos/core/server';
import { isoWithOffset } from './calendar-format';

/**
 * The scripted Assistant's Action Center phrases (scripted.ts puts them first): "What needs my attention?", "Handle
 * the first one", "Snooze Maria's lead until tomorrow", "Dismiss the Kevin one, already handled" and "Give the
 * Maria one to Priya". Item ids come from the context's "Needs attention" list, which is in Home's order.
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parse = (json: string | undefined): Record<string, unknown> => {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export interface ListedItem {
  readonly title: string;
  readonly id: string;
}

/** The items the context lists: "1. Maria Lopez · AC install [Hot lead, urgent] $18,500 (attention item id …)". */
export function listedItems(context: string): ListedItem[] {
  const line = new RegExp(
    `^\\d+\\. (.+?) \\[[^\\]\\n]*\\][^\\n]*\\(attention item id ${UUID}\\)$`,
    'gm',
  );
  return [...context.matchAll(line)].map((m) => ({ title: m[1]!, id: m[2]! }));
}

const PLACES: Readonly<Record<string, number>> = {
  first: 1,
  top: 1,
  next: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
};

/** The listed item the words mean: a place ("the first one", "it") or a name in its title ("Maria's lead"). */
export function itemMeant(context: string, words: string): ListedItem | undefined {
  const items = listedItems(context);
  const key = words
    .trim()
    .replace(/[.?!]+$/, '')
    .replace(/^(?:the|my|our)\s+/i, '')
    .replace(/\s+(?:one|lead|item|appointment|visit|task|conversation|job|card)$/i, '')
    .replace(/['’]s$/i, '')
    .trim()
    .toLowerCase();
  if (!key) return undefined;
  if (/^(?:it|that|this)$/.test(key)) return items[0];
  if (key === 'last') return items.at(-1);
  const place = PLACES[key];
  if (place) return items[place - 1];
  return items.find((i) => new RegExp(`\\b${escape(key)}\\b`, 'i').test(i.title));
}

/** A teammate by first name, from the context's team: "- Priya Natarajan, member (user id …)". */
const teammateId = (context: string, first: string) =>
  new RegExp(`^- ${escape(first)}[^,\\n]*, [^\\n]*\\(user id ${UUID}\\)$`, 'im').exec(context)?.[1];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const COUNTS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * When a snooze the person asked for ends, in the business's zone, with its offset: "tomorrow" is 8:00 AM tomorrow,
 * "next week" 8:00 AM Monday, a weekday 8:00 AM that day, "for an hour" an hour from now, "tonight" 6:00 PM, and
 * "at 2 pm" sets the time.
 */
export function untilFrom(words: string, context: string, now = Date.now()): string {
  const tz = /\(time zone ([^)]+)\)/.exec(context)?.[1] ?? 'America/Chicago';
  const today = localDateOf(now, tz);
  const clock = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(words);
  const time = clock
    ? `${pad((Number(clock[1]) % 12) + (/pm/i.test(clock[3]!) ? 12 : 0))}:${clock[2] ?? '00'}`
    : '08:00';
  const on = (date: string, t = time) => isoWithOffset(localInstant(date, t, tz), tz);
  const next = (weekday: number) => {
    let d = addDays(today, 1);
    while (weekdayOf(d) !== weekday) d = addDays(d, 1);
    return d;
  };
  const hours = /\b(a|an|one|two|three|four|\d+)\s+hours?\b/i.exec(words);
  if (hours) {
    const n = COUNTS[hours[1]!.toLowerCase()] ?? Number(hours[1]);
    return isoWithOffset(now + n * 3_600_000, tz);
  }
  if (/\b(?:tonight|this evening)\b/i.test(words)) return on(today, '18:00');
  if (/\bnext week\b/i.test(words)) return on(next(1));
  const weekday = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`, 'i').test(words));
  if (weekday >= 0) return on(next(weekday));
  if (/\btoday\b/i.test(words) && clock) return on(today);
  return on(addDays(today, 1));
}

/** The answer to a card-making tool: its error, why it can't go ahead, or the line given. */
const cardReply =
  (tool: string, ok: string, stopped: readonly string[]) =>
  (_q: string, r: Readonly<Record<string, string>>) => {
    if (!r[tool]) return 'I can’t find that one on your list.';
    const out = parse(r[tool]);
    if (out['error']) return `That didn’t work: ${String(out['error'])}`;
    for (const key of stopped) if (out[key]) return String(out[key]);
    return ok;
  };

const HANDLE = /^(?:handle|take care of|deal with) (.+?)\.?$/i;
const SNOOZE = /^snooze (.+?) (?:until|till|for) (.+?)\.?$/i;
const DISMISS_BECAUSE = /^dismiss (.+?)(?:\s*[,;:—–]\s*|\s+-\s+|\s+because\s+)(.+?)\.?$/i;
const DISMISS = /^dismiss (.+?)\.?$/i;
const ASSIGN = /^(?:assign|give) (.+?) to (\w+)\.?$/i;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const attentionRules: ScriptRule[] = [
  {
    when: /what needs (?:my )?attention|what.s waiting/i,
    calls: () => [{ name: 'what_needs_attention', arguments: {} }],
    reply: (_q, r) => {
      const out = parse(r['what_needs_attention']);
      if (out['error']) return `That didn’t work: ${String(out['error'])}`;
      const total = Number((out['counts'] as { total?: number } | undefined)?.total ?? 0);
      const first = (out['items'] as { title: string }[] | undefined)?.[0];
      if (!total || !first) return 'Nothing needs you right now.';
      const affected =
        Number(out['affectedCents'] ?? 0) > 0 ? `, ${String(out['affected'])} affected` : '';
      return `${total === 1 ? 'One thing needs' : `${total} things need`} attention${affected}. First up: ${first.title}.`;
    },
  },
  {
    // "Handle the first one", "Handle Maria's".
    when: HANDLE,
    calls: (q, context) => {
      const item = itemMeant(context, HANDLE.exec(q)![1]!);
      return item ? [{ name: 'handle_attention_item', arguments: { itemId: item.id } }] : [];
    },
    reply: cardReply(
      'handle_attention_item',
      'Here’s what would happen. Nothing happens until you OK it.',
      ['cannotHandle'],
    ),
  },
  {
    // "Snooze Maria's lead until tomorrow", "Snooze the first one for an hour".
    when: SNOOZE,
    calls: (q, context) => {
      const [, words, until] = SNOOZE.exec(q)!;
      const item = itemMeant(context, words!);
      return item
        ? [
            {
              name: 'update_attention_item',
              arguments: { itemId: item.id, action: 'snooze', until: untilFrom(until!, context) },
            },
          ]
        : [];
    },
    reply: cardReply(
      'update_attention_item',
      'Here’s the snooze. Nothing changes until you OK it.',
      ['cannot'],
    ),
  },
  {
    // "Dismiss the Kevin one, already handled".
    when: DISMISS,
    calls: (q, context) => {
      const because = DISMISS_BECAUSE.exec(q);
      const item = itemMeant(context, because ? because[1]! : DISMISS.exec(q)![1]!);
      const reason = because?.[2]?.trim();
      return item
        ? [
            {
              name: 'update_attention_item',
              arguments: {
                itemId: item.id,
                action: 'dismiss',
                ...(reason ? { reason: capital(reason) } : {}),
              },
            },
          ]
        : [];
    },
    reply: cardReply(
      'update_attention_item',
      'Here’s the dismissal. Nothing changes until you OK it.',
      ['cannot'],
    ),
  },
  {
    // "Give the Maria one to Priya".
    when: ASSIGN,
    calls: (q, context) => {
      const [, words, who] = ASSIGN.exec(q)!;
      const item = itemMeant(context, words!);
      const userId = teammateId(context, who!);
      return item && userId
        ? [
            {
              name: 'update_attention_item',
              arguments: { itemId: item.id, action: 'assign', assigneeUserId: userId },
            },
          ]
        : [];
    },
    reply: cardReply(
      'update_attention_item',
      'Here’s the change. Nothing changes until you OK it.',
      ['cannot'],
    ),
  },
];
