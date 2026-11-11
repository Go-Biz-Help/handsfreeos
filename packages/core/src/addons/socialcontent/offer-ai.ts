/**
 * The business's main offer and its lists for content, as AI Social Media Content Creator's AI reads them
 * (docs/main-offer.md, "For your content"; the owner, 11 Nov 2026): who it helps, the result, how and the guarantee
 * (never the price), then the lists the person wrote with the AI's help. Every post, idea and Playbook is written
 * from them, beside the business profile and its Knowledge.
 */
import { quoteData } from '../../knowledge/prompt';
import { listsText, offerForLists, type MainOfferLists } from '../../main-offer/lists';
import type { MainOfferParts } from '../../main-offer/parts';

/** The lists, at most this long in a prompt: plenty for 11 short lists. */
const LISTS_CHARS = 8_000;

/** How the AI uses them: told once in every system prompt that writes for the business. */
export const OFFER_FOR_CONTENT = [
  'Under <main_offer> is the business’s main offer, and under <content_lists> the lists it wrote about itself for its posts. Build on them first: they say what the business stands for better than anything else it gave you.',
  'Write in the voice “Your voice” describes. End with one of the asks under “What to ask people to do”, not the same one every time. Never say anything under “Never say”: those are hard rules.',
  'Take what to say from what makes it different, its features and benefits, its customers’ problems, questions and worries, before and after, its story and its myths; and what to post about from its topics.',
  'Never give the offer’s price, and never write a result or review the business didn’t give.',
].join('\n');

/**
 * The live offer's parts (no price) and the lists, quoted as data, in their own blocks; '' when there's neither.
 * Long lists are cut at the end.
 */
export function offerForContent(parts: MainOfferParts | null, lists: MainOfferLists): string {
  const said = listsText(lists);
  return [
    parts ? `<main_offer>\n${quoteData(offerForLists(parts))}\n</main_offer>` : '',
    said
      ? `<content_lists>\n${quoteData(said.length > LISTS_CHARS ? `${said.slice(0, LISTS_CHARS - 1)}…` : said)}\n</content_lists>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
