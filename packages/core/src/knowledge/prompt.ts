/**
 * Putting knowledge into prompts: items are quoted with their ids (so answers can cite what they used) and
 * escaped, so text from websites, documents and customers stays data and can't close a tag or pose as an
 * instruction. Browser-safe.
 */
import type { KnowledgeItemForPrompt } from './items';
import {
  briefFromProfile,
  groundingRules,
  type KnowledgeBusiness,
  type KnowledgeProfile,
} from './profile';

/** Escapes text for use inside the prompt's data tags. */
export function quoteData(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const KNOWLEDGE_PROMPT_MAX_CHARS = 12_000;

/** The items as quoted blocks with their ids, within a character budget (later items are left out). */
export function formatKnowledgeForPrompt(
  items: readonly KnowledgeItemForPrompt[],
  maxChars: number = KNOWLEDGE_PROMPT_MAX_CHARS,
): string {
  if (!items.length) return '<knowledge>\n(no matching items)\n</knowledge>';
  const blocks: string[] = [];
  let used = 0;
  for (const item of items) {
    const source = item.sourceUrl ? ` source="${quoteData(item.sourceUrl)}"` : '';
    const open = `<item id="${quoteData(item.id)}" kind="${item.kind}"${source}>`;
    const head =
      item.kind === 'faq' ? `Q: ${quoteData(item.title)}\nA: ` : `${quoteData(item.title)}\n`;
    const room = maxChars - used - open.length - head.length - '\n</item>'.length - 2;
    if (room < 80) break;
    const body = quoteData(item.body.trim());
    const block = `${open}\n${head}${body.length > room ? `${body.slice(0, room - 1)}…` : body}\n</item>`;
    blocks.push(block);
    used += block.length + 1;
  }
  return `<knowledge>\n${blocks.join('\n')}\n</knowledge>`;
}

/** A customer's words, quoted as data. */
export function quoteCustomerText(text: string): string {
  return `<customer_message>\n${quoteData(text.trim())}\n</customer_message>`;
}

/** The grounding context an AI step or the Assistant gets: the brief, the rules, then the matching items. */
export function groundingContext(input: {
  readonly profile: KnowledgeProfile;
  readonly business: KnowledgeBusiness;
  readonly items: readonly KnowledgeItemForPrompt[];
}): string {
  return [groundingBrief(input), formatKnowledgeForPrompt(input.items)].join('\n');
}

/** The brief and the rules without any items: what stays the same for a whole conversation (a phone call). */
export function groundingBrief(input: {
  readonly profile: KnowledgeProfile;
  readonly business: KnowledgeBusiness;
}): string {
  return [
    '<business_profile>',
    quoteData(briefFromProfile(input.profile, input.business)),
    '</business_profile>',
    'Rules for using this knowledge:',
    groundingRules(input.profile, input.business),
  ].join('\n');
}
