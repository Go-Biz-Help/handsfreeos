/**
 * The Assistant's money answers (M9, step 13).
 *
 * Four tools that run on their own for anyone with `money.read`, and two that never move a cent until the
 * person says yes on a confirm card. Every one of them goes through the person's own queries and commands, so
 * the member rule that hides a job's invoice from the tech who wasn't on it hides it here too — in the
 * database, under the query, not in a filter written twice.
 *
 * Two things are deliberate:
 * - **Every figure on a card is formatted here, from real rows.** The model reads the same numbers back as
 *   text, but what the person sees is never the model's arithmetic.
 * - **`money.summary` is owners and admins only**, so a member asking "what are we owed?" gets the total of
 *   what they can see, with a line saying so, rather than a refusal or somebody else's receivables.
 */
import {
  ESTIMATE_WORDS,
  HfosError,
  INVOICE_WORDS,
  money,
  PAYMENT_METHOD_WORDS,
  type AssistantCard,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { command, query, when } from './tools-read';

type Args = Record<string, unknown>;
type MoneyCard = Extract<AssistantCard, { type: 'money' }>;
type Row = NonNullable<MoneyCard['items']>[number];

/** The Money pages a card's rows link to. */
export const moneyPaths = (ws: string) => ({
  invoices: () => `/app/w/${ws}/money`,
  invoice: (id: string) => `/app/w/${ws}/money/invoices/${id}`,
  estimates: () => `/app/w/${ws}/money/estimates`,
  estimate: (id: string) => `/app/w/${ws}/money/estimates/${id}`,
  payments: () => `/app/w/${ws}/money/payments`,
  plans: () => `/app/w/${ws}/money/plans`,
  plan: (id: string) => `/app/w/${ws}/money/plans/${id}`,
});

/**
 * A query only owners and admins may run, for someone who may not: null rather than an error, so the answer
 * narrows to what this person can see instead of failing.
 */
async function ifAllowed<T>(run: Promise<T>): Promise<T | null> {
  try {
    return await run;
  } catch (e) {
    if (e instanceof HfosError && (e.status === 403 || e.code === 'forbidden')) return null;
    throw e;
  }
}

interface Totals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}
interface Person {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}
interface InvoiceItem {
  id: string;
  number: string | null;
  status: string;
  state: string;
  title: string | null;
  person: Person;
  totals: Totals;
  balanceCents: number;
  amountPaidCents: number;
  dueOn: string | null;
  sentAt: string | null;
  createdAt: string;
}
interface EstimateItem {
  id: string;
  number: string | null;
  status: string;
  state: string;
  title: string | null;
  person: Person;
  totals: Totals;
  expiresOn: string | null;
  sentAt: string | null;
  firstViewedAt: string | null;
  createdAt: string;
}
interface PaymentItem {
  id: string;
  invoiceId: string;
  amountCents: number;
  method: string;
  status: string;
  refundedCents: number;
  cardBrand: string | null;
  cardLast4: string | null;
  receivedAt: string | null;
  createdAt: string;
  invoiceNumber?: string | null;
  person?: Person | null;
}
interface SubscriptionItem {
  id: string;
  status: string;
  planName: string;
  priceCents: number;
  interval: string;
  intervalCount: number;
  nextBillingOn: string | null;
}
interface Summary {
  outstandingCents: number;
  outstandingCount: number;
  overdueCents: number;
  overdueCount: number;
  settlingCents: number;
  collectedCents: number;
  refundedCents: number;
  quotedCents: number;
  quotedCount: number;
  activePlans: number;
  monthlyRecurringCents: number;
}

/** "Overdue", "Partly paid", "Opened" — core's words, the ones the document's own badge and page use. */
const invoiceWord = (state: string) => INVOICE_WORDS[state as keyof typeof INVOICE_WORDS] ?? state;
const estimateWord = (state: string) =>
  ESTIMATE_WORDS[state as keyof typeof ESTIMATE_WORDS] ?? state;

/** How a payment was made, as the Payments list says it: the card when there is one, else core's word for the way. */
export const paymentHow = (p: {
  method: string;
  cardBrand: string | null;
  cardLast4: string | null;
}): string =>
  p.method === 'card' && p.cardBrand && p.cardLast4
    ? `${p.cardBrand} •••• ${p.cardLast4}`
    : (PAYMENT_METHOD_WORDS[p.method as keyof typeof PAYMENT_METHOD_WORDS] ?? p.method);

