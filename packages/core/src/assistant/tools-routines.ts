/**
 * Asking the Assistant to do something on its own (the owner, 25 Nov 2026): a question on a schedule, or an alert when
 * something happens. Each waits for the person's OK on a card and makes one of their routines
 * (`assistant_routine.create`); changing, pausing and deleting one are the screens' own commands (coverage.ts).
 */
import { z } from 'zod';
import { uuid } from '../schemas/common';
import { RoutineCadence, ROUTINE_QUESTION_MAX } from './routines';
import { define, text, type AssistantTool } from './tool-kit';

const Watch = z.discriminatedUnion('on', [
  z.object({
    on: z.literal('reply'),
    personId: uuid.describe('The customer, from search_customers'),
  }),
  z.object({
    on: z.literal('booking'),
    personId: uuid.describe('The customer, from search_customers'),
  }),
  z.object({
    on: z.literal('review'),
    atMost: z
      .int()
      .min(1)
      .max(5)
      .describe('A star review this many stars or fewer: 1 for 1-star only, 5 for every review'),
  }),
  z.object({
    on: z.literal('payment'),
    atLeastCents: z
      .int()
      .min(0)
      .max(1_000_000_000)
      .describe(
        'An invoice of at least this much, in cents, paid in full: 100000 is $1,000; 0 for every one',
      ),
  }),
]);

export const routineTools: readonly AssistantTool[] = [
  define({
    name: 'schedule_question',
    description:
      'Ask a question for the person again and again on a schedule, like "Every Monday at 8, tell me who owes money" or "On the 1st, how many jobs did we do last month?". At each time it’s asked as them, with look-ups only (it never sends, books or changes anything), in a chat of its own, and the answer goes to their phone as a notification, and by email too if they say. Theirs alone; they pause or stop it in Settings → Account under Notifications. Not for a one-time reminder: "remind me at 3 PM" is a task with that time (create_task).',
    input: z.object({
      question: text(ROUTINE_QUESTION_MAX).describe(
        'The question in their words, as they would ask it: "Who owes me money?"',
      ),
      cadence: RoutineCadence.describe(
        'When, in the business’s time zone: {every: "weekly", days: [0 Sunday to 6 Saturday], at: "08:00"} or {every: "monthly", day: 1 to 28 or "last", at: "09:00"}',
      ),
      email: z.boolean().optional().describe('The whole answer by email too (no unless said)'),
    }),
    autonomy: 'confirm',
    permission: 'assistant.use',
  }),
  define({
    name: 'set_alert',
    description:
      'Tell the person with a notification on their phone when something happens: a customer writes (reply) or books (booking), a star review of so many stars or fewer comes in (review), or an invoice of at least an amount is paid in full (payment). Like "tell me when Bob writes back", "when a 1-star review comes in" or "when a big invoice gets paid". Only them, and only about what they can see. A customer writing or booking tells them once, then the alert pauses; reviews and payments tell them every time, unless they say. They pause or stop it in Settings → Account under Notifications.',
    input: z.object({
      watch: Watch,
      once: z
        .boolean()
        .optional()
        .describe(
          'Tell once, then pause. Unsaid: once for reply and booking, every time otherwise',
        ),
    }),
    autonomy: 'confirm',
    permission: 'assistant.use',
  }),
];
