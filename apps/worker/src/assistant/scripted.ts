import { ScriptedProvider, type ScriptRule } from '@hfos/ai';

/**
 * The stand-in model the worker tests and the browser suite talk to (ASSISTANT_PROVIDER=scripted). It knows
 * a handful of phrases, reads ids from the context the runtime gives it (the page's record, stage ids), and
 * answers from the real tool results, so everything below the model runs for real.
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
/** Tomorrow at 9:00 AM in Houston (Central daylight time), as the model would write it. */
const tomorrowAtNine = () => {
  // The calendar date in Houston, not in UTC: after 7 PM there it is already tomorrow in UTC.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(
    new Date(Date.now() + 86_400_000),
  );
  return `${day}T09:00:00-05:00`;
};

const rules: ScriptRule[] = [
  {
    when: /what needs (my )?attention|what.s waiting/i,
    calls: () => [{ name: 'what_needs_attention', arguments: {} }],
    reply: (_q, r) => {
      const waiting =
        (parse(r['what_needs_attention'])['waiting'] as unknown[] | undefined)?.length ?? 0;
      return waiting
        ? `${waiting === 1 ? 'One customer is' : `${waiting} customers are`} waiting on a reply. Here’s everything that needs you.`
        : 'Nothing urgent. Here’s what’s coming up.';
    },
  },
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
          dueAt: tomorrowAtNine(),
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
    reply: () => 'The calendar comes in a later update. Here’s what’s due today.',
  },
  {
    when: /buy (?:a )?(?:new )?(?:phone )?number/i,
    reply: () => 'I can’t buy phone numbers. An owner or admin can, in Settings → Texting & calls.',
  },
];

export const scriptedAssistant = () => new ScriptedProvider(rules);
