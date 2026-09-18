import { ScriptedProvider, type ScriptRule } from '@hfos/ai';
import { addDays, localDateOf, localInstant, weekdayOf } from '@hfos/core/server';
import { isoWithOffset } from './calendar-format';
import { attentionRules } from './scripted-attention';
import { moneyRules } from './scripted-money';
import { settingsRules } from './scripted-settings';
import { workflowRules } from './scripted-workflows';

/**
 * The stand-in model the worker tests and the browser suite talk to (ASSISTANT_PROVIDER=scripted). It knows
 * a handful of phrases, reads ids from the context the runtime gives it (the page's record, the customer's
 * next appointment, stage, user, calendar and service ids), and answers from the real tool results, so
 * everything below the model runs for real.
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const pageId = (context: string, type: string) =>
  new RegExp(`\\(${type} id ${UUID}\\)`).exec(context)?.[1];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stageId = (context: string, name: string) =>
  new RegExp(`${escape(name.trim())} \\[[a-z]+\\] \\(stage id ${UUID}\\)`, 'i').exec(context)?.[1];
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const parse = (json: string | undefined): Record<string, unknown> => {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

// ---- Times in Houston, as the model would write them ----

const HOUSTON = 'America/Chicago';
/** The local date in Houston `days` from today (not in UTC: after 7 PM there it is already tomorrow in UTC). */
const dayIn = (days: number) => addDays(localDateOf(Date.now(), HOUSTON), days);
const pad = (n: number) => String(n).padStart(2, '0');
/** A local date and time in Houston, with its offset (CDT or CST). */
const at = (date: string, hour: number, minute = 0) =>
  isoWithOffset(localInstant(date, `${pad(hour)}:${pad(minute)}`, HOUSTON), HOUSTON);
