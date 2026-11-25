/**
 * Looking things up on the web, and calling around (the owner, 25 Nov 2026: "look things up for me"; "would calling
 * suppliers be the AI teammate?" yes).
 *
 * - search_web: a supplier near the business and its hours, a price, a company before a meeting, a permit rule. It
 *   changes nothing, so it runs on its own; each search is paid for from the business's balance, like the AI's words.
 * - call_for_me: the AI teammate phones someone in Contacts with the person's questions, on a card they OK, and tells
 *   them in the chat (and on their phone) what was said. Only to a business landline or someone who agreed in writing
 *   to calls (automations/errand-calls.ts).
 */
import { z } from 'zod';
import { ERRAND_ASK_MAX, ERRAND_GOAL_MAX, ERRAND_SAY_MAX } from '../automations/errand-calls';
import { uuid } from '../schemas/common';
import { define, text, type AssistantTool } from './tool-kit';

/** The most web searches one look-up makes, each charged (`ai.web_search`). */
export const WEB_SEARCHES_MAX = 3;

export const webTools: readonly AssistantTool[] = [
  define({
    name: 'search_web',
    description: `Look something up on the web when the answer isn't in HandsFreeOS: stores or suppliers near the business with their phone numbers and hours, a price or a product, a company or person before a meeting, a rule, a permit or a code, today's news. Answers in short words, each fact with the page it came from as a link. Say what was found and give the links; never make up a phone number, price or hour the pages didn't say. Up to ${WEB_SEARCHES_MAX} searches, each a few cents from the business's balance. To have the AI teammate phone a supplier with questions, use call_for_me after.`,
    input: z.object({
      question: text(500).describe(
        'What to find, in full words: "plumbing supply stores open on Saturday, with their phone numbers"',
      ),
      near: text(120)
        .optional()
        .describe(
          'Where, when it matters: a town, "Katy, TX", or a ZIP. Left out, the business’s own town is used',
        ),
    }),
    autonomy: 'auto',
    permission: 'assistant.use',
  }),
  define({
    name: 'call_for_me',
    description: `Have the AI teammate phone someone in Contacts for the person: a supplier, a store, a parts house, another business. It asks their questions, listens, and the answer comes back here in this chat and on their phone, usually within minutes (during the business's open hours). It says it's an AI calling for the business and that the call is recorded. It never orders, pays, books or agrees to anything. It only calls a number the phone company says is a business landline, or someone marked OK to call; never a customer about their own business (use the inbox for that), and never someone who asked not to be called. Find who to call with search_customers or list_companies; when they aren't in Contacts, look them up with search_web and add them with create_customer first. Shows a card; nothing is called until they press Call them.`,
    input: z.object({
      personId: uuid.describe('Who to call, from search_customers or create_customer'),
      goal: text(ERRAND_GOAL_MAX).describe(
        'What it says after who it is, finishing “I’m calling …”: “to ask if you have 30-year shingles in stock”',
      ),
      ask: text(ERRAND_ASK_MAX).describe(
        'Everything to find out, in full words: “Do they have 30-year architectural shingles in Weathered Wood? How many bundles, the price per bundle, and can we pick up tomorrow morning?”',
      ),
      say: z
        .string()
        .trim()
        .max(ERRAND_SAY_MAX)
        .optional()
        .describe(
          'What it may tell them if they ask, and nothing more: an account number, a job’s address, a callback number. Left out, it tells them nothing beyond who it’s calling for',
        ),
    }),
    autonomy: 'confirm',
    permission: 'inbox.use',
  }),
];
