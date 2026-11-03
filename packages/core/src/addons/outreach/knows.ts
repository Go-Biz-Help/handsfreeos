/**
 * What the business knows, for what Social Outreach's AI writes (docs/outreach.md decision 122, the owner's pick "Wait
 * for me"): "is the ai in the social outreach tool connected to the business’ ai knowledge base the ai teammate uses?
 * if not it should be so that common questions and business information is known by that ai".
 *
 * A message, a comment or a helpful post is told the business profile in a few lines and its Knowledge, as the AI
 * Teammate answers from them (../../knowledge): the short answers and facts whole, and for a reply or a comment the
 * longer ones that match what they wrote. The worker reads them (apps/worker/src/addons/outreach/knows.ts), and a
 * prompt is told them by `knowsBlocks`. A fact about the business comes only from them, the playbook and the main
 * offer, never a guess.
 *
 * A reply to something none of them answers says the owner will check on it, and waits for the person under Waiting
 * for you, whatever their Replies say (`KNOWS_WORDS.needsYou`, ./sends.ts): the AI names what wasn't answered
 * (`unanswered`), and the extension hands that on with the reply (from 0.111.0).
 *
 * Browser-safe: the extension reads the words.
 */
import type { KnowledgeItemForPrompt } from '../../knowledge/items';
import { formatKnowledgeForPrompt, quoteData } from '../../knowledge/prompt';

export interface DraftKnows {
  /** The business profile in a few lines (`briefFromProfile`): what it does, its services, area, hours, policies. */
  readonly brief: string | null;
  /** Its published Knowledge for the message: the short answers, then the longer ones that match, best first. */
  readonly items: readonly KnowledgeItemForPrompt[];
  /** Whether the profile lets the AI give a price written in it or in Knowledge (AI may quote prices, on its page). */
  readonly allowPrices: boolean;
  /** The profile's words to avoid: never in a draft, like the playbook's. */
  readonly avoid: readonly string[];
}

/** How much Knowledge a message reads, within this many characters in all: what matches first, then the short ones. */
export const KNOWS_CHARS = 8_000;
export const KNOWS_ITEMS = 30;
/** A short answer is one this long or less, question and answer: a longer one is found by its words. */
export const KNOWS_ITEM_CHARS = 1_200;
/** The most items found by what they wrote, ahead of the short ones, and how much of each is read. */
export const KNOWS_FOUND = 4;
export const KNOWS_FOUND_CHARS = 1_000;
/** The most of what a reply didn't answer that's kept to say why it waits (`needs_you` holds 300). */
export const UNANSWERED_MOST = 160;

/** What a prompt is told the business knows: its profile and its Knowledge, as data. */
export function knowsBlocks(knows: DraftKnows | null): string[] {
  if (!knows) return ['<business_profile>\n(not available)\n</business_profile>', KNOWS_RULE];
  return [
    `<business_profile>\n${quoteData(knows.brief?.trim() || 'Nothing written yet.')}\n</business_profile>`,
    formatKnowledgeForPrompt(knows.items, KNOWS_CHARS),
    KNOWS_RULE,
    knows.allowPrices
      ? 'A price under <business_profile> or <knowledge> may be given only when they ask for it, exactly as written.'
      : 'Never give a price from <business_profile> or <knowledge>.',
    ...(knows.avoid.length
      ? [`Never use these words either: ${quoteData(knows.avoid.join(', '))}`]
      : []),
  ];
}

/** How the business's profile and Knowledge are used, said with them. */
export const KNOWS_RULE =
  'What the business does, its services, the area it serves, its hours and its policies are under <business_profile>, and its own answers to common questions under <knowledge>. Say something about the business only when the playbook, the offer, the business profile or the knowledge says it, in their words, and never guess or make up a detail: not a service, a place, a time, a policy, a result or a number.';

/**
 * For a reply: what they asked that nothing given answers (`unanswered`), so it waits for the person. Asked of every
 * draft, so the schema stays one, and kept only for a reply.
 */
export const UNANSWERED_ASK =
  'Also say what they asked in their last message that nothing given here answers: not the business profile, the knowledge, the playbook, the offer or the chat. Name it in a few words that follow “Knowledge has no answer to”, such as “whether it works with QuickBooks” or “the hours on Sundays”, or leave it empty when they asked nothing, or everything they asked is answered. When something isn’t answered, never guess it in the drafts: say you’ll check on that and get back to them, and answer the rest.';

/** What they asked that wasn't answered, as kept: one line, within `UNANSWERED_MOST`, null when nothing was. */
export function unansweredLine(said: string | null | undefined): string | null {
  const line = (said ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“”']+|["“”'.]+$/g, '')
    .trim();
  if (!line || /^(none|nothing|n\/a|null)$/i.test(line)) return null;
  return line.length > UNANSWERED_MOST ? `${line.slice(0, UNANSWERED_MOST - 1).trimEnd()}…` : line;
}

export const KNOWS_WORDS = {
  /** Why a reply waits for the person (./sends.ts `needsYou`): "Knowledge has no answer to the hours on Sundays". */
  needsYou: (what: string): string => `Knowledge has no answer to ${what}`,
  /** Under drafts on Today: why they say the owner will check, and what fixes it. */
  draftNote: (what: string): string =>
    `Knowledge has no answer to ${what}, so these say you’ll check. Answer it yourself, or add it under Knowledge so the AI knows next time.`,
} as const;
