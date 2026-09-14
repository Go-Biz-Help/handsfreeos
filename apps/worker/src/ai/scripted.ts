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

/** Every scripted rule, feature by feature. The builder (step 10) adds its own. */
export const SCRIPTED_RULES: readonly ScriptRule[] = [...KNOWLEDGE_RULES, ...WORKFLOW_RULES];

/** The stand-in model; tests may put their own rules first. */
export function scriptedAi(extra: readonly ScriptRule[] = []): ScriptedProvider {
  return new ScriptedProvider(
    [...extra, ...SCRIPTED_RULES],
    'The scripted stand-in has no rule for this request.',
  );
}
