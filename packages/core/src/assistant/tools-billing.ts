/**
 * Money: estimates, invoices, refunds, the plans a business sells and the customers on them, balance top-ups.
 *
 * Each tool maps to commands people already use on the screens, so the Assistant can only do what the signed-in
 * person can, with the same rules, events and audit. Anything that reaches a customer or changes a record waits
 * for the person's OK ("confirm").
 *
 * The permissions are the commands' own: writing, sending, voiding and turning an estimate into an invoice, and
 * starting, pausing or cancelling someone's plan, are `money.bill` (whoever the business lets bill); a refund, the
 * plans on sale, numbering and the balance's top-up are `money.manage`. The two look-ups are `money.read`, and a
 * member only ever sees the documents for the customers they are on — that rule is under the queries, not here.
 */
import { z } from 'zod';
import { isLocalDate } from '../calendar/engine/zoned';
import { uuid } from '../schemas/common';
import { define, dollars, text, type AssistantTool } from './tool-kit';

/** A local day the business means (a due date, the day an estimate stops being good): kept as the date it is. */
const localDay = z
  .string()
  .refine(isLocalDate, { error: 'Use a date like 2026-10-15.' })
  .describe('A local date, like 2026-10-15');

/** One line as the model writes it: from the catalogue, or typed by hand with a price. */
const Line = z.object({
  productId: uuid
    .optional()
    .describe(
      'An item from the catalogue (get_settings with area products). Its name, price, unit and tax fill in unless given here',
    ),
  name: text(200).optional().describe('What the line is. Needed for a line not from the catalogue'),
  description: text(2000).optional(),
  quantity: z.number().gt(0).max(1_000_000).default(1),
  unitPrice: dollars
    .optional()
    .describe('The price of one. Needed for a line not from the catalogue'),
  unitLabel: text(40).optional().describe('each, hour, visit, ft'),
  taxable: z
    .boolean()
    .optional()
    .describe('Left out: as the catalogue item is, or as the business taxes new items'),
  discountDollars: dollars.optional().describe('Money off this line alone'),
});

/** What an estimate and an invoice share: who and what it is for, its lines, a discount and a note. */
const documentFields = {
  title: text(200)
    .optional()
    .describe('What it is for, as the customer reads it: "AC replacement"'),
  lines: z
    .array(Line)
    .min(1)
    .max(50)
    .optional()
    .describe('Every line, in order. On a change this replaces all the lines already there'),
  addLines: z
    .array(Line)
    .min(1)
    .max(50)
    .optional()
    .describe('On a change: lines to add after the ones already there'),
  removeLines: z
    .array(z.int().min(1).max(200))
    .max(50)
    .optional()
    .describe('On a change: line numbers to take off, as get_money_document numbers them'),
  discountPercent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Off the whole thing, before tax, like 10. 0 takes a discount off'),
  discountDollars: dollars
    .optional()
    .describe('Off the whole thing, before tax, instead of a percent. 0 takes a discount off'),
  note: text(5000).optional().describe('The note printed on it for the customer'),
  leadId: uuid
    .nullable()
    .optional()
    .describe('The lead it is for (get_customer lists their open leads). null unlinks it'),
};

const channels = z
  .array(z.enum(['email', 'sms']))
  .min(1)
  .max(2)
  .describe('email, sms (a text), or both');

