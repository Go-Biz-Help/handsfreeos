import { ScriptedProvider, type ScriptRule } from '@hfos/ai';

/**
 * The stand-in model for AI work outside the Assistant: workflow AI steps, the AI builder and the knowledge
 * base, when ASSISTANT_PROVIDER=scripted (local development and the browser suite; production refuses it, see
 * env.ts). It reads the prompt back and answers in the requested shape, the same way every time.
 *
 * Each feature keeps its rules in a group below, matched on the instruction line its prompt ends with. To add
 * one (step 9's write, sort and summarize steps; step 10's builder), write the group and list it in
 * SCRIPTED_RULES. Rules see only the prompt's text; quoted data (<website_page>, <customer_message>) is read
 * as data and never obeyed.
 */

/** Undoes core's quoteData, to read the quoted prompt back. */
export const unquote = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The text inside a prompt's <tag …>…</tag> block (still quoted), or null. */
export function quotedBlock(prompt: string, tag: string): string | null {
  return new RegExp(`<${tag}\\b[^>]*>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(prompt)?.[1] ?? null;
}

const firstSentence = (s: string, max = 300) => {
  const text = s.replace(/\s+/g, ' ').trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(text);
  return (m ? m[1]! : text).slice(0, max);
};

// ---- The knowledge base: website scans ("Suggest knowledge items from this page.") ----

interface ScriptedItem {
  readonly kind: 'fact' | 'faq';
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

/**
 * One item per heading on the page, with the first paragraph (or list) under it: an FAQ when the heading is
 * a question, a fact otherwise. Headings reach the model marked "#" (knowledge/crawl.ts pageText). Anything
 * else on the page, planted instructions included, is never turned into an item.
 */
export function scriptedPageItems(message: string): { items: ScriptedItem[] } {
  const lines = unquote(quotedBlock(message, 'website_page') ?? '').split('\n');
  const heading = (line: string | undefined) =>
    /^#{1,6} (.+)$/.exec(line?.trim() ?? '')?.[1]?.trim();
  const items: ScriptedItem[] = [];
  for (let i = 0; i < lines.length && items.length < 8; i++) {
    const title = heading(lines[i]);
    if (!title) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trim()) j++;
    const block: string[] = [];
    for (; j < lines.length && lines[j]!.trim() && !heading(lines[j]); j++)
      block.push(lines[j]!.trim());
    if (!block.length) continue;
    const list = block.every((l) => l.startsWith('* '));
    const body = list
      ? block.map((l) => l.slice(2)).join('; ')
      : firstSentence(block.join(' '), 500);
    items.push({
      kind: title.endsWith('?') ? 'faq' : 'fact',
      title: title.slice(0, 120),
      body: body.slice(0, 500),
      tags: [],
    });
  }
  return { items };
}

// ---- The knowledge base: Try it ("Answer the customer’s message above.") ----

/** Answered from the first knowledge item offered (its id in usedItemIds), or someone will follow up. */
export function scriptedTryAnswer(context: string): {
  answer: string;
  usedItemIds: string[];
  unanswered: boolean;
} {
  const m = /<item id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/item>/.exec(context);
  if (!m)
    return {
      answer: 'Someone from the business will follow up with you soon.',
      usedItemIds: [],
      unanswered: true,
    };
  const [head, ...rest] = m[2]!.split('\n');
  const body = head!.startsWith('Q: ') ? rest.join(' ').replace(/^A: /, '') : rest.join(' ');
  return { answer: firstSentence(unquote(body)), usedItemIds: [m[1]!], unanswered: false };
}

export const KNOWLEDGE_RULES: readonly ScriptRule[] = [
  {
    when: /Suggest knowledge items from this page\.$/,
    json: (message) => scriptedPageItems(message),
  },
  {
    when: /Answer the customer’s message above\.$/,
    json: (_q, context) => scriptedTryAnswer(context),
  },
];

// ---- Workflow AI steps: write, sort, pick a path, summarize (workflows/ai-runner.ts) ----

/** A line of the prompt's <run_details> ("Customer’s first name: Mike"), unquoted, or null. */
function runDetail(message: string, label: string): string | null {
  for (const line of (quotedBlock(message, 'run_details') ?? '').split('\n'))
    if (line.startsWith(`${label}: `)) return unquote(line.slice(label.length + 2)).trim() || null;
  return null;
}

/** The customer's latest message, unquoted ('' when there is none). */
const customerWords = (message: string): string =>
  unquote(quotedBlock(message, 'customer_message') ?? '').trim();

/** Whether `text` mentions `name`: a short word whole ("no"), a longer one by its stem ("Bookings", "book…"). */
function mentions(text: string, name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return key.length > 4
    ? new RegExp(`\\b${escape(key.replace(/(es|s)$/, ''))}`, 'i').test(text)
    : new RegExp(`\\b${escape(key)}\\b`, 'i').test(text);
}

/** Written from the details: a greeting with their first name, and the first knowledge item's title. */
export function scriptedWrite(
  message: string,
  context: string,
): { message: string; usedItemIds: string[]; unanswered: boolean } {
  const first = runDetail(message, 'Customer’s first name') ?? 'there';
  const item = /<item id="([^"]+)"[^>]*>\n(?:Q: )?([^\n]*)/.exec(context);
  const title = item ? unquote(item[2]!).trim() : '';
  return {
    message: `Hi ${first}, thanks for reaching out!${title ? ` Re: ${title}` : ''}`,
    usedItemIds: item ? [unquote(item[1]!)] : [],
    // A question with nothing in the knowledge to answer it.
    unanswered: !item && customerWords(message).includes('?'),
  };
}

/** The first category the customer's words mention (a question mark counts for "Question"), else Other. */
export function scriptedSort(message: string): {
  category: string;
  reason: string;
  usedItemIds: string[];
} {
  const categories = (quotedBlock(message, 'categories') ?? '')
    .split('\n')
    .map((l) => unquote(l.replace(/^- /, '')).trim())
    .filter(Boolean);
  const text = customerWords(message);
  const hit =
    categories.find((c) => mentions(text, c)) ??
    (text.includes('?') ? categories.find((c) => /^questions?$/i.test(c)) : undefined);
  const category =
    hit ?? categories.find((c) => c.toLowerCase() === 'other') ?? categories.at(-1) ?? 'Other';
  return {
    category,
    reason: hit ? `The message is about ${hit.toLowerCase()}.` : 'No category fits the message.',
    usedItemIds: [],
  };
}

const PATH_FILLER = new Set(['about', 'asks', 'anything', 'else', 'from', 'that', 'their', 'they']);

/** The first path whose name or description shares a word with the customer's message, else the last. */
export function scriptedPath(message: string): {
  branchId: string;
  reason: string;
  usedItemIds: string[];
} {
  const text = customerWords(message);
  const paths = [
    ...(quotedBlock(message, 'paths') ?? '').matchAll(/<path id="([^"]+)">([^\n]*)<\/path>/g),
  ].map((m) => ({ id: unquote(m[1]!), words: unquote(m[2]!) }));
  const hit = paths.find((p) =>
    (p.words.match(/\p{L}{4,}/gu) ?? []).some(
      (w) => !PATH_FILLER.has(w.toLowerCase()) && mentions(text, w),
    ),
  );
  return {
    branchId: (hit ?? paths.at(-1))?.id ?? '',
    reason: hit ? 'The message matches this path.' : 'Nothing matched, so the last path.',
    usedItemIds: [],
  };
}

/** The first sentence of the customer's message. */
export function scriptedSummary(message: string): { summary: string; usedItemIds: string[] } {
  const text = customerWords(message);
  return {
    summary: text ? firstSentence(text) : 'The customer hasn’t said anything yet.',
    usedItemIds: [],
  };
}

export const WORKFLOW_RULES: readonly ScriptRule[] = [
  {
    when: /Write the (text message|email) the instructions above describe\.$/,
    json: (message, context) => scriptedWrite(message, context),
  },
  {
    when: /Sort the customer’s message into one of the categories above\.$/,
    json: (message) => scriptedSort(message),
  },
  { when: /Pick the path above that fits best\.$/, json: (message) => scriptedPath(message) },
  {
    when: /Write the summary the instructions above describe\.$/,
    json: (message) => scriptedSummary(message),
  },
];

// ---- The AI builder ("Change the workflow the way the request above asks.", workflows/builder.ts) ----

/** A step as the builder's context carries it (the definition's JSON inside <workflow>, quoted). */
interface RawStep {
  readonly id: string;
  readonly type: string;
  readonly until?: { readonly kind?: string };
  readonly branches?: readonly { readonly id: string; readonly steps?: readonly RawStep[] }[];
  readonly rejected?: { readonly steps?: readonly RawStep[] };
}
interface RawLane {
  readonly parentId: string | null;
  readonly branchId: string | null;
  readonly steps: readonly RawStep[];
}

/** The workflow the builder was given. */
function builderWorkflow(context: string): {
  steps?: RawStep[];
  settings?: { stopOn?: string[] };
} {
  try {
    return JSON.parse(unquote(quotedBlock(context, 'workflow') ?? '{}')) as { steps?: RawStep[] };
  } catch {
    return {};
  }
}

/** Every list of steps, the main path first, with where it sits. */
function rawLanes(
  steps: readonly RawStep[],
  parentId: string | null = null,
  branchId: string | null = null,
): RawLane[] {
  const out: RawLane[] = [{ parentId, branchId, steps }];
  for (const s of steps) {
    for (const b of s.branches ?? []) out.push(...rawLanes(b.steps ?? [], s.id, b.id));
    if (s.rejected) out.push(...rawLanes(s.rejected.steps ?? [], s.id, 'rejected'));
  }
  return out;
}

const selectedStep = (context: string) =>
  /^The person has this step selected: (s_[a-z0-9]{8})/m.exec(context)?.[1] ?? null;
const builderRequest = (message: string) => unquote(quotedBlock(message, 'request') ?? '').trim();

/** The builder's two ask lines (BUILDER_ASKS in workflows/builder.ts). */
const BUILDER_ASK =
  '(?:Change the workflow the way the request above asks|Build the workflow the request above describes)';
/** A builder request whose words match `words`. */
const builderAsks = (words: string) =>
  new RegExp(
    `^(?=[\\s\\S]*?<request>[\\s\\S]*?(?:${words})[\\s\\S]*?</request>)[\\s\\S]*${BUILDER_ASK}\\.$`,
    'i',
  );

const addStepCall = (a: {
  readonly ref?: string | null;
  readonly parentId?: string | null;
  readonly branchId?: string | null;
  readonly index?: number | null;
  readonly type: string;
  readonly action?: string | null;
  readonly json: unknown;
}) => ({
  name: 'add_step',
  arguments: {
    ref: a.ref ?? null,
    parentId: a.parentId ?? null,
    branchId: a.branchId ?? null,
    index: a.index ?? null,
    type: a.type,
    action: a.action ?? null,
    onError: null,
    json: JSON.stringify(a.json),
  },
});
const finishCall = (summary: string, unsupported: string[] = []) => ({
  name: 'finish',
  arguments: { summary, unsupported },
});
const text = (body: string) => ({ body, bookingCalendarId: null });
const waitFor = (amount: number, unit: 'minutes' | 'days') => ({
  until: { kind: 'duration', duration: { amount, unit } },
});

/** Ops for the phrases the specs use; anything else changes nothing and says so. */
export const BUILDER_RULES: readonly ScriptRule[] = [
  {
    // "Wait two days instead": the selected wait, else the first wait counted in days, else any set wait.
    when: builderAsks('wait (?:two|2) days'),
    calls: (_q, context) => {
      const all = rawLanes(builderWorkflow(context).steps ?? []).flatMap((l) => l.steps);
      const timed = (s: RawStep) => s.type === 'wait' && s.until?.kind === 'duration';
      const inDays = (s: RawStep) =>
        timed(s) && (s.until as { duration?: { unit?: string } }).duration?.unit === 'days';
      const selected = selectedStep(context);
      const wait =
        all.find((s) => s.id === selected && timed(s)) ?? all.find(inDays) ?? all.find(timed);
      if (!wait)
        return [finishCall('Nothing changed.', ['There’s no wait of a set length to change.'])];
      return [
        {
          name: 'update_step',
          arguments: { stepId: wait.id, json: JSON.stringify(waitFor(2, 'days')) },
        },
        finishCall('The wait is now 2 days.'),
      ];
    },
    reply: () => 'Done.',
  },
  {
    // "Add a text after the first wait".
    when: builderAsks('add a text after the first wait'),
    calls: (_q, context) => {
      for (const lane of rawLanes(builderWorkflow(context).steps ?? [])) {
        const at = lane.steps.findIndex((s) => s.type === 'wait');
        if (at < 0) continue;
        return [
          addStepCall({
            ref: 'checkin',
            parentId: lane.parentId,
            branchId: lane.branchId,
            index: at + 1,
            type: 'action',
            action: 'send_text',
            json: text(
              'Hi {{person.first_name | default:"there"}}, just checking in. Reply here any time.',
            ),
          }),
          finishCall('Adds a check-in text right after the first wait.'),
        ];
      }
      return [finishCall('Nothing changed.', ['There’s no wait to add a text after.'])];
    },
    reply: () => 'Done.',
  },
  {
    // "Stop if they book" (or reply).
    when: builderAsks('stop (?:if|when) they (?:book|reply)'),
    calls: (q, context) => {
      const stop = /stop (?:if|when) they reply/i.test(builderRequest(q)) ? 'reply' : 'booking';
      const current = builderWorkflow(context).settings?.stopOn ?? [];
      return [
        {
          name: 'set_settings',
          arguments: { json: JSON.stringify({ stopOn: [...new Set([...current, stop])] }) },
        },
        finishCall(`It now stops when they ${stop === 'reply' ? 'reply' : 'book'}.`),
      ];
    },
    reply: () => 'Done.',
  },
  {
    // A new workflow that texts new leads ("Build a workflow that texts new leads within a minute").
    when: builderAsks('texts? new leads'),
    calls: () => [
      {
        name: 'set_trigger',
        arguments: { json: JSON.stringify({ kind: 'event', event: 'lead.created' }) },
      },
      addStepCall({
        type: 'action',
        action: 'send_text',
        json: text(
          'Hi {{person.first_name | default:"there"}}, thanks for reaching out to {{business.name}}! We’ll be in touch shortly.',
        ),
      }),
      addStepCall({ type: 'wait', json: waitFor(5, 'minutes') }),
      addStepCall({
        type: 'action',
        action: 'create_task',
        json: {
          title: 'Call {{person.first_name | default:"the new lead"}} about {{lead.title}}',
          assignTo: { kind: 'lead_assignee' },
          due: null,
        },
      }),
      addStepCall({ type: 'wait', json: waitFor(1, 'days') }),
      addStepCall({
        type: 'action',
        action: 'send_text',
        json: text(
          'Hi {{person.first_name | default:"there"}}, just checking in from {{business.name}}. Want to pick a time? {{links.booking}}',
        ),
      }),
      {
        name: 'set_settings',
        arguments: { json: JSON.stringify({ stopOn: ['reply', 'booking'] }) },
      },
      finishCall(
        'A new lead gets a text right away, a call task after 5 minutes and a second text the next day. It stops when they reply or book.',
      ),
    ],
    reply: () => 'Done.',
  },
  {
    // Workflows don't book for customers yet.
    when: builderAsks('book (?:them|him|her|it|an appointment|appointments)'),
    calls: () => [
      finishCall('Nothing changed.', [
        'Workflows can’t book appointments for customers yet. A text with your booking link can go instead.',
      ]),
    ],
    reply: () => 'Done.',
  },
  {
    // Anything else: nothing changes, and the request comes back as unsupported.
    when: builderAsks('[\\s\\S]'),
    calls: (q) => [
      finishCall('I couldn’t work out a change from that.', [
        builderRequest(q).slice(0, 300) || 'That request',
      ]),
    ],
    reply: () => 'Done.',
  },
];

/** Every scripted rule, feature by feature. */
export const SCRIPTED_RULES: readonly ScriptRule[] = [
  ...KNOWLEDGE_RULES,
  ...WORKFLOW_RULES,
  ...BUILDER_RULES,
];

/** The stand-in model; tests may put their own rules first. */
export function scriptedAi(extra: readonly ScriptRule[] = []): ScriptedProvider {
  return new ScriptedProvider(
    [...extra, ...SCRIPTED_RULES],
    'The scripted stand-in has no rule for this request.',
  );
}