const tomorrowAt = (hour: number, minute = 0) => at(dayIn(1), hour, minute);
const hour24 = (hour: string, ampm: string) => (Number(hour) % 12) + (/pm/i.test(ampm) ? 12 : 0);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** "today", "tomorrow" or a weekday (the next one); otherwise the next three days. */
function daysAsked(question: string): { from: string; to: string } {
  if (/\btoday\b/i.test(question)) return { from: dayIn(0), to: dayIn(0) };
  if (/\btomorrow\b/i.test(question)) return { from: dayIn(1), to: dayIn(1) };
  const weekday = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`, 'i').test(question));
  if (weekday >= 0) {
    let d = dayIn(1);
    while (weekdayOf(d) !== weekday) d = addDays(d, 1);
    return { from: d, to: d };
  }
  return { from: dayIn(1), to: dayIn(3) };
}

// ---- Ids from the context ----

/** A teammate by first name: "- Priya Natarajan, member (user id …)". */
function teammate(context: string, first: string): { name: string; userId: string } | null {
  const m = new RegExp(`^- (${escape(first)}[^,\\n]*), [^\\n]*\\(user id ${UUID}\\)$`, 'im').exec(
    context,
  );
  return m ? { name: m[1]!, userId: m[2]! } : null;
}
/** The first calendar with this person on it. */
const calendarWith = (context: string, fullName: string) =>
  new RegExp(`\\(calendar id ${UUID}\\):[^\\n]*people [^\\n]*${escape(fullName)}`, 'i').exec(
    context,
  )?.[1];
/** A service whose name holds the words asked for ("a tune-up" finds "AC tune-up"). */
function serviceNamed(context: string, words: string): string | undefined {
  const want = words
    .replace(/^(a|an|the)\s+/i, '')
    .trim()
    .toLowerCase();
  for (const line of context.split('\n')) {
    const m = new RegExp(`^- (.+): [^\\n]*\\(service id ${UUID}\\)$`).exec(line);
    if (m && m[1]!.toLowerCase().includes(want)) return m[2];
  }
  return undefined;
}
const calendarOffering = (context: string, serviceId: string) =>
  new RegExp(`\\(calendar id ${UUID}\\):[^\\n]*service id ${serviceId}`).exec(context)?.[1];
/** A calendar by (part of) its name, for a tapped time: "Book Tune-ups at 10:00 AM tomorrow". */
const calendarNamed = (context: string, words: string) =>
  new RegExp(`^- [^\\n]*${escape(words.trim())}[^\\n]*? \\(calendar id ${UUID}\\)`, 'im').exec(
    context,
  )?.[1];

const bookReply = (_q: string, r: Readonly<Record<string, string>>, context: string) => {
  if (!r['book_appointment'])
    return pageId(context, 'person')
      ? 'I can’t find a calendar for that.'
      : 'Open a customer first, then ask again.';
  const out = parse(r['book_appointment']);
  if (out['error']) return `That can’t be booked: ${String(out['error'])}`;
  return `Here’s the booking for ${String(out['customer'] ?? 'them')}. Nothing is booked until you OK it.`;
};

const TAPPED =
  /^book (.+?) at (\d{1,2})(?::(\d{2}))?\s?(am|pm) (today|tomorrow)(?: with (.+?))?\.?$/i;
const BOOK = /^book (?:him|her|them) for (.+?) tomorrow at (\d{1,2})(?::(\d{2}))? ?(am|pm)$/i;
const MOVE =
  /^move (?:it|his appointment|her appointment|their appointment) to tomorrow at (\d{1,2})(?::(\d{2}))? ?(am|pm)$/i;

const rules: ScriptRule[] = [
  ...attentionRules,
  ...moneyRules,
  ...settingsRules,
  ...workflowRules,
  {
    when: /how many (new )?leads/i,
    calls: () => [
      {
        name: 'business_numbers',
        arguments: { since: new Date(Date.now() - 7 * 86_400_000).toISOString() },
      },
    ],
    reply: (_q, r) => {
      const n = Number(parse(r['business_numbers'])['leadsCreated'] ?? 0);
      return `${n === 1 ? 'One new lead' : `${n} new leads`} came in over the last seven days.`;
    },
  },
  {
    // "When is Priya free Thursday?": her calendar's open times that day.
    when: /^when is (\w+) free/i,
    calls: (q, context) => {
      const who = teammate(context, /^when is (\w+) free/i.exec(q)![1]!);
      const calendarId = who ? calendarWith(context, who.name) : undefined;
      if (!who || !calendarId) return [];
      return [
        {
          name: 'find_availability',
          arguments: { calendarId, userId: who.userId, ...daysAsked(q) },
        },
      ];
    },
    reply: (_q, r) => {
      if (!r['find_availability']) return 'I don’t know who that is, or they aren’t on a calendar.';
      const out = parse(r['find_availability']);
      if (out['error']) return String(out['error']);
      const days = (out['days'] as { day: string; times: unknown[] }[] | undefined) ?? [];
      const n = days.reduce((sum, d) => sum + d.times.length, 0);
      const first = String(out['person'] ?? 'They').split(' ')[0];
      if (!n) return `${first} has no open times then.`;
      const when = days.length === 1 ? days[0]!.day : 'Over the next few days';
      return `${when}, ${first} has ${n === 1 ? 'one open time' : `${n} open times`} for a ${String(out['length'])} visit.`;
    },
  },
  {
    // "Book him for a tune-up tomorrow at 10 am", on the customer's page.
    when: BOOK,
    calls: (q, context) => {
      const [, what, h, m, ampm] = BOOK.exec(q)!;
      const personId = pageId(context, 'person');
      const serviceId = serviceNamed(context, what!);
      const calendarId = serviceId
        ? calendarOffering(context, serviceId)
        : pageId(context, 'calendar');
      if (!personId || !calendarId) return [];
      return [
        {
          name: 'book_appointment',
          arguments: {
            calendarId,
            personId,
            ...(serviceId ? { serviceId } : {}),
            startsAt: tomorrowAt(hour24(h!, ampm!), Number(m ?? 0)),
          },
        },
      ];
    },
    reply: bookReply,
  },
  {
    // A time tapped on the open-times card: "Book AC tune-up at 10:00 AM tomorrow with Priya Natarajan".
    when: TAPPED,
    calls: (q, context) => {
      const [, what, h, m, ampm, day, name] = TAPPED.exec(q)!;
      const personId = pageId(context, 'person');
      const who = name ? teammate(context, name.split(' ')[0]!) : null;
      const serviceId = serviceNamed(context, what!);
      const calendarId =
        (serviceId && calendarOffering(context, serviceId)) ||
        calendarNamed(context, what!) ||
        (who ? calendarWith(context, who.name) : undefined);
      if (!personId || !calendarId) return [];
      return [
        {
          name: 'book_appointment',
          arguments: {
            calendarId,
            personId,
            ...(serviceId ? { serviceId } : {}),
            ...(who ? { userIds: [who.userId] } : {}),
            startsAt: at(dayIn(/today/i.test(day!) ? 0 : 1), hour24(h!, ampm!), Number(m ?? 0)),
          },
        },
      ];
    },
    reply: bookReply,
  },
  {
    // "Move it to tomorrow at 2 pm": the appointment on screen, else the customer's next one.
    when: MOVE,
    calls: (q, context) => {
      const [, h, m, ampm] = MOVE.exec(q)!;
      const appointmentId = pageId(context, 'appointment');
      return appointmentId
        ? [
            {
              name: 'reschedule_appointment',
              arguments: { appointmentId, startsAt: tomorrowAt(hour24(h!, ampm!), Number(m ?? 0)) },
            },
          ]
        : [];
    },
    reply: (_q, r) => {
      if (!r['reschedule_appointment'])
        return 'Open the customer or the appointment first, then ask again.';
      const out = parse(r['reschedule_appointment']);
      return out['error']
        ? `That can’t be moved: ${String(out['error'])}`
        : 'Here’s the change. Nothing moves until you OK it.';
    },
  },
  {
    when: /^cancel (?:it|his appointment|her appointment|their appointment)\.?$/i,
    calls: (_q, context) => {
      const appointmentId = pageId(context, 'appointment');
      return appointmentId
        ? [{ name: 'cancel_appointment', arguments: { appointmentId, notify: true } }]
        : [];
    },
    reply: (_q, r) => {
      if (!r['cancel_appointment'])
        return 'Open the customer or the appointment first, then ask again.';
      const out = parse(r['cancel_appointment']);
      return out['error']
        ? `That can’t be cancelled: ${String(out['error'])}`
        : 'Here’s the cancellation. Nothing changes until you OK it.';
    },
  },
  {
    when: /^(find|look up|who is) (.+)$/i,
    calls: (q) => [
      {
        name: 'search_customers',
        arguments: { query: /^(?:find|look up|who is) (.+)$/i.exec(q)![1]!.replace(/\?$/, '') },
      },
    ],
    reply: (_q, r) => {
      const people =
        (parse(r['search_customers'])['people'] as { name: string }[] | undefined) ?? [];
      if (people.length === 1) return `Here’s ${people[0]!.name}.`;
      return people.length
        ? `${people.length} customers match. Which one do you mean?`
        : 'Nobody matches that.';
    },
  },
  {
    when: /^create a task (?:to|for me to) (.+?)(?: tomorrow)?$/i,
    calls: (q) => [
      {
        name: 'create_task',
        arguments: {
          title: capital(/^create a task (?:to|for me to) (.+?)(?: tomorrow)?$/i.exec(q)![1]!),
          dueAt: tomorrowAt(9),
        },
      },
    ],
    reply: () => 'Done. It’s on your list for tomorrow at 9:00 AM.',
  },
  {
    when: /^add a note:? (.+)$/i,
    calls: (q, context) => {
      const personId = pageId(context, 'person');
      return personId
        ? [{ name: 'add_note', arguments: { body: /^add a note:? (.+)$/i.exec(q)![1]!, personId } }]
        : [];
    },
    reply: (_q, r) =>
      r['add_note'] ? 'Added to their timeline.' : 'Open a customer first, then ask again.',
  },
  {
    when: /^text (?:him|her|them) (?:that )?(.+)$/i,
    calls: (q, context) => {
      const personId = pageId(context, 'person');
      const body = capital(/^text (?:him|her|them) (?:that )?(.+)$/i.exec(q)![1]!);
      return personId ? [{ name: 'send_text', arguments: { personId, body } }] : [];
    },
    reply: (_q, r) => {
      const to = parse(r['send_text'])['to'];
      return to
        ? `Here’s the text for ${String(to)}. It goes out once you OK it.`
        : 'Open a customer first, then ask again.';
    },
  },
  {
    when: /^move (?:it|this lead|this|him|her) to (.+)$/i,
    calls: (q, context) => {
      const leadId = pageId(context, 'lead');
      const stage = stageId(context, /^move (?:it|this lead|this|him|her) to (.+)$/i.exec(q)![1]!);
      return leadId && stage ? [{ name: 'move_lead', arguments: { leadId, stageId: stage } }] : [];
    },
    reply: (_q, r) =>
      r['move_lead']
        ? 'Here’s the change. Nothing moves until you OK it.'
        : 'Open the lead first, then ask again.',
  },
  {
    when: /calendar|schedule today|on for today/i,
    calls: () => [{ name: 'todays_schedule', arguments: {} }],
    reply: (_q, r) => {
      const out = parse(r['todays_schedule']);
      const left = (out['stillToCome'] as unknown[] | undefined)?.length ?? 0;
      const tasks = (out['tasksDueToday'] as unknown[] | undefined)?.length ?? 0;
      const said = left
        ? `${left === 1 ? 'One appointment is' : `${left} appointments are`} still to come today.`
        : 'Nothing else is on the calendar today.';
      return tasks ? `${said} Here’s what’s due too.` : said;
    },
  },
  {
    when: /buy (?:a )?(?:new )?(?:phone )?number/i,
    reply: () => 'I can’t buy phone numbers. An owner or admin can, in Settings → Texting & calls.',
  },
];

export const scriptedAssistant = () => new ScriptedProvider(rules);