/** The most rows a look-up reads to count or order a whole list; past it, the answer says it stopped short. */
const MOST_ROWS = 500;

/**
 * Every page of one of the money lists, as the person sees it, up to MOST_ROWS: counting them, or putting the oldest
 * first, needs the whole list rather than its newest page. `more` says it stopped short.
 */
async function everyPage<T>(
  db: Db,
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
  key: string,
): Promise<{ items: T[]; more: boolean }> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Record<string, unknown> = await query<Record<string, unknown>>(db, ctx, name, {
      ...input,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...((page[key] as T[] | undefined) ?? []));
    cursor = typeof page['nextCursor'] === 'string' ? page['nextCursor'] : null;
  } while (cursor && items.length < MOST_ROWS);
  return { items, more: cursor !== null };
}

/** Late is red and money on its way is amber; money that went back is done with, so it steps back. */
const toneOf = (state: string): Row['tone'] =>
  state === 'overdue'
    ? 'danger'
    : state === 'paying'
      ? 'warning'
      : state === 'refunded'
        ? 'muted'
        : 'accent';

/** A local date ('2026-10-22') as people say it, in the business's zone. */
const dayWords = (date: string | null, timezone: string): string =>
  date
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }).format(new Date(`${date}T12:00:00Z`))
    : 'no date';

const daysSince = (iso: string | null): number | null =>
  iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : null;

const forHowLong = (days: number | null): string =>
  days === null
    ? 'not sent yet'
    : days === 0
      ? 'out today'
      : days === 1
        ? 'out 1 day'
        : `out ${days} days`;

const documentName = (d: { number: string | null; title: string | null }, fallback: string) =>
  d.number ?? d.title ?? fallback;

const invoiceRow = (i: InvoiceItem, ws: string, timezone: string): Row => ({
  title: `${documentName(i, 'Draft invoice')} · ${i.person.fullName}`,
  detail:
    i.state === 'paying'
      ? `${money(i.balanceCents)} on its way`
      : `${money(i.balanceCents)} · due ${dayWords(i.dueOn, timezone)}`,
  status: invoiceWord(i.state),
  tone: toneOf(i.state),
  href: moneyPaths(ws).invoice(i.id),
});

const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The "there is nothing here" answer, so an empty list never reads as a failure. */
const nothing = (title: string, line: string, href: string): ToolOutcome => ({
  result: { total: '$0', count: 0, note: line },
  card: { type: 'money', title, value: '$0', detail: line, tone: 'muted', items: [], href },
});