export const billingTools: readonly AssistantTool[] = [
  // ---------- looking things up (auto) ----------
  define({
    name: 'get_money_document',
    description:
      'One estimate or invoice in full: its lines (numbered), discount, tax, total, deposit, due or good-until date and where it stands; for an invoice, the payments against it (with ids, for refund_payment) and any refunds; for an estimate, the invoices made from it. Pass one id, from customer_money, money_owed or estimates_waiting. Call it before changing a draft or refunding.',
    input: z.object({
      estimateId: uuid.optional(),
      invoiceId: uuid.optional(),
    }),
    autonomy: 'auto',
    permission: 'money.read',
  }),
  define({
    name: 'list_plans',
    description:
      'The maintenance plans the business sells (with ids: the price, how often each bills, what it includes and the visits it covers) and the customers on them (with the ids manage_customer_plan takes: where each stands, when it next bills, whether it has a card). Pass a planId or a personId to see only those customers. Someone who only bills sees only their own customers’ plans.',
    input: z.object({
      planId: uuid.optional().describe('Only the customers on this plan'),
      personId: uuid.optional().describe('Only this customer’s plans'),
      includeStopped: z
        .boolean()
        .default(false)
        .describe('Also list plans the business has stopped selling'),
    }),
    autonomy: 'auto',
    permission: 'money.read',
  }),

  // ---------- estimates and invoices (confirm) ----------
  define({
    name: 'write_estimate',
    description:
      'Write a new estimate for a customer (personId from search_customers), or change one that is still a draft (estimateId; read it with get_money_document first). Lines come from the catalogue or are typed as one-offs with a quantity and a price; add a discount, the deposit to ask for when they say yes, a note and the lead it is for. On a change pass only what changes. It stays a draft: nothing goes to the customer until it is sent with send_estimate. Nothing is saved until the person says yes on the card.',
    input: z.object({
      estimateId: uuid.optional().describe('Leave out to write a new one'),
      personId: uuid.optional().describe('Who it is for. Needed for a new one'),
      ...documentFields,
      depositPercent: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Asked for up front when they say yes, like 25. 0 asks for none'),
      depositDollars: dollars
        .optional()
        .describe('Asked for up front, as an amount instead of a percent. 0 asks for none'),
      goodUntil: localDay
        .nullable()
        .optional()
        .describe(
          'When it stops being good. Left out, it is worked out from the settings when sent',
        ),
    }),
    autonomy: 'confirm',
    permission: 'money.bill',
  }),
  define({
    name: 'manage_estimate',
    description:
      'Act on an estimate (id from customer_money, estimates_waiting or get_money_document). void: withdraw it — it keeps its number, the customer’s link says it was withdrawn, and it can’t be undone. record_yes: the customer said yes on the phone or in person; it is recorded in the person’s name, never as the customer’s own approval. make_invoice: turn a sent or approved estimate into a draft invoice, for the whole job or only its deposit (send it afterwards with manage_invoice). Sending an estimate is send_estimate. Nothing happens until the person says yes on the card.',
    input: z.object({
      estimateId: uuid,
      action: z.enum(['void', 'record_yes', 'make_invoice']),
      reason: text(500).optional().describe('void: why, kept with it'),
      name: text(120)
        .optional()
        .describe('record_yes: who said yes, as they gave it. Left out, the customer’s name'),
      note: text(500).optional().describe('record_yes: anything worth noting'),
      bill: z
        .enum(['whole_job', 'deposit_only'])
        .default('whole_job')
        .describe(
          'make_invoice: every line (its deposit is asked for first), or only the deposit on its own',
        ),
      dueOn: localDay.optional().describe('make_invoice: when it is due. Left out, from the terms'),
    }),
    autonomy: 'confirm',
    permission: 'money.bill',
  }),
  define({
    name: 'write_invoice',
    description:
      'Write a new invoice for a customer (personId from search_customers), or change one that is still a draft (invoiceId; read it with get_money_document first). Lines come from the catalogue or are typed as one-offs with a quantity and a price; add a discount, a note, the lead it is for, when it is due and the payment account it is paid into. On a change pass only what changes. It stays a draft: nothing goes to the customer until it is sent with manage_invoice. Nothing is saved until the person says yes on the card.',
    input: z.object({
      invoiceId: uuid.optional().describe('Leave out to write a new one'),
      personId: uuid.optional().describe('Who it is for. Needed for a new one'),
      ...documentFields,
      dueOn: localDay
        .nullable()
        .optional()
        .describe('When it is due. Left out, it is worked out from the terms when sent'),
      connectionId: uuid
        .optional()
        .describe(
          'The payment account it is paid into (get_settings with area payments). Left out, the person’s usual one',
        ),
    }),
    autonomy: 'confirm',
    permission: 'money.bill',
  }),
  define({
    name: 'manage_invoice',
    description:
      'send: send a draft invoice to the customer by email, text or both, with a line to go with it. It takes its number and its due date and is frozen — a mistake afterwards means voiding it and writing a new one. void: withdraw an invoice that should not be paid; it keeps its number, its reminders stop and the customer’s link says it was withdrawn; one with money paid on it is refunded first (refund_payment). Invoice ids come from money_owed, customer_money or get_money_document. Nothing happens until the person says yes on the card.',
    input: z.object({
      invoiceId: uuid,
      action: z.enum(['send', 'void']),
      channels: channels.default(['email']).describe('send: how the customer gets the link'),
      message: text(2000).optional().describe('send: a line to go out with the link'),
      reason: text(500).optional().describe('void: why, kept with it'),
    }),
    autonomy: 'confirm',
    permission: 'money.bill',
  }),

  // ---------- money going back (confirm, money.manage) ----------
  define({
    name: 'refund_payment',
    description:
      'Give money back on a payment the business took: everything still refundable on it, or part. Money leaves the business — a card payment goes back to the customer’s card through Stripe or Square, and cash or a cheque is written down as handed back. The invoice stays paid: a refund never puts it back on the bill. Pass the invoice (money_owed, customer_money or get_money_document) and, when it has more than one payment, which one (get_money_document lists them). Nothing is refunded until the person says yes on the card.',
    input: z.object({
      invoiceId: uuid,
      paymentId: uuid.optional().describe('Needed when the invoice has more than one payment'),
      amount: dollars.optional().describe('Leave out to refund everything still refundable'),
      reason: text(500).optional().describe('Why, kept with the refund'),
    }),
    autonomy: 'confirm',
    permission: 'money.manage',
  }),

  // ---------- plans the business sells, and the customers on them (confirm) ----------
  define({
    name: 'manage_plan',
    description:
      'The maintenance plans the business sells. create: a new plan (a name and a price). change: its name, price, how often it bills, what it includes, whether it is taxed, and the service its members are due and how often. stop_selling: take it off sale — anyone on it stays on it. sell_again: put it back on sale. Customers already on a plan keep the price and what they signed up for. Plan ids come from list_plans; service ids from get_settings with area services. Pass only what changes. Nothing is saved until the person says yes on the card.',
    input: z.object({
      action: z.enum(['create', 'change', 'stop_selling', 'sell_again']),
      planId: uuid.optional().describe('Every action but create'),
      name: text(160).optional(),
      description: text(2000).optional(),
      priceDollars: dollars.optional().describe('What it costs each time it bills'),
      interval: z
        .enum(['month', 'quarter', 'year'])
        .optional()
        .describe('How often it bills, with intervalCount'),
      intervalCount: z
        .int()
        .min(1)
        .max(36)
        .optional()
        .describe('Every how many: month with 6 bills every 6 months'),
      includes: z
        .array(text(200))
        .max(30)
        .optional()
        .describe('What the customer gets, a line each. Replaces the list there'),
      taxable: z.boolean().optional(),
      serviceId: uuid
        .nullable()
        .optional()
        .describe('The service members are due (get_settings with area services). null for none'),
      visitEveryMonths: z
        .int()
        .min(1)
        .max(60)
        .nullable()
        .optional()
        .describe('How often members are due that service, in months'),
    }),
    autonomy: 'confirm',
    permission: 'money.manage',
  }),
  define({
    name: 'manage_customer_plan',
    description:
      'A customer on a maintenance plan. start: put a customer (search_customers) on a plan the business sells (list_plans); it waits until they put a card on it on their own page, and sendBy emails or texts them that link straight away. pause: nothing is charged until it is started again. resume: it bills again from the next cycle. cancel: nothing more is billed and it can’t be restarted (a new plan would be started instead). ask_for_card: email or text them the link to put a new card on it. The customer-plan id (subscriptionId) comes from list_plans or customer_money. Nothing happens until the person says yes on the card.',
    input: z.object({
      action: z.enum(['start', 'pause', 'resume', 'cancel', 'ask_for_card']),
      subscriptionId: uuid.optional().describe('Every action but start'),
      personId: uuid.optional().describe('start: the customer'),
      planId: uuid.optional().describe('start: the plan, from list_plans'),
      connectionId: uuid
        .optional()
        .describe(
          'start: the payment account it bills through (get_settings with area payments). Left out, the person’s usual one',
        ),
      sendBy: channels
        .optional()
        .describe(
          'start and ask_for_card: how the card link goes to them. ask_for_card left out: email, else a text',
        ),
      message: text(2000).optional().describe('A line to go out with the card link'),
      reason: text(500).optional().describe('cancel: why, kept with it'),
    }),
    autonomy: 'confirm',
    permission: 'money.bill',
  }),

  // ---------- numbering, ways to pay and the balance (confirm, money.manage) ----------
  define({
    name: 'update_numbering_and_ways_to_pay',
    description:
      'How estimates and invoices are numbered — the letters in front (like INV-) and the next number, which only ever goes up — and which ways to pay the customer is offered on their page: bank transfer on or off. Card is always offered and can’t be turned off; cash and cheques are never offered on the customer’s page (they are written down by hand with record_payment). Read it first with get_settings (area payments) and pass only what changes. Nothing is saved until the person says yes on the card.',
    input: z.object({
      invoicePrefix: z
        .string()
        .trim()
        .max(12)
        .regex(/^[A-Za-z0-9-]*$/, 'Letters, numbers and hyphens.')
        .optional()
        .describe('Like INV-. An empty string numbers them bare'),
      invoiceNextNumber: z.int().min(1).max(1_000_000_000).optional(),
      estimatePrefix: z
        .string()
        .trim()
        .max(12)
        .regex(/^[A-Za-z0-9-]*$/, 'Letters, numbers and hyphens.')
        .optional()
        .describe('Like EST-. An empty string numbers them bare'),
      estimateNextNumber: z.int().min(1).max(1_000_000_000).optional(),
      offerBankTransfer: z.boolean().optional(),
    }),
    autonomy: 'confirm',
    permission: 'money.manage',
  }),
  define({
    name: 'update_auto_topup',
    description:
      'Automatic top-up of the business’s own HandsFreeOS balance (what texts, calls and AI replies come out of — not money customers pay): turn it on or off, the balance it tops up below, and how much it adds each time. While it is on it charges the card on file by itself. Topping up now is do_wallet_top_up; adding or changing the card is the person’s own to do (settings_help with area usage). Read it first with get_settings (area usage). Nothing is saved until the person says yes on the card.',
    input: z.object({
      on: z.boolean().optional(),
      belowDollars: z
        .number()
        .min(0)
        .max(1_000_000)
        .optional()
        .describe('Top up when the balance drops below this'),
      addDollars: z
        .number()
        .min(5)
        .max(1_000_000)
        .optional()
        .describe('How much each top-up adds; at least $5'),
    }),
    autonomy: 'confirm',
    permission: 'money.manage',
  }),
];
