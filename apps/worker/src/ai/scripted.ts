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

/** Every scripted rule, feature by feature. Workflow AI steps (step 9) and the builder (step 10) add theirs. */
export const SCRIPTED_RULES: readonly ScriptRule[] = [...KNOWLEDGE_RULES];

/** The stand-in model; tests may put their own rules first. */
export function scriptedAi(extra: readonly ScriptRule[] = []): ScriptedProvider {
  return new ScriptedProvider(
    [...extra, ...SCRIPTED_RULES],
    'The scripted stand-in has no rule for this request.',
  );
}