export type MoneyTool = (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>;

export const moneyReadTools: Record<string, MoneyTool> = {
  /** "What are we owed?" / "What's overdue?" */
  async money_owed(db, ctx, args) {
    const ws = ctx.workspaceId;
    const personId = typeof args['personId'] === 'string' ? args['personId'] : undefined;
    const overdueOnly = args['overdueOnly'] === true;
    const limit = Number(args['limit'] ?? 8);
    // Owners and admins get the whole business's figures; a member gets the total of what they can see.
    const summary = personId ? null : await ifAllowed(query<Summary>(db, ctx, 'money.summary', {}));
    const filter = { openOnly: true, ...(personId ? { personId } : {}) };
    // With the business's own figures, the newest page is all there is to show. Counting them here (a member, one
    // customer) or putting the longest late first needs every open invoice, not the newest 25.
    const { items: listed, more } =
      summary && !overdueOnly
        ? await query<{ invoices: InvoiceItem[] }>(db, ctx, 'invoice.list', {
            ...filter,
            limit: Math.max(limit, 25),
          }).then((r) => ({ items: r.invoices, more: false }))
        : await everyPage<InvoiceItem>(db, ctx, 'invoice.list', filter, 'invoices');
    const open = overdueOnly
      ? listed.filter(isOverdue).sort((a, b) => (a.dueOn ?? '').localeCompare(b.dueOn ?? ''))
      : listed;
    const owedCents = summary && !overdueOnly ? summary.outstandingCents : total(open);
    const overdueCents = summary ? summary.overdueCents : total(listed.filter(isOverdue));
    const settlingCents = summary ? summary.settlingCents : total(listed.filter(isPaying));
    const owedCount = summary ? summary.outstandingCount : listed.length;
    const overdueCount = summary ? summary.overdueCount : listed.filter(isOverdue).length;
    const title = overdueOnly ? 'Overdue' : 'What you are owed';
    const href = moneyPaths(ws).invoices();
    if (open.length === 0)
      return nothing(
        title,
        overdueOnly ? 'Nothing is late.' : 'Every invoice has been paid.',
        href,
      );

    const shown = open.slice(0, limit);
    const mine = summary ? null : 'Only the jobs you are on are counted here.';
    const stats = [
      ...(overdueOnly
        ? []
        : [{ value: money(overdueCents), label: `overdue · ${counted(overdueCount, 'invoice')}` }]),
      ...(settlingCents > 0
        ? [{ value: money(settlingCents), label: 'on its way by bank transfer' }]
        : []),
    ];
    return {
      result: {
        owed: money(owedCents),
        invoicesOwed: overdueOnly ? overdueCount : owedCount,
        overdue: money(overdueCents),
        invoicesOverdue: overdueCount,
        settling: money(settlingCents),
        invoices: shown.map((i) => ({
          id: i.id,
          number: i.number,
          customer: i.person.fullName,
          balance: money(i.balanceCents),
          state: invoiceWord(i.state),
          dueOn: i.dueOn,
        })),
        ...(more
          ? {
              more: true,
              countedFrom: `the newest ${listed.length} open invoices; Money → Invoices has the rest`,
            }
          : {}),
        ...(mine ? { note: mine } : {}),
      },
      card: {
        type: 'money',
        title,
        value: money(overdueOnly ? overdueCents : owedCents),
        detail: [counted(overdueOnly ? overdueCount : owedCount, 'invoice'), mine]
          .filter(Boolean)
          .join(' · '),
        tone: overdueCents > 0 ? 'danger' : 'accent',
        stats: stats.slice(0, 4),
        items: shown.map((i) => invoiceRow(i, ws, ctx.timezone)),
        href,
      },
    };
  },

  /** "What did we collect this month?" */
  async money_collected(db, ctx, args) {
    const ws = ctx.workspaceId;
    const days = Number(args['days'] ?? 30);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [summary, list] = await Promise.all([
      ifAllowed(query<Summary>(db, ctx, 'money.summary', { days })),
      query<{ payments: PaymentItem[]; nextCursor: string | null }>(db, ctx, 'payment.list', {
        since,
        succeededOnly: true,
        limit: 100,
      }),
    ]);
    const paid = list.payments;
    const collectedCents = summary
      ? summary.collectedCents
      : paid.reduce((sum, p) => sum + p.amountCents - p.refundedCents, 0);
    const refundedCents = summary
      ? summary.refundedCents
      : paid.reduce((sum, p) => sum + p.refundedCents, 0);
    const window = days === 1 ? 'in the last day' : `in the last ${days} days`;
    const title = `Collected ${window}`;
    const href = moneyPaths(ws).payments();
    if (paid.length === 0 && collectedCents === 0)
      return nothing(title, `Nothing has come in ${window}.`, href);

    const mine = summary ? null : 'Only the jobs you are on are counted here.';
    return {
      result: {
        collected: money(collectedCents),
        refunded: money(refundedCents),
        payments: paid.length,
        days,
        // Who paid, for what, how and when: the Payments list's rows, newest first.
        newest: paid.slice(0, 20).map((p) => ({
          customer: p.person?.fullName ?? null,
          invoice: p.invoiceNumber ?? null,
          invoiceId: p.invoiceId,
          amount: money(p.amountCents),
          how: paymentHow(p),
          when: p.receivedAt ?? p.createdAt,
          ...(p.refundedCents > 0 ? { refunded: money(p.refundedCents) } : {}),
        })),
        ...(list.nextCursor
          ? {
              more: true,
              countedFrom: `the newest ${paid.length} payments; Money → Payments has the rest`,
            }
          : {}),
        ...(mine ? { note: mine } : {}),
      },
      card: {
        type: 'money',
        title,
        value: money(collectedCents),
        detail: [counted(paid.length, 'payment'), mine].filter(Boolean).join(' · '),
        tone: 'accent',
        stats: [
          ...(refundedCents > 0
            ? [{ value: money(refundedCents), label: 'refunded in the same window' }]
            : []),
          ...(summary && summary.outstandingCents > 0
            ? [{ value: money(summary.outstandingCents), label: 'still owed' }]
            : []),
        ],
        items: paid.slice(0, 8).map((p) => ({
          title: `${p.invoiceNumber ?? 'Payment'} · ${p.person?.fullName ?? 'Someone'}`,
          detail: [
            money(p.amountCents),
            paymentHow(p),
            when(p.receivedAt ?? p.createdAt, ctx.timezone),
          ].join(' · '),
          tone: 'muted' as const,
          href: href,
        })),
        href,
      },
    };
  },

  /** "Does ABC Dental owe us anything?" */
  async customer_money(db, ctx, args) {
    const ws = ctx.workspaceId;
    const personId = String(args['personId']);
    const got = await query<{
      estimates: EstimateItem[];
      invoices: InvoiceItem[];
      subscriptions: SubscriptionItem[];
      balanceCents: number;
      collectedCents: number;
      quotedCents: number;
    }>(db, ctx, 'money.for_record', { recordType: 'person', recordId: personId });
    const who =
      got.invoices[0]?.person.fullName ??
      got.estimates[0]?.person.fullName ??
      (await personName(db, ctx, personId));
    const open = got.invoices.filter((i) => i.balanceCents > 0 && i.state !== 'void');
    const href = moneyPaths(ws).invoices();
    const plans = got.subscriptions.filter((s) => s.status === 'active' || s.status === 'past_due');
    if (got.invoices.length === 0 && got.estimates.length === 0 && plans.length === 0)
      return nothing(who, 'Nothing has been quoted or billed to them yet.', href);

    return {
      result: {
        customer: who,
        owes: money(got.balanceCents),
        paid: money(got.collectedCents),
        quotedOut: money(got.quotedCents),
        openInvoices: open.map((i) => ({
          id: i.id,
          number: i.number,
          balance: money(i.balanceCents),
          state: invoiceWord(i.state),
          dueOn: i.dueOn,
        })),
        estimates: got.estimates.map((e) => ({
          id: e.id,
          number: e.number,
          total: money(e.totals.totalCents),
          state: estimateWord(e.state),
        })),
        plans: plans.map((s) => ({ id: s.id, plan: s.planName, price: money(s.priceCents) })),
      },
      card: {
        type: 'money',
        title: who,
        value: money(got.balanceCents),
        detail: got.balanceCents > 0 ? 'owed right now' : 'nothing owed',
        tone: got.balanceCents > 0 ? 'warning' : 'accent',
        stats: [
          { value: money(got.collectedCents), label: 'paid so far' },
          ...(got.quotedCents > 0
            ? [{ value: money(got.quotedCents), label: 'quoted and waiting' }]
            : []),
          ...(plans.length ? [{ value: String(plans.length), label: 'plans billing' }] : []),
        ].slice(0, 4),
        items: [
          ...open.slice(0, 5).map((i) => invoiceRow(i, ws, ctx.timezone)),
          ...got.estimates
            .filter((e) => e.state === 'sent' || e.state === 'viewed')
            .slice(0, 3)
            .map((e) => estimateRow(e, ws, ctx.timezone)),
        ].slice(0, 8),
        href: `/app/w/${ws}/customers/people/${personId}`,
      },
    };
  },

  /** "Which estimates are waiting?" */
  async estimates_waiting(db, ctx, args) {
    const ws = ctx.workspaceId;
    const limit = Number(args['limit'] ?? 8);
    // Every one that is out, not the newest page: the oldest are the ones to chase. One past its date isn't
    // waiting any more, even before the nightly job marks it expired, and the business's figure leaves it out too.
    const [summary, list] = await Promise.all([
      ifAllowed(query<Summary>(db, ctx, 'money.summary', {})),
      everyPage<EstimateItem>(db, ctx, 'estimate.list', { openOnly: true }, 'estimates'),
    ]);
    // Oldest out first: the one that has been waiting longest is the one to chase.
    const waiting = list.items
      .filter((e) => e.state !== 'expired')
      .sort((a, b) => (a.sentAt ?? a.createdAt).localeCompare(b.sentAt ?? b.createdAt));
    const href = moneyPaths(ws).estimates();
    if (waiting.length === 0)
      return nothing('Estimates waiting', 'Every estimate has been answered.', href);

    const shown = waiting.slice(0, limit);
    const quotedCents = summary
      ? summary.quotedCents
      : waiting.reduce((sum, e) => sum + e.totals.totalCents, 0);
    const count = summary ? summary.quotedCount : waiting.length;
    const opened = waiting.filter((e) => !!e.firstViewedAt).length;
    return {
      result: {
        quotedOut: money(quotedCents),
        waiting: count,
        opened,
        ...(list.more
          ? {
              more: true,
              countedFrom: `the newest ${list.items.length} estimates out; Money → Estimates has the rest`,
            }
          : {}),
        ...(summary ? {} : { note: 'Only the jobs you are on are counted here.' }),
        estimates: shown.map((e) => ({
          id: e.id,
          number: e.number,
          customer: e.person.fullName,
          total: money(e.totals.totalCents),
          out: forHowLong(daysSince(e.sentAt)),
          opened: !!e.firstViewedAt,
          expiresOn: e.expiresOn,
        })),
      },
      card: {
        type: 'money',
        title: 'Estimates waiting',
        value: money(quotedCents),
        detail: `${counted(count, 'estimate')} out · ${opened} opened`,
        tone: 'accent',
        stats: [],
        items: shown.map((e) => estimateRow(e, ws, ctx.timezone)),
        href,
      },
    };
  },
};

const total = (list: readonly InvoiceItem[]) => list.reduce((sum, i) => sum + i.balanceCents, 0);
const isOverdue = (i: InvoiceItem) => i.state === 'overdue';
const isPaying = (i: InvoiceItem) => i.state === 'paying';

function estimateRow(e: EstimateItem, ws: string, timezone: string): Row {
  const days = daysSince(e.sentAt);
  return {
    title: `${documentName(e, 'Draft estimate')} · ${e.person.fullName}`,
    detail: [
      money(e.totals.totalCents),
      forHowLong(days),
      e.firstViewedAt ? 'opened' : null,
      e.expiresOn ? `good until ${dayWords(e.expiresOn, timezone)}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    status: estimateWord(e.state),
    tone: days !== null && days >= 7 ? 'warning' : 'accent',
    href: moneyPaths(ws).estimate(e.id),
  };
}

async function personName(db: Db, ctx: ToolContext, personId: string): Promise<string> {
  const got = await query<{ person: { fullName: string } }>(db, ctx, 'person.get', { personId });
  return got.person.fullName;
}

// ---------------------------------------------------------------------------
// The two that wait for the person's OK
// ---------------------------------------------------------------------------

interface ConfirmTool {
  prepare(db: Db, ctx: ToolContext, args: Args, toolCallId: string): Promise<PreparedAction>;
  commit(
    db: Db,
    ctx: ToolContext,
    args: Args,
    extra: { lostReason?: string; toolCallId: string },
  ): Promise<CommittedAction>;
}

const confirmCard = (
  toolCallId: string,
  tool: string,
  card: {
    title: string;
    personId: string | null;
    fields: { label: string; value: string }[];
    body: string | null;
    warnings: { kind: string; text: string }[];
    confirmLabel: string;
  },
): AssistantCard => ({
  type: 'confirm',
  toolCallId,
  tool,
  personId: card.personId,
  conversationId: null,
  title: card.title,
  // A line with nothing to say (no way to reach them) is left off, as the billing cards leave it.
  fields: card.fields.filter((f) => f.value).slice(0, 6),
  body: card.body,
  stageFrom: null,
  stageTo: null,
  warnings: card.warnings.slice(0, 3),
  reasons: [],
  confirmLabel: card.confirmLabel,
  editable: false,
});

interface EstimateGet {
  estimate: EstimateItem & { notes: string | null; lines: unknown[] };
}
interface InvoiceGet {
  invoice: InvoiceItem;
}

const firstName = (full: string) => full.split(' ')[0] || full;

/** The channels a customer can actually be reached on, of the ones asked for: what a send dialog leaves live. */
export function reachable(person: Person, asked: readonly string[]) {
  const can = asked.filter((c) => (c === 'sms' ? !!person.phone : !!person.email));
  const missing = asked.filter((c) => !can.includes(c));
  const how = (c: string) =>
    c === 'sms' ? `Text · ${person.phone ?? ''}` : `Email · ${person.email ?? ''}`;
  return { can, missing, words: can.map(how).join(' and ') };
}

/** Why nothing can go to someone, from the ways asked for that they have nothing on file for. */
export const unreachable = (who: string, missing: readonly string[], what: string) =>
  `${who} has no ${
    missing.length > 1
      ? 'mobile number or email address'
      : missing[0] === 'sms'
        ? 'mobile number'
        : 'email address'
  } on file, so ${what} can’t go to them. Add one on their page in Customers, then try again.`;

export const noContact = (who: string, channel: string) =>
  channel === 'sms'
    ? `No mobile number on file for ${who}, so no text goes.`
    : `No email address on file for ${who}, so no email goes.`;

/** Why an estimate that isn't a draft can't be sent, and what to do instead. */
function notADraft(e: { number: string | null; status: string }, first: string): HfosError {
  const name = e.number ?? 'That estimate';
  return HfosError.rule(
    'estimate_not_open',
    409,
    e.status === 'void'
      ? `${name} was voided, so it can’t be sent. Write a new estimate to quote again.`
      : `${name} has already gone out, and ${first} has its link. To send that again, give them its link (get_customer_link) in a text or email; to send a changed one, void it and write a new estimate.`,
  );
}

/** Sending an estimate: who it goes to, what it says, and that sending freezes it. */
const sendEstimate: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { estimate } = await query<EstimateGet>(db, ctx, 'estimate.get', {
      estimateId: args['estimateId'],
    });
    const person = estimate.person;
    const first = firstName(person.fullName);
    // What the screen refuses is said before the card, not after the press: only a draft with a line goes out.
    if (estimate.status !== 'draft') throw notADraft(estimate, first);
    if (!estimate.lines.length)
      throw HfosError.rule(
        'money_document_empty',
        409,
        'This estimate has no lines yet, so there’s nothing to quote. Add one with write_estimate, then send it.',
      );
    const asked = (args['channels'] as string[] | undefined) ?? ['email'];
    // Only the ways they can be reached, as the send dialog greys out the others; with none, Send stays off.
    const to = reachable(person, asked);
    const blocked = to.can.length === 0;
    const card = confirmCard(toolCallId, 'send_estimate', {
      title: `Send ${documentName(estimate, 'this estimate')} to ${person.fullName}`,
      personId: person.id,
      fields: [
        { label: 'To', value: person.fullName },
        { label: 'How', value: to.words },
        { label: 'Total', value: money(estimate.totals.totalCents) },
        ...(estimate.title ? [{ label: 'For', value: estimate.title }] : []),
      ],
      body: (args['message'] as string | undefined) ?? null,
      warnings: blocked
        ? [{ kind: 'blocked', text: unreachable(person.fullName, to.missing, 'the estimate') }]
        : [
            {
              kind: 'freezes',
              text: 'Sending takes its number and freezes it. Changing it afterwards means voiding and reissuing.',
            },
            ...to.missing.map((c) => ({ kind: 'note', text: noContact(first, c) })),
          ],
      confirmLabel: blocked ? '' : 'Send it',
    });
    return {
      card,
      result: blocked
        ? { blocked: true, why: unreachable(person.fullName, to.missing, 'the estimate') }
        : {
            estimateId: estimate.id,
            customer: person.fullName,
            total: money(estimate.totals.totalCents),
            channels: to.can,
          },
    };
  },
  async commit(db, ctx, args) {
    const { estimate } = await query<EstimateGet>(db, ctx, 'estimate.get', {
      estimateId: args['estimateId'],
    });
    const to = reachable(estimate.person, (args['channels'] as string[] | undefined) ?? ['email']);
    if (!to.can.length)
      throw HfosError.rule(
        'no_contact',
        409,
        unreachable(estimate.person.fullName, to.missing, 'the estimate'),
      );
    const out = await command<{ estimateId: string; number: string | null }>(
      db,
      ctx,
      'estimate.send',
      {
        estimateId: estimate.id,
        channels: to.can,
        message: (args['message'] as string | undefined) ?? null,
      },
    );
    return {
      outcome: `Sent ${out.number ?? 'the estimate'}`,
      href: moneyPaths(ctx.workspaceId).estimate(out.estimateId),
      command: 'estimate.send',
    };
  },
};

/** Writing down money already taken. It never charges a card: only a person's own hands did this one. */
const recordPayment: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { invoice } = await query<InvoiceGet>(db, ctx, 'invoice.get', {
      invoiceId: args['invoiceId'],
    });
    // The command's own refusals, said before the card: the screen only offers Record a payment while
    // something is owed on an invoice that went out.
    if (invoice.status === 'void')
      throw HfosError.rule(
        'invoice_voided',
        409,
        'That invoice was voided, so it can’t take a payment. Record the payment on a new invoice instead.',
      );
    if (invoice.status === 'draft')
      throw HfosError.rule(
        'invoice_not_sent',
        409,
        'This invoice is still a draft. Send it before recording a payment on it.',
      );
    if (invoice.balanceCents <= 0)
      throw HfosError.rule(
        'invoice_settled',
        409,
        'That invoice is already paid in full, so there’s nothing left to record.',
      );
    const method = String(args['method'] ?? 'cash');
    const asked = args['amount'] === undefined ? null : Math.round(Number(args['amount']) * 100);
    const amountCents = asked ?? invoice.balanceCents;
    const owed = money(invoice.balanceCents);
    // The dialog's Record it stays off for more than is owed, or nothing at all; so does Confirm here.
    const blocked =
      amountCents > invoice.balanceCents
        ? `That’s more than the ${owed} still owed on it. Record ${owed} or less.`
        : amountCents < 1
          ? 'Say how much was paid: a cent or more.'
          : null;
    const card = confirmCard(toolCallId, 'record_payment', {
      title: `Record ${money(amountCents)} on ${documentName(invoice, 'this invoice')}`,
      personId: invoice.person.id,
      fields: [
        { label: 'Customer', value: invoice.person.fullName },
        { label: 'Amount', value: money(amountCents) },
        {
          label: 'How',
          value: PAYMENT_METHOD_WORDS[method as keyof typeof PAYMENT_METHOD_WORDS] ?? method,
        },
        { label: 'Still owed', value: money(Math.max(0, invoice.balanceCents - amountCents)) },
      ],
      body: (args['reference'] as string | undefined) ?? null,
      warnings: blocked
        ? [{ kind: 'blocked', text: blocked }]
        : [
            {
              kind: 'not_a_charge',
              text: 'This writes down money you have already taken. Nothing is charged to a card.',
            },
          ],
      confirmLabel: blocked ? '' : 'Record it',
    });
    return {
      card,
      result: blocked
        ? { blocked: true, why: blocked }
        : {
            invoiceId: invoice.id,
            customer: invoice.person.fullName,
            amount: money(amountCents),
            balance: owed,
          },
    };
  },
  async commit(db, ctx, args) {
    const { invoice } = await query<InvoiceGet>(db, ctx, 'invoice.get', {
      invoiceId: args['invoiceId'],
    });
    const asked = args['amount'] === undefined ? null : Math.round(Number(args['amount']) * 100);
    const amountCents = asked ?? invoice.balanceCents;
    const out = await command<{ paymentId: string; invoiceBalanceCents: number }>(
      db,
      ctx,
      'invoice.record_cash_payment',
      {
        invoiceId: invoice.id,
        amountCents,
        method: args['method'] ?? 'cash',
        reference: (args['reference'] as string | undefined) ?? null,
      },
    );
    const left = Number(out.invoiceBalanceCents);
    return {
      outcome:
        left > 0
          ? `Recorded ${money(amountCents)} — ${money(left)} still owed`
          : `Recorded ${money(amountCents)} — paid in full`,
      href: moneyPaths(ctx.workspaceId).invoice(invoice.id),
      command: 'invoice.record_cash_payment',
    };
  },
};

export const moneyConfirmTools: Record<string, ConfirmTool> = {
  send_estimate: sendEstimate,
  record_payment: recordPayment,
};
