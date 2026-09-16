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
import { HfosError, money, type AssistantCard } from '@hfos/core/server';
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

/** "Overdue", "Paying", "Sent" — the same words the document's own page uses. */
const STATE_WORDS: Readonly<Record<string, string>> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Opened',
  partly_paid: 'Part paid',
  paying: 'Paying',
  paid: 'Paid',
  refunded: 'Refunded',
  partly_refunded: 'Partly refunded',
  overdue: 'Overdue',
  accepted: 'Approved',
  declined: 'Declined',
  expired: 'Expired',
  void: 'Voided',
};
const stateWord = (state: string) => STATE_WORDS[state] ?? state;

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
  status: stateWord(i.state),
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
    const [summary, list] = await Promise.all([
      // Owners and admins get the whole business's figure; a member gets the total of what they can see.
      personId ? Promise.resolve(null) : ifAllowed(query<Summary>(db, ctx, 'money.summary', {})),
      query<{ invoices: InvoiceItem[] }>(db, ctx, 'invoice.list', {
        openOnly: true,
        limit: Math.max(limit, 25),
        ...(personId ? { personId } : {}),
      }),
    ]);
    const open = list.invoices.filter((i) => (overdueOnly ? i.state === 'overdue' : true));
    const owedCents = summary && !overdueOnly ? summary.outstandingCents : total(open);
    const overdueCents = summary ? summary.overdueCents : total(open.filter(isOverdue));
    const settlingCents = summary ? summary.settlingCents : total(open.filter(isPaying));
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
        : [{ value: money(overdueCents), label: `overdue · ${countOf(open, isOverdue)}` }]),
      ...(settlingCents > 0
        ? [{ value: money(settlingCents), label: 'on its way by bank transfer' }]
        : []),
    ];
    return {
      result: {
        owed: money(owedCents),
        overdue: money(overdueCents),
        settling: money(settlingCents),
        invoices: shown.map((i) => ({
          id: i.id,
          number: i.number,
          customer: i.person.fullName,
          balance: money(i.balanceCents),
          state: stateWord(i.state),
          dueOn: i.dueOn,
        })),
        ...(mine ? { note: mine } : {}),
      },
      card: {
        type: 'money',
        title,
        value: money(overdueOnly ? overdueCents : owedCents),
        detail: [counted(open.length, 'invoice'), mine].filter(Boolean).join(' · '),
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
      query<{ payments: PaymentItem[] }>(db, ctx, 'payment.list', {
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
            p.cardBrand && p.cardLast4
              ? `${p.cardBrand} •••• ${p.cardLast4}`
              : methodWord(p.method),
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
          state: stateWord(i.state),
          dueOn: i.dueOn,
        })),
        estimates: got.estimates.map((e) => ({
          id: e.id,
          number: e.number,
          total: money(e.totals.totalCents),
          state: stateWord(e.state),
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
    const list = await query<{ estimates: EstimateItem[] }>(db, ctx, 'estimate.list', {
      openOnly: true,
      limit: Math.max(limit, 25),
    });
    // Oldest out first: the one that has been waiting longest is the one to chase.
    const waiting = [...list.estimates].sort((a, b) =>
      (a.sentAt ?? a.createdAt).localeCompare(b.sentAt ?? b.createdAt),
    );
    const href = moneyPaths(ws).estimates();
    if (waiting.length === 0)
      return nothing('Estimates waiting', 'Every estimate has been answered.', href);

    const shown = waiting.slice(0, limit);
    const quotedCents = waiting.reduce((sum, e) => sum + e.totals.totalCents, 0);
    const opened = waiting.filter((e) => !!e.firstViewedAt).length;
    return {
      result: {
        quotedOut: money(quotedCents),
        waiting: waiting.length,
        opened,
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
        detail: `${counted(waiting.length, 'estimate')} out · ${opened} opened`,
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
const countOf = (list: readonly InvoiceItem[], is: (i: InvoiceItem) => boolean) =>
  counted(list.filter(is).length, 'invoice');

const METHOD_WORDS: Readonly<Record<string, string>> = {
  card: 'card',
  bank_transfer: 'bank transfer',
  cash: 'cash',
  check: 'cheque',
  other: 'recorded by hand',
};
const methodWord = (method: string) => METHOD_WORDS[method] ?? method;

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
    status: stateWord(e.state),
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
  fields: card.fields.slice(0, 6),
  body: card.body,
  stageFrom: null,
  stageTo: null,
  warnings: card.warnings.slice(0, 3),
  reasons: [],
  confirmLabel: card.confirmLabel,
  editable: false,
});

interface EstimateGet {
  estimate: EstimateItem & { notes: string | null };
}
interface InvoiceGet {
  invoice: InvoiceItem;
}

/** Sending an estimate: who it goes to, what it says, and that sending freezes it. */
const sendEstimate: ConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { estimate } = await query<EstimateGet>(db, ctx, 'estimate.get', {
      estimateId: args['estimateId'],
    });
    const channels = (args['channels'] as string[] | undefined) ?? ['email'];
    const person = estimate.person;
    const warnings: { kind: string; text: string }[] = [];
    if (estimate.status !== 'draft')
      warnings.push({
        kind: 'already_sent',
        text: `This estimate has already gone out — it reads as ${stateWord(estimate.state).toLowerCase()}.`,
      });
    if (channels.includes('email') && !person.email)
      warnings.push({ kind: 'no_email', text: 'No email address on file for them.' });
    if (channels.includes('sms') && !person.phone)
      warnings.push({ kind: 'no_phone', text: 'No mobile number on file for them.' });
    warnings.push({
      kind: 'freezes',
      text: 'Sending takes its number and freezes it. Changing it afterwards means voiding and reissuing.',
    });
    const card = confirmCard(toolCallId, 'send_estimate', {
      title: `Send ${documentName(estimate, 'this estimate')} to ${person.fullName}`,
      personId: person.id,
      fields: [
        { label: 'To', value: person.fullName },
        {
          label: 'How',
          value: channels.map((c) => (c === 'sms' ? 'Text' : 'Email')).join(' and '),
        },
        { label: 'Total', value: money(estimate.totals.totalCents) },
        ...(estimate.title ? [{ label: 'For', value: estimate.title }] : []),
      ],
      body: (args['message'] as string | undefined) ?? null,
      warnings,
      confirmLabel: 'Send it',
    });
    return {
      card,
      result: {
        estimateId: estimate.id,
        customer: person.fullName,
        total: money(estimate.totals.totalCents),
        channels,
      },
    };
  },
  async commit(db, ctx, args) {
    const out = await command<{ estimateId: string; number: string | null }>(
      db,
      ctx,
      'estimate.send',
      {
        estimateId: args['estimateId'],
        channels: args['channels'] ?? ['email'],
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
    const method = String(args['method'] ?? 'cash');
    const asked = args['amount'] === undefined ? null : Math.round(Number(args['amount']) * 100);
    const amountCents = asked ?? invoice.balanceCents;
    const warnings: { kind: string; text: string }[] = [];
    if (invoice.balanceCents <= 0)
      warnings.push({ kind: 'nothing_owed', text: 'This invoice has already been paid in full.' });
    if (amountCents > invoice.balanceCents && invoice.balanceCents > 0)
      warnings.push({
        kind: 'over_balance',
        text: `That is more than the ${money(invoice.balanceCents)} still owed.`,
      });
    warnings.push({
      kind: 'not_a_charge',
      text: 'This writes down money you have already taken. Nothing is charged to a card.',
    });
    const card = confirmCard(toolCallId, 'record_payment', {
      title: `Record ${money(amountCents)} on ${documentName(invoice, 'this invoice')}`,
      personId: invoice.person.id,
      fields: [
        { label: 'Customer', value: invoice.person.fullName },
        { label: 'Amount', value: money(amountCents) },
        { label: 'How', value: methodWord(method) },
        { label: 'Still owed', value: money(Math.max(0, invoice.balanceCents - amountCents)) },
      ],
      body: (args['reference'] as string | undefined) ?? null,
      warnings,
      confirmLabel: 'Record it',
    });
    return {
      card,
      result: {
        invoiceId: invoice.id,
        customer: invoice.person.fullName,
        amount: money(amountCents),
        balance: money(invoice.balanceCents),
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
