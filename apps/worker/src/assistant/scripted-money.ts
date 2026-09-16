import type { ScriptRule } from '@hfos/ai';

/**
 * The scripted Assistant's money phrases (M9, step 13): "What are we owed?", "What's overdue?", "What did we
 * collect this month?", "Which estimates are waiting?", "Does she owe us anything?" on a customer's page, and
 * the two that wait for an OK — sending an estimate and writing down cash.
 *
 * The rules only decide which tool to call and what to say about its result: every figure in an answer comes
 * back from the real query, so a wrong number here would be a wrong number in the product.
 *
 * The stand-in model answers with **one round of tool calls**, so it cannot look a document up and then act on
 * it in the same breath the way a real model does. The two acting phrases therefore take the document's own id
 * in the question, which is exactly what a real model would have read off the round before.
 */

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const parse = (json: string | undefined): Record<string, unknown> => {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
const count = (n: number, one: string) => (n === 1 ? `one ${one}` : `${n} ${one}s`);

/** The person whose page the question was asked on. */
const personOnPage = (context: string) => new RegExp(`\\(person id ${UUID}\\)`).exec(context)?.[1];

const SEND = new RegExp(`send (?:the )?estimate ${UUID}`, 'i');
const RECORD = new RegExp(
  `record \\$?([\\d,]+(?:\\.\\d{2})?)(?: (cash|cheque|check))? (?:on|against) (?:invoice )?${UUID}`,
  'i',
);

export const moneyRules: ScriptRule[] = [
  {
    // "What are we owed?" / "Who hasn't paid?" / "What's overdue?"
    when: /\b(what are we owed|what do we owe them|who has ?n['’]?t paid|what['’]?s (overdue|unpaid)|anything overdue|what is overdue)\b/i,
    calls: (q) => [{ name: 'money_owed', arguments: { overdueOnly: /\boverdue\b/i.test(q) } }],
    reply: (q, r) => {
      const out = parse(r['money_owed']);
      if (out['error']) return String(out['error']);
      const overdue = /\boverdue\b/i.test(q);
      const invoices = list(out['invoices']);
      if (invoices.length === 0)
        return overdue ? 'Nothing is late.' : 'Nothing is outstanding — everything has been paid.';
      const first = invoices[0]!;
      if (overdue)
        return `${str(out['overdue'], '$0')} is overdue across ${count(invoices.length, 'invoice')}. The oldest is ${str(first['number'], 'an invoice')} for ${str(first['customer'], 'a customer')}.`;
      const late = str(out['overdue'], '$0');
      return `You are owed ${str(out['owed'], '$0')} across ${count(invoices.length, 'invoice')}${late === '$0' ? '' : `, and ${late} of that is late`}.`;
    },
  },
  {
    // "What did we collect this month?"
    when: /\b(what did we collect|what['’]?s come in|how much have we collected|what have we collected)\b/i,
    calls: (q) => [
      {
        name: 'money_collected',
        arguments: { days: /\b(week|7 days)\b/i.test(q) ? 7 : new Date().getDate() },
      },
    ],
    reply: (_q, r) => {
      const out = parse(r['money_collected']);
      if (out['error']) return String(out['error']);
      const n = Number(out['payments'] ?? 0);
      if (!n) return 'Nothing has come in over that window.';
      return `${str(out['collected'], '$0')} has come in from ${count(n, 'payment')}.`;
    },
  },
  {
    // "Which estimates are waiting?"
    when: /\b(estimates? (are )?(waiting|out|outstanding)|which estimates|what estimates)\b/i,
    calls: () => [{ name: 'estimates_waiting', arguments: {} }],
    reply: (_q, r) => {
      const out = parse(r['estimates_waiting']);
      if (out['error']) return String(out['error']);
      const items = list(out['estimates']);
      if (!items.length) return 'Every estimate has been answered.';
      const first = items[0]!;
      return `${items.length === 1 ? 'One estimate is' : `${items.length} estimates are`} still waiting, worth ${str(out['quotedOut'], '$0')}. The one out longest is ${str(first['number'], 'an estimate')} for ${str(first['customer'], 'a customer')}, ${str(first['out'], 'waiting')}.`;
    },
  },
  {
    // "Does she owe us anything?", asked on a customer's page.
    when: /\b(do(?:es)? (?:he|she|they|this customer) owe|what do(?:es)? (?:he|she|they) owe|(?:his|her|their) balance)\b/i,
    calls: (_q, context) => {
      const personId = personOnPage(context);
      return personId ? [{ name: 'customer_money', arguments: { personId } }] : [];
    },
    reply: (_q, r) => {
      if (!r['customer_money']) return 'Open the customer first, then ask again.';
      const out = parse(r['customer_money']);
      if (out['error']) return String(out['error']);
      const who = str(out['customer'], 'They');
      const owes = str(out['owes'], '$0');
      const open = list(out['openInvoices']);
      if (owes === '$0')
        return `${who} owes nothing right now. They have paid ${str(out['paid'], '$0')} so far.`;
      return `${who} owes ${owes} across ${count(open.length, 'invoice')}, and has paid ${str(out['paid'], '$0')} so far.`;
    },
  },
  {
    // "Send the estimate <id>" — drafted as a card; nothing goes out until the person says yes.
    when: SEND,
    calls: (q) => [
      { name: 'send_estimate', arguments: { estimateId: SEND.exec(q)![1], channels: ['email'] } },
    ],
    reply: (_q, r) => {
      const out = parse(r['send_estimate']);
      if (out['error']) return `That estimate can’t be sent: ${String(out['error'])}`;
      return `Here it is, ready to go to ${str(out['customer'], 'them')} for ${str(out['total'], 'the quoted amount')}. Nothing is sent until you OK it.`;
    },
  },
  {
    // "Record $500 cash on <invoice id>" — money already taken, written down once the person says yes.
    when: RECORD,
    calls: (q) => {
      const [, amount, how, invoiceId] = RECORD.exec(q)!;
      return [
        {
          name: 'record_payment',
          arguments: {
            invoiceId,
            amount: Number(amount!.replace(/,/g, '')),
            method: /che(?:que|ck)/i.test(how ?? '') ? 'check' : 'cash',
          },
        },
      ];
    },
    reply: (_q, r) => {
      const out = parse(r['record_payment']);
      if (out['error']) return `That can’t be recorded: ${String(out['error'])}`;
      return `Here it is: ${str(out['amount'], 'the payment')} against ${str(out['customer'], 'their')} invoice. Nothing is written down until you OK it.`;
    },
  },
];
