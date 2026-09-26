/**
 * The Assistant's billing tools (packages/core/src/assistant/tools-billing.ts): what each does when it runs on its own
 * ("auto"), and the card it shows and the command it runs once the person presses Confirm ("confirm").
 *
 * Three things held to throughout:
 * - **Every figure on a card is worked out here, from real rows, with core's own arithmetic** (`computeTotals`), so
 *   the total the person approves is the total the command stores — never the model's sum.
 * - **A document is saved whole, the way the editor saves it.** The draft is read again at commit and saved against
 *   the revision it has then, with every field the person didn't mention carried over: the update commands blank
 *   whatever they aren't sent, so leaving the note out must not wipe the note.
 * - **Anything that sends money out, reaches a customer or can't be undone says so on the card**, and what the
 *   screens refuse (a plan with nowhere to bill, top-up with no card) is shown as a card that can't be confirmed.
 */
import {
  cardLine,
  computeTotals,
  depositProblem,
  dueDateFor,
  estimateMoveProblem,
  ESTIMATE_WORDS,
  HfosError,
  INVOICE_WORDS,
  invoiceVoidBlock,
  isManualPaymentMethod,
  lineRateLabel,
  money,
  numberingAtCounter,
  numberingChangeProblem,
  numberPreview,
  percentLabel,
  planPriceLabel,
  TERMS_WORDS,
  type AssistantCard,
  type DocumentNumbering,
  type DocumentTotals,
  type EstimateStatus,
  type MoneySettings,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';
import { moneyPaths } from './tools-money';
import { command, query, quoted } from './tools-read';
import type { SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };
type Warning = { kind: string; text: string };
type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
type ListCard = Extract<AssistantCard, { type: 'list' }>;
type Terms = { kind: 'none' | 'percent' | 'amount'; percentBp?: number; amountCents?: number };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : undefined);
const cents = (d: number) => Math.round(d * 100);
const firstName = (full: string) => full.split(' ')[0] || full;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const nothingChanges = () => HfosError.validation([], 'Nothing would change.');

/** A local date ('2026-10-22') as people say it, in the business's zone. */
const dayWords = (date: string, timezone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));

/** Today where the business is, as a local date. */
const todayIn = (timezone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** The confirm card every tool here draws: at most ten lines and three warnings, blank lines left off. */
function billCard(
  toolCallId: string,
  tool: string,
  card: {
    title: string;
    fields: Field[];
    confirmLabel: string;
    warnings?: Warning[];
    body?: string | null;
    personId?: string | null;
  },
): ConfirmCard {
  return {
    type: 'confirm',
    toolCallId,
    tool,
    personId: card.personId ?? null,
    conversationId: null,
    title: card.title,
    fields: card.fields.filter((f) => f.value).slice(0, 10),
    body: card.body ?? null,
    stageFrom: null,
    stageTo: null,
    warnings: (card.warnings ?? []).slice(0, 3),
    reasons: [],
    confirmLabel: card.confirmLabel,
    editable: false,
  };
}

// ---------------------------------------------------------------------------
// What the queries hand back
// ---------------------------------------------------------------------------

interface Person {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}
interface Totals {
  subtotalCents: number;
  discountCents: number;
  discountPercentBp: number | null;
  taxCents: number;
  taxRateBp: number;
  taxLabel: string | null;
  totalCents: number;
}
interface LineOut {
  productId: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitLabel: string;
  unitPriceCents: number;
  taxable: boolean;
  discountCents: number;
  amountCents: number;
}
interface Estimate {
  id: string;
  number: string | null;
  status: string;
  state: string;
  title: string | null;
  person: Person;
  leadId: string | null;
  totals: Totals;
  deposit: { kind: 'none' | 'percent' | 'amount'; percentBp: number; amountCents: number };
  depositCents: number;
  expiresOn: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  acceptedName: string | null;
  acceptedVia: string | null;
  declinedAt: string | null;
  declinedReason: string | null;
  voidReason: string | null;
  notes: string | null;
  revision: number;
  lines: LineOut[];
}
interface EstimateGet {
  estimate: Estimate;
  invoices: {
    id: string;
    number: string | null;
    state: string;
    purpose: string;
    totalCents: number;
    balanceCents: number;
  }[];
}
interface Invoice {
  id: string;
  number: string | null;
  status: string;
  state: string;
  purpose: string;
  title: string | null;
  person: Person;
  leadId: string | null;
  connectionId: string | null;
  totals: Totals;
  amountPaidCents: number;
  amountRefundedCents: number;
  balanceCents: number;
  dueOn: string | null;
  terms: string | null;
  sentAt: string | null;
  voidReason: string | null;
  notes: string | null;
  revision: number;
  lines: LineOut[];
}
interface Payment {
  id: string;
  amountCents: number;
  method: string;
  provider: string | null;
  status: string;
  refundedCents: number;
  cardBrand: string | null;
  cardLast4: string | null;
  receivedAt: string | null;
  createdAt: string;
}
interface Refund {
  id: string;
  paymentId: string;
  amountCents: number;
  reason: string | null;
  status: string;
  refundedAt: string | null;
  createdAt: string;
}
interface InvoiceGet {
  invoice: Invoice;
  payments: Payment[];
  refunds: Refund[];
}
interface Product {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
  unitLabel: string;
  taxable: boolean;
}
interface Plan {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  interval: string;
  intervalCount: number;
  taxable: boolean;
  includes: string[];
  serviceId: string | null;
  visitEveryMonths: number | null;
  archivedAt: string | null;
}
interface Subscription {
  id: string;
  status: string;
  planId: string | null;
  planName: string;
  priceCents: number;
  interval: string;
  intervalCount: number;
  person: Person;
  connectionId: string | null;
  provider: string | null;
  hasCard: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  cardRequestedAt: string | null;
  nextBillingOn: string | null;
}
interface Connection {
  id: string;
  provider: string;
  status: string;
  label: string | null;
  displayName: string | null;
  externalAccountId: string | null;
  isDefault: boolean;
  usableByMe: boolean;
}
interface MoneySettingsGet {
  settings: MoneySettings;
  nextEstimateNumber: string;
  nextInvoiceNumber: string;
}

const settingsOf = (db: Db, ctx: ToolContext) => query<MoneySettingsGet>(db, ctx, 'money.settings');
const estimateOf = (db: Db, ctx: ToolContext, estimateId: unknown) =>
  query<EstimateGet>(db, ctx, 'estimate.get', { estimateId });
const invoiceOf = (db: Db, ctx: ToolContext, invoiceId: unknown) =>
  query<InvoiceGet>(db, ctx, 'invoice.get', { invoiceId });
const personOf = async (db: Db, ctx: ToolContext, personId: unknown) =>
  (await query<{ person: Person }>(db, ctx, 'person.get', { personId })).person;
const connectionsOf = (db: Db, ctx: ToolContext) =>
  query<{ connections: Connection[] }>(db, ctx, 'payment_connection.list')
    .then((r) => r.connections)
    .catch(() => [] as Connection[]);

/** A query only some may run, for someone who may not: null rather than an error, so the answer narrows. */
async function ifAllowed<T>(run: Promise<T>): Promise<T | null> {
  try {
    return await run;
  } catch (e) {
    if (e instanceof HfosError && (e.status === 403 || e.code === 'forbidden')) return null;
    throw e;
  }
}

const providerName = (p: string | null | undefined) =>
  p === 'square' ? 'Square' : p === 'stripe' ? 'Stripe' : (p ?? 'the provider');

/** "Stripe · Lone Star HVAC", the way every money screen names an account. */
const accountLabel = (c: Connection) => {
  const name = c.label ?? c.displayName ?? c.externalAccountId;
  return name ? `${providerName(c.provider)} · ${name}` : providerName(c.provider);
};

/** The accounts this person may bill into, their default first — what the server would pick when none is named. */
const usableAccounts = (all: readonly Connection[]) =>
  all
    .filter((c) => c.status === 'active' && c.usableByMe)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

const METHOD_WORDS: Readonly<Record<string, string>> = {
  card: 'card',
  ach: 'bank transfer',
  bank_transfer: 'bank transfer',
  cash: 'cash',
  check: 'cheque',
  other: 'taken another way',
};
const paymentWords = (p: Payment) =>
  p.method === 'card' && p.cardBrand && p.cardLast4
    ? `${p.cardBrand} •••• ${p.cardLast4}`
    : (METHOD_WORDS[p.method] ?? p.method);

// ---------------------------------------------------------------------------
// Lines, discounts and deposits, as the editor sends them
// ---------------------------------------------------------------------------

/** A line as the commands take it (`MoneyLineInput`). */
interface LineIn {
  productId: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitLabel: string;
  unitPriceCents: number;
  taxable: boolean;
  discountCents: number;
}
/** A line as the model writes it. */
interface LineArg {
  productId?: string;
  name?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  unitLabel?: string;
  taxable?: boolean;
  discountDollars?: number;
}

const lineIn = (l: LineOut): LineIn => ({
  productId: l.productId,
  name: l.name,
  description: l.description,
  quantity: l.quantity,
  unitLabel: l.unitLabel,
  unitPriceCents: l.unitPriceCents,
  taxable: l.taxable,
  discountCents: l.discountCents,
});

/** The catalogue, read only when a line asks for something from it. */
async function catalogueFor(db: Db, ctx: ToolContext, args: Args): Promise<Map<string, Product>> {
  const asked = [
    ...(list<LineArg>(args['lines']) ?? []),
    ...(list<LineArg>(args['addLines']) ?? []),
  ];
  if (!asked.some((l) => l.productId)) return new Map();
  const { products } = await query<{ products: Product[] }>(db, ctx, 'product.list');
  return new Map(products.map((p) => [p.id, p]));
}

/** A line from the catalogue takes what the item says unless told otherwise; a one-off needs a name and a price. */
function lineFrom(l: LineArg, products: Map<string, Product>, settings: MoneySettings): LineIn {
  // Three decimal places at most, as the line schema allows.
  const quantity = Math.round((l.quantity ?? 1) * 1000) / 1000;
  const discountCents = cents(l.discountDollars ?? 0);
  if (l.productId) {
    const p = products.get(l.productId);
    if (!p)
      throw HfosError.notFound(
        'That item isn’t in the catalogue. get_settings with area products lists what is.',
      );
    return {
      productId: p.id,
      name: l.name ?? p.name,
      description: l.description ?? p.description,
      quantity,
      unitLabel: l.unitLabel ?? p.unitLabel,
      unitPriceCents: l.unitPrice === undefined ? p.unitPriceCents : cents(l.unitPrice),
      taxable: l.taxable ?? p.taxable,
      discountCents,
    };
  }
  if (!l.name)
    throw HfosError.validation(
      [{ path: 'lines', message: 'Name the line.' }],
      'A line not from the catalogue needs a name.',
    );
  if (l.unitPrice === undefined)
    throw HfosError.validation(
      [{ path: 'lines', message: 'Give it a price.' }],
      `Give “${l.name}” a price.`,
    );
  return {
    productId: null,
    name: l.name,
    description: l.description ?? null,
    quantity,
    unitLabel: l.unitLabel ?? 'each',
    unitPriceCents: cents(l.unitPrice),
    // A line typed by hand is taxed the way the business taxes anything new.
    taxable: l.taxable ?? settings.tax.newProductsTaxable,
    discountCents,
  };
}

/** The lines after a change: the whole list replaced, or some taken off and some added. */
function linesAfter(
  args: Args,
  existing: readonly LineIn[],
  products: Map<string, Product>,
  settings: MoneySettings,
): LineIn[] {
  const given = list<LineArg>(args['lines']);
  const added = list<LineArg>(args['addLines']) ?? [];
  const removed = list<number>(args['removeLines']) ?? [];
  if (given && removed.length)
    throw HfosError.validation(
      [{ path: 'removeLines', message: 'Pass one or the other.' }],
      'Pass the whole list of lines, or the line numbers to take off — not both.',
    );
  for (const n of removed)
    if (n > existing.length)
      throw HfosError.validation(
        [{ path: 'removeLines', message: `There is no line ${n}.` }],
        `There is no line ${n}; it has ${counted(existing.length, 'line')}.`,
      );
  const kept = given
    ? given.map((l) => lineFrom(l, products, settings))
    : existing.filter((_, i) => !removed.includes(i + 1));
  return [...kept, ...added.map((l) => lineFrom(l, products, settings))];
}

/** A discount or a deposit from a percent or an amount; 0 means none, and nothing given means leave it. */
function termsFrom(percent: unknown, dollarsAmount: unknown): Terms | undefined {
  const pct = num(percent);
  const amount = num(dollarsAmount);
  if (pct !== undefined)
    return pct > 0 ? { kind: 'percent', percentBp: Math.round(pct * 100) } : { kind: 'none' };
  if (amount !== undefined)
    return amount > 0 ? { kind: 'amount', amountCents: cents(amount) } : { kind: 'none' };
  return undefined;
}

/** The discount a saved document has, in the shape it was written (as the editor reads it back). */
const discountNow = (t: Totals): Terms =>
  t.discountPercentBp
    ? { kind: 'percent', percentBp: t.discountPercentBp }
    : t.discountCents > 0
      ? { kind: 'amount', amountCents: t.discountCents }
      : { kind: 'none' };

const depositNow = (d: Estimate['deposit']): Terms =>
  d.kind === 'percent'
    ? { kind: 'percent', percentBp: d.percentBp }
    : d.kind === 'amount'
      ? { kind: 'amount', amountCents: d.amountCents }
      : { kind: 'none' };

/** "2 hours × $95 · $10 off · no tax". */
const lineWords = (l: LineIn) =>
  [
    lineRateLabel(l),
    l.discountCents > 0 ? `${money(l.discountCents)} off` : null,
    l.taxable ? null : 'no tax',
  ]
    .filter(Boolean)
    .join(' · ');

// ---------------------------------------------------------------------------
// Writing a draft: one shape for both documents
// ---------------------------------------------------------------------------

const CHANGES = [
  'title',
  'lines',
  'addLines',
  'removeLines',
  'discountPercent',
  'discountDollars',
  'note',
  'leadId',
] as const;
const ESTIMATE_CHANGES = [...CHANGES, 'depositPercent', 'depositDollars', 'goodUntil'] as const;
const INVOICE_CHANGES = [...CHANGES, 'dueOn', 'connectionId'] as const;

interface Draft {
  kind: 'estimate' | 'invoice';
  /** The draft being changed, or null for a new one. */
  before: { id: string; number: string | null; revision: number; totalCents: number } | null;
  person: Person;
  lines: LineIn[];
  discount: Terms;
  /** Estimates: the deposit shown on the card, and the one sent (left out keeps it, or takes the default). */
  deposit: Terms;
  depositSent: Terms | undefined;
  title: string | null;
  /** Left out on a new one, the business's own note goes on it. */
  notes: string | null | undefined;
  noteChanged: boolean;
  leadId: string | null;
  /** The good-until day of an estimate, or an invoice's due day. */
  day: string | null;
  /** Invoices: the account it is paid into, when one is named. */
  connectionId: string | undefined;
  account: string | null;
  totals: DocumentTotals;
  settings: MoneySettings;
}

async function draftOf(
  db: Db,
  ctx: ToolContext,
  kind: 'estimate' | 'invoice',
  args: Args,
): Promise<Draft> {
  const id = str(args[kind === 'estimate' ? 'estimateId' : 'invoiceId']);
  const dayKey = kind === 'estimate' ? 'goodUntil' : 'dueOn';
  const [{ settings }, products, accounts] = await Promise.all([
    settingsOf(db, ctx),
    catalogueFor(db, ctx, args),
    kind === 'invoice' ? connectionsOf(db, ctx) : Promise.resolve([] as Connection[]),
  ]);
  const deposit =
    kind === 'estimate' ? termsFrom(args['depositPercent'], args['depositDollars']) : undefined;
  const discount = termsFrom(args['discountPercent'], args['discountDollars']);

  let draft: Omit<Draft, 'totals' | 'account' | 'settings'>;
  if (!id) {
    if (!str(args['personId']))
      throw HfosError.validation(
        [{ path: 'personId', message: 'Who is it for?' }],
        'Say who it is for: a personId from search_customers.',
      );
    const lines = linesAfter(args, [], products, settings);
    if (!lines.length)
      throw HfosError.validation(
        [{ path: 'lines', message: 'Add a line.' }],
        `Give the ${kind} at least one line.`,
      );
    draft = {
      kind,
      before: null,
      person: await personOf(db, ctx, args['personId']),
      lines,
      discount: discount ?? { kind: 'none' },
      deposit: deposit ?? settings.deposit,
      depositSent: deposit,
      title: str(args['title']) ?? null,
      notes: str(args['note']),
      noteChanged: !!str(args['note']),
      leadId: (args['leadId'] as string | null | undefined) ?? null,
      day: (args[dayKey] as string | null | undefined) ?? null,
      connectionId: str(args['connectionId']),
    };
  } else {
    const keys = kind === 'estimate' ? ESTIMATE_CHANGES : INVOICE_CHANGES;
    if (!keys.some((k) => args[k] !== undefined)) throw nothingChanges();
    const doc =
      kind === 'estimate'
        ? (await estimateOf(db, ctx, id)).estimate
        : (await invoiceOf(db, ctx, id)).invoice;
    if (doc.status !== 'draft')
      throw HfosError.rule(
        'money_document_issued',
        409,
        `${doc.number ?? `That ${kind}`} has gone out, so it can’t be changed. Void it and write a new one.`,
      );
    if (str(args['personId']) && args['personId'] !== doc.person.id)
      throw HfosError.rule(
        'money_document_person',
        409,
        `An ${kind} stays with the customer it was written for. Write a new one instead.`,
      );
    const lines = linesAfter(args, doc.lines.map(lineIn), products, settings);
    if (!lines.length)
      throw HfosError.validation(
        [{ path: 'lines', message: 'Keep a line.' }],
        `An ${kind} needs at least one line.`,
      );
    const est = kind === 'estimate' ? (doc as Estimate) : null;
    draft = {
      kind,
      before: {
        id: doc.id,
        number: doc.number,
        revision: doc.revision,
        totalCents: doc.totals.totalCents,
      },
      person: doc.person,
      lines,
      discount: discount ?? discountNow(doc.totals),
      deposit: deposit ?? (est ? depositNow(est.deposit) : { kind: 'none' }),
      depositSent: deposit,
      title: args['title'] === undefined ? doc.title : (str(args['title']) ?? null),
      notes: str(args['note']) ?? doc.notes,
      noteChanged: !!str(args['note']),
      leadId:
        args['leadId'] === undefined ? doc.leadId : ((args['leadId'] as string | null) ?? null),
      day:
        args[dayKey] === undefined
          ? est
            ? est.expiresOn
            : (doc as Invoice).dueOn
          : ((args[dayKey] as string | null) ?? null),
      connectionId: str(args['connectionId']),
    };
  }

  const totals = computeTotals({
    lines: draft.lines,
    discount: draft.discount,
    deposit: kind === 'estimate' ? draft.deposit : undefined,
    taxRateBp: settings.tax.rateBp,
  });
  // The editor won't save a deposit bigger than the total, or one set to nothing; neither does this.
  const problem = kind === 'estimate' ? depositProblem(draft.deposit, totals.totalCents) : null;
  if (problem) throw HfosError.validation([{ path: 'deposit', message: problem }], problem);

  let account: string | null = null;
  if (kind === 'invoice') {
    const mine = usableAccounts(accounts);
    if (draft.connectionId) {
      const named = mine.find((c) => c.id === draft.connectionId);
      if (!named)
        throw HfosError.rule(
          'payment_account_not_yours',
          409,
          'That payment account isn’t one you can bill into right now. get_settings with area payments lists them.',
        );
      account = accountLabel(named);
    } else if (!draft.before) {
      // The command's own refusal, said before the card rather than after the press.
      if (!mine.length && accounts.some((c) => c.status === 'active'))
        throw HfosError.rule(
          'no_payment_account',
          409,
          'None of this business’s payment accounts is yours to bill into. Ask an owner to add you to one in Settings → Payments.',
        );
      account = mine[0] ? accountLabel(mine[0]) : null;
    }
  }
  return { ...draft, totals, account, settings };
}

/** "$1,284.50 · after $90 off · with $64.50 sales tax". */
function totalWords(d: Draft): string {
  const t = d.totals;
  return [
    money(t.totalCents),
    t.discountCents > 0
      ? `after ${money(t.discountCents)} off${d.discount.kind === 'percent' ? ` (${percentLabel(d.discount.percentBp ?? 0)})` : ''}`
      : null,
    t.taxCents > 0 ? `with ${money(t.taxCents)} ${d.settings.tax.name.toLowerCase()}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function depositWords(d: Draft): string {
  if (d.deposit.kind === 'none' || d.totals.depositCents <= 0) return 'None';
  return d.deposit.kind === 'percent'
    ? `${money(d.totals.depositCents)} up front (${percentLabel(d.deposit.percentBp ?? 0)})`
    : `${money(d.totals.depositCents)} up front`;
}

async function leadTitle(db: Db, ctx: ToolContext, leadId: string | null): Promise<string> {
  if (!leadId) return '';
  const got = await query<{ lead: { title: string } }>(db, ctx, 'lead.get', { leadId }).catch(
    () => null,
  );
  return got?.lead.title ?? '';
}

function writeTool(kind: 'estimate' | 'invoice'): SettingsConfirmTool {
  const tool = kind === 'estimate' ? 'write_estimate' : 'write_invoice';
  return {
    async prepare(db, ctx, args, toolCallId) {
      const d = await draftOf(db, ctx, kind, args);
      const who = d.person.fullName;
      const lead =
        args['leadId'] === undefined && d.before ? '' : await leadTitle(db, ctx, d.leadId);
      const dayLabel = kind === 'estimate' ? 'Good until' : 'Due';
      const fields: Field[] = [
        { label: 'Customer', value: who },
        { label: 'For', value: d.title ?? '' },
        ...d.lines.slice(0, 3).map((l) => ({ label: clip(l.name, 48), value: lineWords(l) })),
        ...(d.lines.length > 3
          ? [{ label: 'And', value: counted(d.lines.length - 3, 'more line') }]
          : []),
        { label: 'Total', value: totalWords(d) },
        ...(d.before && d.before.totalCents !== d.totals.totalCents
          ? [{ label: 'Was', value: money(d.before.totalCents) }]
          : []),
        ...(kind === 'estimate' ? [{ label: 'Deposit', value: depositWords(d) }] : []),
        { label: dayLabel, value: d.day ? dayWords(d.day, ctx.timezone) : '' },
        { label: 'Paid into', value: d.account ?? '' },
        { label: 'Lead', value: lead },
        { label: 'Note', value: d.noteChanged && d.notes ? clip(d.notes, 90) : '' },
      ];
      const draftName = d.before?.number ?? `the draft ${kind}`;
      return {
        card: billCard(toolCallId, tool, {
          title: d.before
            ? `Change ${draftName} for ${who}`
            : `Write ${kind === 'estimate' ? 'an estimate' : 'an invoice'} for ${who}`,
          personId: d.person.id,
          fields,
          confirmLabel: d.before ? 'Save the change' : 'Save the draft',
          warnings: [
            {
              kind: 'note',
              text: `It stays a draft. Nothing goes to ${firstName(who)} until you send it.`,
            },
          ],
        }),
        result: {
          waiting: true,
          customer: who,
          total: money(d.totals.totalCents),
          lines: d.lines.length,
          ...(kind === 'estimate' ? { deposit: depositWords(d) } : {}),
        },
      };
    },

    async commit(db, ctx, args) {
      const d = await draftOf(db, ctx, kind, args);
      const who = d.person.fullName;
      const header = {
        personId: d.person.id,
        leadId: d.leadId,
        title: d.title,
        lines: d.lines,
        discount: d.discount,
      };
      if (kind === 'estimate') {
        const out = d.before
          ? await command<{ estimateId: string }>(db, ctx, 'estimate.update', {
              ...header,
              estimateId: d.before.id,
              baseRevision: d.before.revision,
              notes: d.notes ?? null,
              expiresOn: d.day,
              ...(d.depositSent ? { deposit: d.depositSent } : {}),
            })
          : await command<{ estimateId: string }>(
              db,
              ctx,
              'estimate.create',
              defined({ ...header, notes: d.notes, deposit: d.depositSent, expiresOn: d.day }),
            );
        return {
          outcome: d.before
            ? `Saved the draft · ${money(d.totals.totalCents)}`
            : `Draft estimate for ${who} saved · ${money(d.totals.totalCents)}`,
          href: moneyPaths(ctx.workspaceId).estimate(out.estimateId),
          command: d.before ? 'estimate.update' : 'estimate.create',
        };
      }
      const out = d.before
        ? await command<{ invoiceId: string }>(db, ctx, 'invoice.update', {
            ...header,
            invoiceId: d.before.id,
            baseRevision: d.before.revision,
            notes: d.notes ?? null,
            dueOn: d.day,
            ...(d.connectionId ? { connectionId: d.connectionId } : {}),
          })
        : await command<{ invoiceId: string }>(
            db,
            ctx,
            'invoice.create',
            defined({
              ...header,
              notes: d.notes,
              dueOn: d.day,
              connectionId: d.connectionId,
              // Where it came from, for reporting and the timeline: the Assistant, on this person's say-so.
              origin: 'assistant',
            }),
          );
      return {
        outcome: d.before
          ? `Saved the draft · ${money(d.totals.totalCents)}`
          : `Draft invoice for ${who} saved · ${money(d.totals.totalCents)}`,
        href: moneyPaths(ctx.workspaceId).invoice(out.invoiceId),
        command: d.before ? 'invoice.update' : 'invoice.create',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Voiding, a yes by phone, and an estimate into an invoice
// ---------------------------------------------------------------------------

const estimateName = (e: { number: string | null }) => e.number ?? 'the draft estimate';
const invoiceName = (i: { number: string | null }) => i.number ?? 'the draft invoice';

const manageEstimate: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = String(args['action']);
    const { estimate: e } = await estimateOf(db, ctx, args['estimateId']);
    const who = e.person.fullName;
    const first = firstName(who);
    const base = [
      { label: 'Estimate', value: e.number ?? 'Draft' },
      { label: 'Customer', value: who },
      { label: 'Total', value: money(e.totals.totalCents) },
    ];
    if (act === 'void') {
      if (e.status === 'void')
        throw HfosError.rule('estimate_not_open', 409, 'That estimate is already void.');
      return {
        card: billCard(toolCallId, 'manage_estimate', {
          title: `Void ${estimateName(e)}?`,
          personId: e.person.id,
          fields: [
            ...base,
            {
              label: 'Now',
              value: ESTIMATE_WORDS[e.state as keyof typeof ESTIMATE_WORDS] ?? e.state,
            },
            { label: 'Why', value: str(args['reason']) ?? '' },
          ],
          confirmLabel: 'Void it',
          warnings: [
            {
              kind: 'caution',
              text: e.number
                ? 'It can’t be undone. Its number is kept and never used again; to quote again, write a new estimate.'
                : 'It can’t be undone; to quote again, write a new estimate.',
            },
            ...(e.sentAt
              ? [
                  {
                    kind: 'note',
                    text: `${first}’s link will say it was withdrawn, and it can’t be approved any more.`,
                  },
                ]
              : []),
          ],
        }),
        result: { waiting: true, estimate: estimateName(e), customer: who },
      };
    }
    if (act === 'record_yes') {
      if (e.status === 'accepted')
        throw HfosError.rule('estimate_not_open', 409, 'That estimate was already approved.');
      if (e.status !== 'sent')
        throw HfosError.rule(
          'estimate_not_open',
          409,
          e.status === 'draft'
            ? 'That estimate hasn’t been sent yet. Send it first (send_estimate), then record their yes.'
            : (estimateMoveProblem(e.status as EstimateStatus, 'accepted') ??
                'That estimate can’t be approved.'),
        );
      const name = str(args['name']) ?? who;
      return {
        card: billCard(toolCallId, 'manage_estimate', {
          title: `Mark ${estimateName(e)} approved?`,
          personId: e.person.id,
          fields: [
            ...base,
            { label: 'Who said yes', value: name },
            { label: 'Note', value: str(args['note']) ?? '' },
          ],
          confirmLabel: 'Mark approved',
          warnings: [
            {
              kind: 'note',
              text: 'Recorded in your name, with the moment, as a yes taken by phone or in person — never as their own approval.',
            },
            ...(e.depositCents > 0
              ? [
                  {
                    kind: 'note',
                    text: `It asks for ${money(e.depositCents)} up front. Turn it into an invoice to collect it.`,
                  },
                ]
              : []),
          ],
        }),
        result: { waiting: true, estimate: estimateName(e), name },
      };
    }
    // make_invoice
    if (e.status !== 'accepted' && e.status !== 'sent')
      throw HfosError.rule(
        'estimate_not_answered',
        409,
        e.status === 'draft'
          ? 'Send the estimate before invoicing it.'
          : `${estimateMoveProblem(e.status as EstimateStatus, 'accepted')?.replace('approved', 'invoiced') ?? 'That estimate can’t be invoiced.'} Write a new one instead.`,
      );
    const depositOnly = args['bill'] === 'deposit_only';
    if (depositOnly && e.depositCents <= 0)
      throw HfosError.rule(
        'estimate_no_deposit',
        409,
        'This estimate doesn’t ask for a deposit. Invoice the whole job instead.',
      );
    const due = str(args['dueOn']);
    return {
      card: billCard(toolCallId, 'manage_estimate', {
        title: `Turn ${estimateName(e)} into an invoice`,
        personId: e.person.id,
        fields: [
          ...base,
          {
            label: 'It bills',
            value: depositOnly
              ? `Only the ${money(e.depositCents)} deposit`
              : e.depositCents > 0
                ? `The whole job · the ${money(e.depositCents)} deposit is asked for first`
                : `The whole job · ${counted(e.lines.length, 'line')}`,
          },
          {
            label: 'Due',
            value: due ? dayWords(due, ctx.timezone) : 'From your terms, when it’s sent',
          },
        ],
        confirmLabel: 'Make the invoice',
        warnings: [
          {
            kind: 'note',
            text: `It’s a draft invoice. Nothing goes to ${first} until you send it.`,
          },
          ...(e.status === 'sent'
            ? [{ kind: 'note', text: `${first} hasn’t said yes to this estimate yet.` }]
            : []),
        ],
      }),
      result: {
        waiting: true,
        estimate: estimateName(e),
        bills: depositOnly ? money(e.depositCents) : money(e.totals.totalCents),
      },
    };
  },

  async commit(db, ctx, args) {
    const act = String(args['action']);
    const estimateId = args['estimateId'];
    const paths = moneyPaths(ctx.workspaceId);
    if (act === 'void') {
      await command(db, ctx, 'estimate.void', {
        estimateId,
        reason: str(args['reason']) ?? null,
      });
      return {
        outcome: 'Voided',
        href: paths.estimate(String(estimateId)),
        command: 'estimate.void',
      };
    }
    if (act === 'record_yes') {
      const { estimate: e } = await estimateOf(db, ctx, estimateId);
      await command(db, ctx, 'estimate.mark_accepted', {
        estimateId,
        name: str(args['name']) ?? e.person.fullName,
        note: str(args['note']) ?? null,
      });
      return {
        outcome: 'Marked approved',
        href: paths.estimate(String(estimateId)),
        command: 'estimate.mark_accepted',
      };
    }
    const out = await command<{ invoiceId: string; totalCents: number }>(
      db,
      ctx,
      'estimate.convert',
      defined({
        estimateId,
        purpose: args['bill'] === 'deposit_only' ? 'deposit' : 'standard',
        dueOn: str(args['dueOn']),
      }),
    );
    return {
      outcome: `Draft invoice made · ${money(out.totalCents)} — send it when you’re ready`,
      href: paths.invoice(out.invoiceId),
      command: 'estimate.convert',
    };
  },
};

/** The channels a customer can actually be reached on, of the ones asked for. */
function reachable(person: Person, asked: readonly string[]) {
  const can = asked.filter((c) => (c === 'sms' ? !!person.phone : !!person.email));
  const missing = asked.filter((c) => !can.includes(c));
  const how = (c: string) =>
    c === 'sms' ? `Text · ${person.phone ?? ''}` : `Email · ${person.email ?? ''}`;
  return { can, missing, words: can.map(how).join(' and ') };
}

const noContact = (who: string, channel: string) =>
  channel === 'sms'
    ? `No mobile number on file for ${who}, so no text goes.`
    : `No email address on file for ${who}, so no email goes.`;

const manageInvoice: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = String(args['action']);
    const { invoice: i, payments, refunds } = await invoiceOf(db, ctx, args['invoiceId']);
    const who = i.person.fullName;
    const first = firstName(who);
    if (act === 'send') {
      if (i.status !== 'draft')
        throw HfosError.rule(
          'invoice_not_open',
          409,
          `${invoiceName(i)} has already gone out. Void it and write a new one to send it again.`,
        );
      if (!i.lines.length)
        throw HfosError.rule('money_document_empty', 409, 'Add a line before sending it.');
      const asked = list<string>(args['channels']) ?? ['email'];
      const to = reachable(i.person, asked);
      const [{ settings, nextInvoiceNumber }, accounts] = await Promise.all([
        settingsOf(db, ctx),
        connectionsOf(db, ctx),
      ]);
      const due = i.dueOn ?? dueDateFor(settings.terms, todayIn(ctx.timezone));
      const blocked = to.can.length === 0;
      const account = accounts.find((c) => c.id === i.connectionId && c.status === 'active');
      return {
        card: billCard(toolCallId, 'manage_invoice', {
          title: `Send an invoice to ${who}`,
          personId: i.person.id,
          fields: [
            { label: 'To', value: who },
            { label: 'How', value: to.words },
            { label: 'Total', value: money(i.totals.totalCents) },
            { label: 'For', value: i.title ?? '' },
            {
              label: 'Due',
              value: `${dayWords(due, ctx.timezone)}${i.dueOn ? '' : ` · ${TERMS_WORDS[settings.terms]}`}`,
            },
            { label: 'Number', value: nextInvoiceNumber },
            { label: 'Paid into', value: account ? accountLabel(account) : '' },
          ],
          body: str(args['message']) ?? null,
          confirmLabel: blocked ? '' : 'Send it',
          warnings: blocked
            ? [
                {
                  kind: 'blocked',
                  text: `${who} has no ${asked.includes('sms') && !asked.includes('email') ? 'mobile number' : asked.length > 1 ? 'email or mobile' : 'email address'} on file. Add one on their customer page first.`,
                },
              ]
            : [
                {
                  kind: 'caution',
                  text: `It goes to ${first} now and is frozen: a mistake afterwards means voiding it and writing a new one.`,
                },
                ...to.missing.map((c) => ({ kind: 'note', text: noContact(first, c) })),
                ...(account
                  ? []
                  : [
                      {
                        kind: 'note',
                        text: 'It has no payment account, so it can’t be paid online. Cash and cheques can still be recorded.',
                      },
                    ]),
              ],
        }),
        result: blocked
          ? { blocked: true, why: `No way to reach ${who} by ${asked.join(' or ')}.` }
          : {
              waiting: true,
              invoice: invoiceName(i),
              customer: who,
              total: money(i.totals.totalCents),
              channels: to.can,
            },
      };
    }
    // void
    if (i.status === 'void')
      throw HfosError.rule('invoice_not_open', 409, 'That invoice is already void.');
    const block = invoiceVoidBlock({
      paidCents: i.amountPaidCents,
      refundedCents: i.amountRefundedCents,
      hasProcessingPayment: payments.some((p) => p.status === 'processing'),
      hasPendingRefund: refunds.some((r) => r.status === 'pending'),
    });
    if (block === 'money_moving')
      throw HfosError.rule(
        'invoice_money_moving',
        409,
        payments.some((p) => p.status === 'processing')
          ? 'A payment on this invoice is still on its way. Once it lands, refund it, then void the invoice.'
          : 'A refund on this invoice is still on its way back. Void it once the refund has gone through.',
      );
    if (block === 'money_held')
      throw HfosError.rule(
        'invoice_has_payments',
        409,
        `${money(i.amountPaidCents - i.amountRefundedCents)} paid on this invoice hasn’t been given back. Refund it first (refund_payment), then void it.`,
      );
    return {
      card: billCard(toolCallId, 'manage_invoice', {
        title: `Void ${invoiceName(i)}?`,
        personId: i.person.id,
        fields: [
          { label: 'Invoice', value: i.number ?? 'Draft' },
          { label: 'Customer', value: who },
          { label: 'Total', value: money(i.totals.totalCents) },
          { label: 'Now', value: INVOICE_WORDS[i.state as keyof typeof INVOICE_WORDS] ?? i.state },
          { label: 'Why', value: str(args['reason']) ?? '' },
        ],
        confirmLabel: 'Void it',
        warnings: [
          {
            kind: 'caution',
            text: i.number
              ? 'It can’t be undone. Its number is kept and never used again; to bill again, write a new invoice.'
              : 'It can’t be undone; to bill again, write a new invoice.',
          },
          ...(i.sentAt
            ? [
                {
                  kind: 'note',
                  text: `${first}’s link will say it was withdrawn, and its reminders stop.`,
                },
              ]
            : []),
        ],
      }),
      result: { waiting: true, invoice: invoiceName(i), customer: who },
    };
  },

  async commit(db, ctx, args) {
    const invoiceId = String(args['invoiceId']);
    const href = moneyPaths(ctx.workspaceId).invoice(invoiceId);
    if (args['action'] === 'send') {
      // Only the ways they can be reached, as the send dialog offers them.
      const { invoice } = await invoiceOf(db, ctx, invoiceId);
      const to = reachable(invoice.person, list<string>(args['channels']) ?? ['email']);
      if (!to.can.length)
        throw HfosError.rule(
          'no_contact',
          409,
          `There is no way to reach ${invoice.person.fullName}.`,
        );
      const out = await command<{ number: string | null }>(db, ctx, 'invoice.send', {
        invoiceId,
        channels: to.can,
        message: str(args['message']) ?? null,
      });
      return {
        outcome: `Sent ${out.number ?? 'the invoice'} to ${invoice.person.fullName}`,
        href,
        command: 'invoice.send',
      };
    }
    await command(db, ctx, 'invoice.void', { invoiceId, reason: str(args['reason']) ?? null });
    return { outcome: 'Voided', href, command: 'invoice.void' };
  },
};

// ---------------------------------------------------------------------------
// Refunds: money leaving the business
// ---------------------------------------------------------------------------

interface RefundPlan {
  invoice: Invoice;
  payment: Payment;
  amountCents: number;
  leftCents: number;
}

/** Which payment, how much of it, and whether it can go back at all — the command's own refusals, first. */
async function refundOf(db: Db, ctx: ToolContext, args: Args): Promise<RefundPlan> {
  const { invoice, payments, refunds } = await invoiceOf(db, ctx, args['invoiceId']);
  // What is on its way back already counts: the command counts pending refunds too.
  const pending = (p: Payment) =>
    refunds
      .filter((r) => r.paymentId === p.id && r.status === 'pending')
      .reduce((sum, r) => sum + r.amountCents, 0);
  const left = (p: Payment) => Math.max(0, p.amountCents - p.refundedCents - pending(p));
  let payment: Payment | undefined;
  if (str(args['paymentId'])) {
    payment = payments.find((p) => p.id === args['paymentId']);
    if (!payment)
      throw HfosError.notFound(
        'That payment isn’t on this invoice. get_money_document lists its payments.',
      );
  } else {
    const open = payments.filter((p) => p.status === 'succeeded' && left(p) > 0);
    if (open.length > 1)
      throw HfosError.validation(
        [{ path: 'paymentId', message: 'Which payment?' }],
        `This invoice has ${open.length} payments that can be refunded (${open
          .map((p) => `${money(p.amountCents)} by ${paymentWords(p)}, id ${p.id}`)
          .join('; ')}). Say which one.`,
      );
    payment = open[0] ?? payments.find((p) => p.status === 'processing');
    if (!payment)
      throw HfosError.rule(
        'refund_over_balance',
        409,
        payments.some((p) => p.status === 'succeeded')
          ? 'Everything paid on this invoice has already been refunded.'
          : 'Nothing has been paid on this invoice, so there’s nothing to give back.',
      );
  }
  if (payment.status !== 'succeeded')
    throw HfosError.rule(
      'payment_not_settled',
      409,
      payment.status === 'processing'
        ? 'That payment is still on its way. Wait until it lands, then refund it.'
        : 'That payment never landed, so there’s nothing to give back.',
    );
  const leftCents = left(payment);
  if (leftCents <= 0)
    throw HfosError.rule(
      'refund_over_balance',
      409,
      'That payment has already been refunded in full.',
    );
  const amountCents = args['amount'] === undefined ? leftCents : cents(Number(args['amount']));
  if (amountCents < 1)
    throw HfosError.validation(
      [{ path: 'amount', message: 'How much?' }],
      'Refund at least a cent.',
    );
  if (amountCents > leftCents)
    throw HfosError.rule(
      'refund_over_balance',
      409,
      `Only ${money(leftCents)} of that payment can still be refunded.`,
    );
  return { invoice, payment, amountCents, leftCents };
}

/** Cash, a cheque or money taken another way was handed back in person: there is no provider to call. */
const handedBack = (p: Payment) =>
  !p.provider || isManualPaymentMethod(p.method as Parameters<typeof isManualPaymentMethod>[0]);

const refundPayment: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { invoice, payment, amountCents, leftCents } = await refundOf(db, ctx, args);
    const who = invoice.person.fullName;
    const first = firstName(who);
    const by = paymentWords(payment);
    const when = payment.receivedAt ?? payment.createdAt;
    const manual = handedBack(payment);
    return {
      card: billCard(toolCallId, 'refund_payment', {
        title: `Refund ${money(amountCents)} to ${who}?`,
        personId: invoice.person.id,
        fields: [
          { label: 'Customer', value: who },
          { label: 'Invoice', value: invoice.number ?? invoice.title ?? 'Invoice' },
          {
            label: 'Payment',
            value: `${money(payment.amountCents)} by ${by} · ${dayWords(when.slice(0, 10), ctx.timezone)}`,
          },
          { label: 'Refund', value: money(amountCents) },
          {
            label: 'Still refundable after',
            value: leftCents - amountCents > 0 ? money(leftCents - amountCents) : '',
          },
          { label: 'Why', value: str(args['reason']) ?? '' },
        ],
        confirmLabel: `Refund ${money(amountCents)}`,
        warnings: [
          {
            kind: 'caution',
            text: manual
              ? `Money leaves the business: this records that you gave ${first} ${money(amountCents)} back by ${by}. It can’t be undone.`
              : `Money leaves the business: ${money(amountCents)} goes back to ${first}’s ${by} through ${providerName(payment.provider)}. It can’t be undone once it’s sent.`,
          },
          {
            kind: 'note',
            text: 'The invoice stays paid — a refund never puts it back on the bill. To bill again, write a new invoice.',
          },
        ],
      }),
      result: {
        waiting: true,
        customer: who,
        refund: money(amountCents),
        of: money(payment.amountCents),
        by,
      },
    };
  },

  async commit(db, ctx, args, extra) {
    const { invoice, payment, amountCents } = await refundOf(db, ctx, args);
    const out = await command<{ amountCents: number; manual: boolean }>(db, ctx, 'payment.refund', {
      paymentId: payment.id,
      amountCents,
      reason: str(args['reason']) ?? null,
      // One card, one refund: a second press of the same Confirm can't give the money back twice.
      idempotencyKey: `assistant-refund-${extra.toolCallId}`,
    });
    return {
      outcome: out.manual
        ? `${money(out.amountCents)} refunded to ${invoice.person.fullName}`
        : `${money(out.amountCents)} is on its way back to ${invoice.person.fullName}`,
      href: moneyPaths(ctx.workspaceId).invoice(invoice.id),
      command: 'payment.refund',
    };
  },
};

// ---------------------------------------------------------------------------
// The plans a business sells
// ---------------------------------------------------------------------------

const everyMonths = (n: number) => (n === 1 ? 'every month' : `every ${n} months`);

async function serviceNames(db: Db, ctx: ToolContext): Promise<Map<string, string>> {
  const got = await query<{ items: { id: string; name: string }[] }>(db, ctx, 'service.list').catch(
    () => null,
  );
  return new Map((got?.items ?? []).map((s) => [s.id, s.name]));
}

const visitsWords = (
  p: { serviceId: string | null; visitEveryMonths: number | null },
  services: Map<string, string>,
) =>
  p.serviceId && p.visitEveryMonths
    ? `${services.get(p.serviceId) ?? 'A service'} ${everyMonths(p.visitEveryMonths)}`
    : 'None';

/** What a plan becomes: only what was asked for changes; the service and how often go together. */
function planPatch(args: Args, now: Plan | null): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (str(args['name'])) patch['name'] = str(args['name']);
  if (str(args['description'])) patch['description'] = str(args['description']);
  if (num(args['priceDollars']) !== undefined)
    patch['priceCents'] = cents(num(args['priceDollars'])!);
  if (str(args['interval'])) patch['interval'] = str(args['interval']);
  if (num(args['intervalCount']) !== undefined) patch['intervalCount'] = num(args['intervalCount']);
  if (list(args['includes'])) patch['includes'] = list<string>(args['includes']);
  if (bool(args['taxable']) !== undefined) patch['taxable'] = bool(args['taxable']);
  const svc = args['serviceId'];
  const every = args['visitEveryMonths'];
  if (svc !== undefined || every !== undefined) {
    if (svc === null || every === null) {
      patch['serviceId'] = null;
      patch['visitEveryMonths'] = null;
    } else {
      const serviceId = (svc as string | undefined) ?? now?.serviceId ?? null;
      const months = (every as number | undefined) ?? now?.visitEveryMonths ?? null;
      if (!serviceId || !months)
        throw HfosError.validation(
          [{ path: serviceId ? 'visitEveryMonths' : 'serviceId', message: 'Both, or neither.' }],
          serviceId
            ? 'Say how often members are due the service, in months.'
            : 'Say which service members are due (get_settings with area services).',
        );
      patch['serviceId'] = serviceId;
      patch['visitEveryMonths'] = months;
    }
  }
  return patch;
}

async function planOf(db: Db, ctx: ToolContext, planId: unknown): Promise<Plan> {
  const { plans } = await query<{ plans: Plan[] }>(db, ctx, 'plan.list', { includeArchived: true });
  const plan = plans.find((p) => p.id === planId);
  if (!plan)
    throw HfosError.notFound('That plan isn’t there. list_plans shows the ones there are.');
  return plan;
}

/** Customers still on a plan (anything not ended), for what stopping it would leave. */
async function customersOn(db: Db, ctx: ToolContext, planId: string): Promise<number | null> {
  const got = await ifAllowed(
    query<{ subscriptions: Subscription[] }>(db, ctx, 'subscription.list', {
      planId,
      status: ['draft', 'active', 'past_due', 'paused', 'unmanaged'],
      limit: 100,
    }),
  );
  return got ? got.subscriptions.length : null;
}

const managePlan: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = String(args['action']);
    const services = await serviceNames(db, ctx);
    if (act === 'create') {
      const name = str(args['name']);
      if (!name || num(args['priceDollars']) === undefined)
        throw HfosError.validation(
          [{ path: name ? 'priceDollars' : 'name', message: 'Needed for a new plan.' }],
          'A new plan needs a name and a price.',
        );
      const p = planPatch(args, null);
      const price = planPriceLabel(
        Number(p['priceCents']),
        (p['interval'] as string | undefined) ?? 'month',
        (p['intervalCount'] as number | undefined) ?? 1,
      );
      const includes = (p['includes'] as string[] | undefined) ?? [];
      return {
        card: billCard(toolCallId, 'manage_plan', {
          title: `Add the ${name} plan`,
          fields: [
            { label: 'Plan', value: name },
            { label: 'Price', value: price },
            { label: 'Includes', value: includes.join('; ') },
            {
              label: 'Taxed',
              value:
                bool(args['taxable']) === undefined
                  ? 'As new items are'
                  : args['taxable']
                    ? 'Yes'
                    : 'No',
            },
            {
              label: 'Visits',
              value: p['serviceId']
                ? visitsWords(
                    {
                      serviceId: p['serviceId'] as string,
                      visitEveryMonths: p['visitEveryMonths'] as number,
                    },
                    services,
                  )
                : '',
            },
            { label: 'About it', value: str(args['description']) ?? '' },
          ],
          confirmLabel: 'Add the plan',
          warnings: [
            {
              kind: 'note',
              text: 'It’s ready to sell. Nobody is on it until you start them on it.',
            },
          ],
        }),
        result: { waiting: true, plan: name, price },
      };
    }
    if (!str(args['planId']))
      throw HfosError.validation(
        [{ path: 'planId', message: 'Which plan?' }],
        'Say which plan: a planId from list_plans.',
      );
    const plan = await planOf(db, ctx, args['planId']);
    const price = planPriceLabel(plan.priceCents, plan.interval, plan.intervalCount);
    if (act === 'stop_selling' || act === 'sell_again') {
      const stopping = act === 'stop_selling';
      if (stopping === !!plan.archivedAt)
        throw HfosError.validation(
          [],
          stopping ? `${plan.name} is already off sale.` : `${plan.name} is already on sale.`,
        );
      const onIt = await customersOn(db, ctx, plan.id);
      return {
        card: billCard(toolCallId, 'manage_plan', {
          title: stopping ? `Stop selling ${plan.name}?` : `Sell ${plan.name} again`,
          fields: [
            { label: 'Plan', value: plan.name },
            { label: 'Price', value: price },
            { label: 'On it now', value: onIt === null ? '' : counted(onIt, 'customer') },
          ],
          confirmLabel: stopping ? 'Stop selling it' : 'Sell it again',
          warnings: stopping
            ? [
                {
                  kind: 'note',
                  text: 'Anyone already on it stays on it and keeps billing. You can sell it again later.',
                },
              ]
            : [],
        }),
        result: { waiting: true, plan: plan.name, customersOnIt: onIt },
      };
    }
    // change
    const p = planPatch(args, plan);
    const fields: Field[] = [{ label: 'Plan', value: plan.name }];
    if (p['name'] !== undefined && p['name'] !== plan.name)
      fields.push({ label: 'Called', value: String(p['name']) });
    const nextPrice = planPriceLabel(
      (p['priceCents'] as number | undefined) ?? plan.priceCents,
      (p['interval'] as string | undefined) ?? plan.interval,
      (p['intervalCount'] as number | undefined) ?? plan.intervalCount,
    );
    if (nextPrice !== price) fields.push({ label: 'Price', value: `${nextPrice} · was ${price}` });
    if (p['includes'])
      fields.push({
        label: 'Includes',
        value: (p['includes'] as string[]).join('; ') || 'Nothing listed',
      });
    if (p['taxable'] !== undefined && p['taxable'] !== plan.taxable)
      fields.push({ label: 'Taxed', value: p['taxable'] ? 'Yes' : 'No' });
    if (
      'serviceId' in p &&
      (p['serviceId'] !== plan.serviceId || p['visitEveryMonths'] !== plan.visitEveryMonths)
    )
      fields.push({
        label: 'Visits',
        value: visitsWords(
          {
            serviceId: p['serviceId'] as string | null,
            visitEveryMonths: p['visitEveryMonths'] as number | null,
          },
          services,
        ),
      });
    if (p['description'] !== undefined && p['description'] !== plan.description)
      fields.push({ label: 'About it', value: String(p['description']) });
    if (fields.length === 1) throw nothingChanges();
    return {
      card: billCard(toolCallId, 'manage_plan', {
        title: `Change ${plan.name}`,
        fields,
        confirmLabel: 'Save the change',
        warnings: [
          {
            kind: 'note',
            text: 'Customers already on it keep the price and what they signed up for; the change is for new ones.',
          },
        ],
      }),
      result: { waiting: true, plan: plan.name, changes: fields.slice(1).map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    const act = String(args['action']);
    const href = moneyPaths(ctx.workspaceId).plans();
    if (act === 'create') {
      await command(db, ctx, 'plan.create', planPatch(args, null));
      return { outcome: `${str(args['name'])} is on sale`, href, command: 'plan.create' };
    }
    const plan = await planOf(db, ctx, args['planId']);
    if (act === 'stop_selling' || act === 'sell_again') {
      await command(db, ctx, 'plan.archive', {
        planId: plan.id,
        archived: act === 'stop_selling',
      });
      return {
        outcome:
          act === 'stop_selling' ? `${plan.name} is off sale` : `${plan.name} is on sale again`,
        href,
        command: 'plan.archive',
      };
    }
    await command(db, ctx, 'plan.update', { planId: plan.id, ...planPatch(args, plan) });
    return { outcome: 'Saved', href, command: 'plan.update' };
  },
};

// ---------------------------------------------------------------------------
// A customer on a plan
// ---------------------------------------------------------------------------

const PLAN_STATUS: Readonly<Record<string, string>> = {
  draft: 'Waiting on a card',
  active: 'Billing',
  past_due: 'Card refused, retrying',
  paused: 'Paused',
  cancelled: 'Ended',
  unmanaged: 'Billing at the provider, not managed here',
};
const planStatus = (s: Subscription) =>
  s.status === 'draft' && s.hasCard ? 'Being set up' : (PLAN_STATUS[s.status] ?? s.status);

/** The link-to-a-card channels: the ones asked for, else email when they have one, else a text. */
function cardChannels(person: Person, args: Args) {
  const asked =
    list<string>(args['sendBy']) ?? (person.email ? ['email'] : person.phone ? ['sms'] : ['email']);
  return reachable(person, asked);
}

interface StartPlan {
  person: Person;
  plan: Plan;
  account: Connection | null;
  /** Why it can't start, as the screen says it, or null. */
  blocked: string | null;
}

async function startOf(db: Db, ctx: ToolContext, args: Args): Promise<StartPlan> {
  if (!str(args['personId']) || !str(args['planId']))
    throw HfosError.validation(
      [{ path: str(args['personId']) ? 'planId' : 'personId', message: 'Needed to start one.' }],
      'Say who and which plan: a personId from search_customers and a planId from list_plans.',
    );
  const [person, plan, accounts] = await Promise.all([
    personOf(db, ctx, args['personId']),
    planOf(db, ctx, args['planId']),
    connectionsOf(db, ctx),
  ]);
  if (plan.archivedAt)
    throw HfosError.rule(
      'plan_archived',
      409,
      `${plan.name} isn’t on sale any more. Sell it again first (manage_plan), or pick another.`,
    );
  const mine = usableAccounts(accounts);
  const named = str(args['connectionId']);
  if (named && !mine.some((c) => c.id === named))
    throw HfosError.rule(
      'payment_account_not_yours',
      409,
      'That payment account isn’t one you can bill into right now. get_settings with area payments lists them.',
    );
  const account = (named ? mine.find((c) => c.id === named) : mine[0]) ?? null;
  // The screen's own rule: Start the plan stays greyed out until there is an account to bill through.
  const blocked = account
    ? null
    : accounts.some((c) => c.status === 'active')
      ? 'None of the payment accounts is yours to bill into. An owner can add you to one in Settings → Payments.'
      : 'A plan needs somewhere to bill. Connect Stripe or Square in Settings → Payments first — only you can.';
  return { person, plan, account, blocked };
}

const subscriptionOf = async (db: Db, ctx: ToolContext, subscriptionId: unknown) => {
  if (!str(subscriptionId))
    throw HfosError.validation(
      [{ path: 'subscriptionId', message: 'Which plan?' }],
      'Say which customer plan: a subscriptionId from list_plans or customer_money.',
    );
  return (
    await query<{ subscription: Subscription }>(db, ctx, 'subscription.get', { subscriptionId })
  ).subscription;
};

/** A plan whose account went away is still billing at the provider, and nothing here can drive it. */
function assertManaged(s: Subscription, what: string) {
  if (s.status === 'unmanaged')
    throw HfosError.rule(
      'subscription_unmanaged',
      409,
      `This plan is still billing at ${providerName(s.provider)}, but the account it bills through is disconnected. Reconnect it to ${what} it here, or ${what} it at ${providerName(s.provider)}.`,
    );
}

const manageCustomerPlan: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = String(args['action']);
    if (act === 'start') {
      const { person, plan, account, blocked } = await startOf(db, ctx, args);
      const first = firstName(person.fullName);
      const send = args['sendBy'] === undefined ? null : cardChannels(person, args);
      const square = account?.provider === 'square';
      return {
        card: billCard(toolCallId, 'manage_customer_plan', {
          title: `Put ${person.fullName} on ${plan.name}`,
          personId: person.id,
          fields: [
            { label: 'Customer', value: person.fullName },
            { label: 'Plan', value: plan.name },
            {
              label: 'Price',
              value: planPriceLabel(plan.priceCents, plan.interval, plan.intervalCount),
            },
            { label: 'Includes', value: plan.includes.join('; ') },
            { label: 'Bills through', value: account ? accountLabel(account) : '' },
            {
              label: 'Card link',
              value: send
                ? send.words || 'Nowhere to send it'
                : 'Not sent yet — ask for their card when you’re ready',
            },
          ],
          body: send ? (str(args['message']) ?? null) : null,
          confirmLabel: blocked ? '' : 'Start the plan',
          warnings: blocked
            ? [{ kind: 'blocked', text: blocked }]
            : [
                {
                  kind: 'note',
                  text: `Nothing is billed until ${first} puts a card on it on their own page. It keeps what it costs today, whatever the plan costs later.`,
                },
                ...(send?.can.length
                  ? [
                      {
                        kind: 'caution',
                        text: `${send.words.startsWith('Text') ? 'Texts' : 'Emails'} ${first} the link to add a card as soon as it starts.`,
                      },
                    ]
                  : send
                    ? send.missing.map((c) => ({ kind: 'note', text: noContact(first, c) }))
                    : []),
                ...(square
                  ? [
                      {
                        kind: 'note',
                        text: 'Square plans are card-only, and Square cancels at the end of a period, never straight away.',
                      },
                    ]
                  : []),
              ],
        }),
        result: blocked
          ? { blocked: true, why: blocked }
          : {
              waiting: true,
              customer: person.fullName,
              plan: plan.name,
              price: planPriceLabel(plan.priceCents, plan.interval, plan.intervalCount),
              cardLinkSent: !!send?.can.length,
            },
      };
    }

    const s = await subscriptionOf(db, ctx, args['subscriptionId']);
    const who = s.person.fullName;
    const first = firstName(who);
    const price = planPriceLabel(s.priceCents, s.interval, s.intervalCount);
    const base: Field[] = [
      { label: 'Customer', value: who },
      { label: 'Plan', value: s.planName },
      { label: 'Price', value: price },
      { label: 'Now', value: planStatus(s) },
    ];
    const card = (
      title: string,
      confirmLabel: string,
      warnings: Warning[],
      extra: Field[] = [],
      body: string | null = null,
    ) => ({
      card: billCard(toolCallId, 'manage_customer_plan', {
        title,
        personId: s.person.id,
        fields: [...base, ...extra],
        body,
        confirmLabel,
        warnings,
      }),
      result: { waiting: true, customer: who, plan: s.planName, action: act },
    });

    if (act === 'pause') {
      if (s.status === 'paused')
        throw HfosError.rule('subscription_not_active', 409, 'That plan is already paused.');
      assertManaged(s, 'pause');
      if (s.status !== 'active' && s.status !== 'past_due')
        throw HfosError.rule(
          'subscription_not_active',
          409,
          'Only a plan that is billing can be paused.',
        );
      return card(`Pause ${first}’s ${s.planName}?`, 'Pause it', [
        {
          kind: 'note',
          text: `Nothing is charged until you start it again. ${first} stays on the plan and keeps the visits they’re owed.`,
        },
      ]);
    }
    if (act === 'resume') {
      if (s.status === 'active')
        throw HfosError.rule('subscription_not_paused', 409, 'That plan is already billing.');
      assertManaged(s, 'resume');
      if (s.status !== 'paused')
        throw HfosError.rule(
          'subscription_not_paused',
          409,
          'Only a paused plan can be started again.',
        );
      return card(`Start ${first}’s ${s.planName} again?`, 'Start it again', [
        {
          kind: 'caution',
          text: `${first}’s card is charged ${price} again from the next cycle.`,
        },
      ]);
    }
    if (act === 'cancel') {
      if (s.status === 'cancelled')
        throw HfosError.rule('subscription_cancelled', 409, 'That plan has already ended.');
      const warnings: Warning[] =
        s.status === 'unmanaged'
          ? [
              {
                kind: 'caution',
                text: `It bills through a disconnected account, so cancelling here only closes the record. Cancel it at ${providerName(s.provider)} as well, or the charges carry on.`,
              },
            ]
          : s.provider === 'square'
            ? [
                {
                  kind: 'caution',
                  text: `Square can’t cancel straight away: ${first} is billed once more for the period they’re in, and then it stops. It can’t be restarted.`,
                },
              ]
            : [
                {
                  kind: 'caution',
                  text: `${first} won’t be billed again, and it can’t be restarted — a new plan would have to be started.`,
                },
              ];
      warnings.push({
        kind: 'note',
        text: `What has been billed stays on the ledger, and ${first} keeps the visits they’ve already paid for.`,
      });
      return card(`Cancel ${first}’s ${s.planName}?`, 'Cancel the plan', warnings, [
        { label: 'Why', value: str(args['reason']) ?? '' },
      ]);
    }
    // ask_for_card
    if (s.status === 'cancelled')
      throw HfosError.rule(
        'subscription_cancelled',
        409,
        'That plan has ended. Start a new one instead.',
      );
    const to = cardChannels(s.person, args);
    const blocked = to.can.length === 0;
    return {
      card: billCard(toolCallId, 'manage_customer_plan', {
        title: s.hasCard
          ? `Ask ${first} for a new card`
          : `Ask ${first} to put a card on ${s.planName}`,
        personId: s.person.id,
        fields: [...base, { label: 'How', value: to.words }],
        body: str(args['message']) ?? null,
        confirmLabel: blocked ? '' : 'Send the link',
        warnings: blocked
          ? [
              {
                kind: 'blocked',
                text: `${who} has no email or mobile on file. Add one on their customer page first.`,
              },
            ]
          : [
              {
                kind: 'caution',
                text: `${to.words.startsWith('Text') ? 'Texts' : 'Emails'} ${first} the link to their own page, where they put the card on it themselves.`,
              },
              ...to.missing.map((c) => ({ kind: 'note', text: noContact(first, c) })),
              ...(s.hasCard
                ? []
                : [{ kind: 'note', text: 'The plan starts billing the moment they do.' }]),
            ],
      }),
      result: blocked
        ? { blocked: true, why: `No way to reach ${who}.` }
        : { waiting: true, customer: who, plan: s.planName, channels: to.can },
    };
  },

  async commit(db, ctx, args) {
    const act = String(args['action']);
    const paths = moneyPaths(ctx.workspaceId);
    if (act === 'start') {
      const { person, plan, account, blocked } = await startOf(db, ctx, args);
      if (blocked) throw HfosError.rule('no_payment_account', 409, blocked);
      const out = await command<{ subscriptionId: string }>(db, ctx, 'subscription.start', {
        personId: person.id,
        planId: plan.id,
        connectionId: account?.id ?? null,
      });
      const send = args['sendBy'] === undefined ? null : cardChannels(person, args);
      if (send?.can.length)
        await command(db, ctx, 'subscription.request_card', {
          subscriptionId: out.subscriptionId,
          channels: send.can,
          message: str(args['message']) ?? null,
        });
      return {
        outcome: `${person.fullName} is on ${plan.name}${send?.can.length ? ' — the card link is on its way' : ''}`,
        href: paths.plan(out.subscriptionId),
        command: 'subscription.start',
      };
    }
    const subscriptionId = String(args['subscriptionId']);
    const href = paths.plan(subscriptionId);
    if (act === 'pause' || act === 'resume') {
      await command(db, ctx, `subscription.${act}`, { subscriptionId });
      return {
        outcome:
          act === 'pause'
            ? 'Paused. Nothing is charged until it starts again'
            : 'Billing again from the next cycle',
        href,
        command: `subscription.${act}`,
      };
    }
    if (act === 'cancel') {
      await command(db, ctx, 'subscription.cancel', {
        subscriptionId,
        reason: str(args['reason']) ?? null,
      });
      return { outcome: 'Cancelled', href, command: 'subscription.cancel' };
    }
    const s = await subscriptionOf(db, ctx, subscriptionId);
    const to = cardChannels(s.person, args);
    if (!to.can.length)
      throw HfosError.rule('no_contact', 409, `There is no way to reach ${s.person.fullName}.`);
    await command(db, ctx, 'subscription.request_card', {
      subscriptionId,
      channels: to.can,
      message: str(args['message']) ?? null,
    });
    return {
      outcome: `Sent ${s.person.fullName} the link to add a card`,
      href,
      command: 'subscription.request_card',
    };
  },
};

// ---------------------------------------------------------------------------
// Numbering and ways to pay
// ---------------------------------------------------------------------------

/**
 * Where a counter really is. Sending takes numbers from the counter row and never writes the settings document back,
 * so a business that has sent anything is further on than its settings say — and a save that sent the settings'
 * own number would be refused as going backwards. The preview `money.settings` gives is the counter's, so the
 * number is read off it (the web's Settings → Payments does the same).
 */
function numberingNow(got: MoneySettingsGet): MoneySettings {
  const s = got.settings;
  return {
    ...s,
    numbering: {
      estimate: numberingAtCounter(s.numbering.estimate, got.nextEstimateNumber),
      invoice: numberingAtCounter(s.numbering.invoice, got.nextInvoiceNumber),
    },
  };
}

function numberingNext(now: MoneySettings, args: Args): MoneySettings {
  const pick = (kind: 'estimate' | 'invoice'): DocumentNumbering => {
    const prefix = args[`${kind}Prefix`];
    const next = num(args[`${kind}NextNumber`]);
    return {
      ...now.numbering[kind],
      ...(typeof prefix === 'string' ? { prefix: prefix.trim() } : {}),
      ...(next === undefined ? {} : { next }),
    };
  };
  return {
    ...now,
    numbering: { estimate: pick('estimate'), invoice: pick('invoice') },
    bankTransfer: bool(args['offerBankTransfer']) ?? now.bankTransfer,
  };
}

async function numberingOf(db: Db, ctx: ToolContext, args: Args) {
  const now = numberingNow(await settingsOf(db, ctx));
  const next = numberingNext(now, args);
  for (const kind of ['invoice', 'estimate'] as const) {
    const problem = numberingChangeProblem(now.numbering[kind], next.numbering[kind]);
    if (problem)
      throw HfosError.validation(
        [{ path: `${kind}NextNumber`, message: problem }],
        `${kind === 'invoice' ? 'Invoices' : 'Estimates'}: ${problem}`,
      );
  }
  return { now, next };
}

const updateNumberingAndWaysToPay: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { now, next } = await numberingOf(db, ctx, args);
    const fields: Field[] = [];
    const warnings: Warning[] = [];
    for (const kind of ['invoice', 'estimate'] as const) {
      const was = now.numbering[kind];
      const will = next.numbering[kind];
      if (was.prefix === will.prefix && was.next === will.next) continue;
      fields.push({
        label: kind === 'invoice' ? 'Next invoice' : 'Next estimate',
        value: `${numberPreview(will)} · was ${numberPreview(was)}`,
      });
      if (will.next > was.next)
        warnings.push({
          kind: 'caution',
          text: `${kind === 'invoice' ? 'Invoice' : 'Estimate'} numbers jump from ${was.next} to ${will.next}. The ones between are never used, and numbers never go back down.`,
        });
    }
    if (next.bankTransfer !== now.bankTransfer)
      fields.push({
        label: 'Bank transfer',
        value: next.bankTransfer
          ? 'Offered, and shown first'
          : 'Not offered — customers see card only',
      });
    if (!fields.length) throw nothingChanges();
    if (
      next.numbering.estimate.prefix.trim().toLowerCase() ===
      next.numbering.invoice.prefix.trim().toLowerCase()
    )
      warnings.push({
        kind: 'caution',
        text: 'Estimates and invoices would be numbered the same way, so the two are easy to mix up.',
      });
    warnings.push({
      kind: 'note',
      text: 'A document takes its number when it’s sent. Ones already sent keep theirs.',
    });
    return {
      card: billCard(toolCallId, 'update_numbering_and_ways_to_pay', {
        title: 'Change numbering and ways to pay',
        fields,
        confirmLabel: 'Save the change',
        warnings,
      }),
      result: { waiting: true, changes: fields.map((f) => `${f.label}: ${f.value}`) },
    };
  },

  async commit(db, ctx, args) {
    const { next } = await numberingOf(db, ctx, args);
    await command(db, ctx, 'money.save_settings', { settings: next });
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings/payments`,
      command: 'money.save_settings',
    };
  },
};

// ---------------------------------------------------------------------------
// Automatic top-up of the business's own balance
// ---------------------------------------------------------------------------

interface Wallet {
  opened: boolean;
  balanceCents: number;
  autoTopup: boolean;
  floorCents: number;
  topupCents: number;
  card: {
    brand: string | null;
    last4: string | null;
    expiryMonth: number | null;
    expiryYear: number | null;
  } | null;
}

/** The balance as Settings → Usage & balance reads it. */
async function walletOf(db: Db, ctx: ToolContext): Promise<Wallet | null> {
  return query<Wallet>(db, ctx, 'wallet.get');
}

/** What changes: only what was asked for, and only where it differs from what is there. */
function topupOf(w: Wallet | null, args: Args) {
  const asked = bool(args['on']);
  const below = num(args['belowDollars']);
  const add = num(args['addDollars']);
  const on = asked ?? w?.autoTopup;
  const floorCents = below === undefined ? w?.floorCents : cents(below);
  const topupCents = add === undefined ? w?.topupCents : cents(add);
  const patch = {
    ...(asked === undefined || asked === w?.autoTopup ? {} : { autoTopup: asked }),
    ...(below === undefined || floorCents === w?.floorCents ? {} : { floorCents }),
    ...(add === undefined || topupCents === w?.topupCents ? {} : { topupCents }),
  };
  return { on, floorCents, topupCents, patch };
}

const updateAutoTopup: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const w = await walletOf(db, ctx);
    const { on, floorCents, topupCents, patch } = topupOf(w, args);
    const card = w?.card
      ? cardLine({
          brand: w.card.brand,
          last4: w.card.last4,
          expiryMonth: w.card.expiryMonth,
          expiryYear: w.card.expiryYear,
        })
      : null;
    const cardShort = w?.card ? `${w.card.brand ?? 'Card'} ending ${w.card.last4 ?? '••••'}` : null;
    // The switch on the screen is greyed out without a card, and the command refuses it: said here first.
    const blocked = bool(args['on']) === true && !!w && !card;
    if (!blocked && !Object.keys(patch).length) throw nothingChanges();
    const was = (key: string, words: string) => (w && key in patch ? ` · was ${words}` : '');
    const fields: Field[] = [
      {
        label: 'Automatic top-up',
        value:
          on === undefined
            ? ''
            : `${on ? 'On' : 'Off'}${was('autoTopup', w?.autoTopup ? 'on' : 'off')}`,
      },
      {
        label: 'Tops up below',
        value:
          floorCents === undefined
            ? ''
            : `${money(floorCents)}${was('floorCents', money(w?.floorCents ?? 0))}`,
      },
      {
        label: 'Adds each time',
        value:
          topupCents === undefined
            ? ''
            : `${money(topupCents)}${was('topupCents', money(w?.topupCents ?? 0))}`,
      },
      { label: 'Card on file', value: w ? (card ?? 'None yet') : '' },
      ...(w?.opened ? [{ label: 'Balance now', value: money(w.balanceCents) }] : []),
    ];
    const charges = `charges ${topupCents === undefined ? '' : `${money(topupCents)} `}to ${cardShort ?? 'the card on file'} by itself whenever the balance drops below ${floorCents === undefined ? 'the amount set' : money(floorCents)}`;
    return {
      card: billCard(toolCallId, 'update_auto_topup', {
        title: 'Change automatic top-up',
        fields,
        confirmLabel: blocked ? '' : 'Save the change',
        warnings: blocked
          ? [
              {
                kind: 'blocked',
                text: 'There’s no card on your balance yet, so there’s nothing to top up from. Add one in Settings → Usage & balance — only you can.',
              },
            ]
          : on === false
            ? [
                {
                  kind: 'caution',
                  text: 'Nothing tops it up by itself. When it runs out, outbound texts and calls stop until someone tops it up.',
                },
              ]
            : [
                {
                  kind: 'caution',
                  text: on ? `It ${charges}.` : `While it’s on, it ${charges}.`,
                },
                ...(topupCents === undefined
                  ? []
                  : [
                      {
                        kind: 'note',
                        text: `If several top-ups are needed in a few days the amount goes up each time, and you’re emailed before it charges more than ${money(topupCents * 2)}.`,
                      },
                    ]),
              ],
      }),
      result: blocked
        ? { blocked: true, why: 'No card on the balance. Adding one is the person’s own to do.' }
        : {
            waiting: true,
            ...(on === undefined ? {} : { on }),
            ...(floorCents === undefined ? {} : { below: money(floorCents) }),
            ...(topupCents === undefined ? {} : { adds: money(topupCents) }),
          },
    };
  },

  async commit(db, ctx, args) {
    const { on, patch } = topupOf(await walletOf(db, ctx), args);
    await command(db, ctx, 'wallet.set_auto_topup', patch);
    return {
      outcome:
        'autoTopup' in patch
          ? on
            ? 'Automatic top-up is on'
            : 'Automatic top-up is off'
          : 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings/usage`,
      command: 'wallet.set_auto_topup',
    };
  },
};

// ---------------------------------------------------------------------------
// The two look-ups
// ---------------------------------------------------------------------------

const stateWord = (kind: 'estimate' | 'invoice', state: string) =>
  (kind === 'estimate'
    ? ESTIMATE_WORDS[state as keyof typeof ESTIMATE_WORDS]
    : INVOICE_WORDS[state as keyof typeof INVOICE_WORDS]) ?? state;

const toneOf = (state: string): 'accent' | 'warning' | 'danger' | 'muted' =>
  state === 'overdue'
    ? 'danger'
    : state === 'paying'
      ? 'warning'
      : state === 'void'
        ? 'muted'
        : 'accent';

const linesResult = (lines: readonly LineOut[]) =>
  lines.map((l, i) => ({
    n: i + 1,
    name: l.name,
    ...(l.productId ? { productId: l.productId } : {}),
    quantity: l.quantity,
    unit: l.unitLabel,
    unitPrice: money(l.unitPriceCents),
    ...(l.discountCents > 0 ? { discount: money(l.discountCents) } : {}),
    taxable: l.taxable,
    amount: money(l.amountCents),
  }));

const discountResult = (t: Totals) =>
  t.discountCents > 0
    ? `${money(t.discountCents)} off${t.discountPercentBp ? ` (${percentLabel(t.discountPercentBp)})` : ''}`
    : 'none';

const lineItems = (lines: readonly LineOut[]) =>
  lines.map((l) => ({
    title: l.name,
    detail: `${lineWords(lineIn(l))} = ${money(l.amountCents)}`,
    tone: 'muted' as const,
    href: null,
  }));

async function estimateDocument(
  db: Db,
  ctx: ToolContext,
  estimateId: string,
): Promise<ToolOutcome> {
  const { estimate: e, invoices } = await estimateOf(db, ctx, estimateId);
  const href = moneyPaths(ctx.workspaceId).estimate(e.id);
  const state = stateWord('estimate', e.state);
  return {
    result: {
      kind: 'estimate',
      id: e.id,
      number: e.number,
      state,
      canChange: e.status === 'draft',
      customer: { personId: e.person.id, name: e.person.fullName },
      for: e.title,
      lines: linesResult(e.lines),
      discount: discountResult(e.totals),
      tax: `${money(e.totals.taxCents)} (${percentLabel(e.totals.taxRateBp)})`,
      total: money(e.totals.totalCents),
      deposit:
        e.depositCents > 0
          ? `${money(e.depositCents)}${e.deposit.kind === 'percent' ? ` (${percentLabel(e.deposit.percentBp)})` : ''}`
          : 'none',
      goodUntil: e.expiresOn,
      sentAt: e.sentAt,
      note: e.notes,
      ...(e.acceptedAt
        ? { approved: { at: e.acceptedAt, how: e.acceptedVia, name: quoted(e.acceptedName) } }
        : {}),
      ...(e.declinedAt ? { declined: { at: e.declinedAt, why: quoted(e.declinedReason) } } : {}),
      ...(e.voidReason ? { voidReason: e.voidReason } : {}),
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        state: stateWord('invoice', i.state),
        total: money(i.totalCents),
        owed: money(i.balanceCents),
      })),
    },
    card: {
      type: 'money',
      title: `${e.number ?? 'Draft estimate'} · ${e.person.fullName}`,
      value: money(e.totals.totalCents),
      detail: [state, e.title].filter(Boolean).join(' · '),
      tone: toneOf(e.state),
      stats: [
        ...(e.depositCents > 0
          ? [{ value: money(e.depositCents), label: 'deposit asked for' }]
          : []),
        ...(e.totals.discountCents > 0
          ? [{ value: money(e.totals.discountCents), label: 'discount' }]
          : []),
        ...(e.totals.taxCents > 0 ? [{ value: money(e.totals.taxCents), label: 'tax' }] : []),
      ],
      items: lineItems(e.lines).slice(0, 8),
      href,
    },
  };
}

async function invoiceDocument(db: Db, ctx: ToolContext, invoiceId: string): Promise<ToolOutcome> {
  const { invoice: i, payments, refunds } = await invoiceOf(db, ctx, invoiceId);
  const href = moneyPaths(ctx.workspaceId).invoice(i.id);
  const state = stateWord('invoice', i.state);
  const pending = (p: Payment) =>
    refunds
      .filter((r) => r.paymentId === p.id && r.status === 'pending')
      .reduce((sum, r) => sum + r.amountCents, 0);
  return {
    result: {
      kind: 'invoice',
      id: i.id,
      number: i.number,
      state,
      canChange: i.status === 'draft',
      customer: { personId: i.person.id, name: i.person.fullName },
      for: i.title,
      lines: linesResult(i.lines),
      discount: discountResult(i.totals),
      tax: `${money(i.totals.taxCents)} (${percentLabel(i.totals.taxRateBp)})`,
      total: money(i.totals.totalCents),
      paid: money(i.amountPaidCents),
      refunded: money(i.amountRefundedCents),
      owed: money(i.balanceCents),
      dueOn: i.dueOn,
      terms: i.terms,
      sentAt: i.sentAt,
      note: i.notes,
      ...(i.voidReason ? { voidReason: i.voidReason } : {}),
      payments: payments.map((p) => ({
        paymentId: p.id,
        amount: money(p.amountCents),
        by: paymentWords(p),
        status: p.status,
        when: p.receivedAt ?? p.createdAt,
        refunded: money(p.refundedCents),
        refundable: money(
          p.status === 'succeeded' ? Math.max(0, p.amountCents - p.refundedCents - pending(p)) : 0,
        ),
      })),
      refunds: refunds.map((r) => ({
        amount: money(r.amountCents),
        status: r.status,
        when: r.refundedAt ?? r.createdAt,
        reason: r.reason,
      })),
    },
    card: {
      type: 'money',
      title: `${i.number ?? 'Draft invoice'} · ${i.person.fullName}`,
      value: money(i.totals.totalCents),
      detail: [state, i.title, i.dueOn ? `due ${dayWords(i.dueOn, ctx.timezone)}` : null]
        .filter(Boolean)
        .join(' · '),
      tone: toneOf(i.state),
      stats: [
        ...(i.status === 'draft' ? [] : [{ value: money(i.balanceCents), label: 'still owed' }]),
        ...(i.amountPaidCents > 0 ? [{ value: money(i.amountPaidCents), label: 'paid' }] : []),
        ...(i.amountRefundedCents > 0
          ? [{ value: money(i.amountRefundedCents), label: 'refunded' }]
          : []),
      ],
      items: [
        ...lineItems(i.lines).slice(0, payments.length ? 5 : 8),
        ...payments.slice(0, 3).map((p) => ({
          title: `Payment · ${paymentWords(p)}`,
          detail: [
            money(p.amountCents),
            dayWords((p.receivedAt ?? p.createdAt).slice(0, 10), ctx.timezone),
            p.refundedCents > 0 ? `${money(p.refundedCents)} refunded` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          tone: 'accent' as const,
          href: null,
        })),
      ],
      href,
    },
  };
}

export const billingAutoTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args) => Promise<ToolOutcome>
> = {
  /** "What's on Maria's estimate?" / "Which payment do I refund?" */
  async get_money_document(db, ctx, args) {
    const estimateId = str(args['estimateId']);
    const invoiceId = str(args['invoiceId']);
    if (!estimateId === !invoiceId)
      throw HfosError.validation([], 'Pass one id: an estimateId or an invoiceId.');
    return estimateId
      ? estimateDocument(db, ctx, estimateId)
      : invoiceDocument(db, ctx, invoiceId!);
  },

  /** "What plans do we sell?" / "Who's on the Comfort Club?" */
  async list_plans(db, ctx, args) {
    const ws = ctx.workspaceId;
    const planId = str(args['planId']);
    const personId = str(args['personId']);
    const narrowed = !!(planId || personId);
    const [{ plans }, subs, services] = await Promise.all([
      query<{ plans: Plan[] }>(db, ctx, 'plan.list', { includeArchived: true }),
      // Who is on a plan is for whoever bills; someone who may only look sees the catalogue.
      ifAllowed(
        query<{ subscriptions: Subscription[] }>(db, ctx, 'subscription.list', {
          limit: 100,
          ...(planId ? { planId } : {}),
          ...(personId ? { personId } : {}),
          // Plans that ended are only worth listing when someone asks about one plan or one customer.
          ...(narrowed ? {} : { status: ['draft', 'active', 'past_due', 'paused', 'unmanaged'] }),
        }),
      ),
      serviceNames(db, ctx),
    ]);
    const shown = plans.filter(
      (p) =>
        (args['includeStopped'] === true || !p.archivedAt || p.id === planId) &&
        (!planId || p.id === planId),
    );
    const customers = subs?.subscriptions ?? null;
    const live = (customers ?? []).filter((s) => s.status !== 'cancelled');
    const onIt = (id: string) => live.filter((s) => s.planId === id).length;
    const paths = moneyPaths(ws);
    const items: ListCard['items'] = narrowed
      ? (customers ?? []).slice(0, 12).map((s) => ({
          title: `${s.person.fullName} · ${s.planName}`,
          detail: [
            planPriceLabel(s.priceCents, s.interval, s.intervalCount),
            planStatus(s),
            s.nextBillingOn && s.status === 'active'
              ? `next ${dayWords(s.nextBillingOn, ctx.timezone)}`
              : null,
          ]
            .filter(Boolean)
            .join(' · '),
          tone: s.status === 'past_due' ? 'danger' : s.status === 'active' ? 'accent' : 'muted',
          href: paths.plan(s.id),
        }))
      : shown.slice(0, 12).map((p) => ({
          title: p.name,
          detail: [
            planPriceLabel(p.priceCents, p.interval, p.intervalCount),
            customers ? counted(onIt(p.id), 'customer') : null,
            p.archivedAt ? 'not on sale' : null,
          ]
            .filter(Boolean)
            .join(' · '),
          tone: p.archivedAt ? 'muted' : 'accent',
          href: paths.plans(),
        }));
    return {
      result: {
        plans: shown.map((p) => ({
          planId: p.id,
          name: p.name,
          price: planPriceLabel(p.priceCents, p.interval, p.intervalCount),
          includes: p.includes,
          taxable: p.taxable,
          visits: visitsWords(p, services),
          onSale: !p.archivedAt,
          // Counted only across everyone: narrowed to one customer, the count would be theirs alone.
          ...(customers && !personId ? { customersOnIt: onIt(p.id) } : {}),
        })),
        ...(customers
          ? {
              customers: customers.map((s) => ({
                subscriptionId: s.id,
                personId: s.person.id,
                customer: s.person.fullName,
                plan: s.planName,
                planId: s.planId,
                price: planPriceLabel(s.priceCents, s.interval, s.intervalCount),
                status: planStatus(s),
                nextBilling: s.nextBillingOn,
                card: s.hasCard
                  ? s.cardBrand && s.cardLast4
                    ? `${s.cardBrand} •••• ${s.cardLast4}`
                    : 'on file'
                  : s.cardRequestedAt
                    ? 'asked for, not added yet'
                    : 'none',
              })),
            }
          : { note: 'Who is on a plan is only for people who bill.' }),
      },
      card: {
        type: 'list',
        title: narrowed ? 'On a plan' : 'Plans you sell',
        ...(customers ? { aside: counted(live.length, 'customer') + ' on a plan' } : {}),
        items,
      },
    };
  },
};

export const billingConfirmTools: Record<string, SettingsConfirmTool> = {
  write_estimate: writeTool('estimate'),
  manage_estimate: manageEstimate,
  write_invoice: writeTool('invoice'),
  manage_invoice: manageInvoice,
  refund_payment: refundPayment,
  manage_plan: managePlan,
  manage_customer_plan: manageCustomerPlan,
  update_numbering_and_ways_to_pay: updateNumberingAndWaysToPay,
  update_auto_topup: updateAutoTopup,
};

/** What the panel says while each one runs. */
export const billingStepLabels: Record<string, string> = {
  get_money_document: 'Opening the document',
  list_plans: 'Looking at plans',
  write_estimate: 'Writing the estimate',
  manage_estimate: 'Getting the estimate ready',
  write_invoice: 'Writing the invoice',
  manage_invoice: 'Getting the invoice ready',
  refund_payment: 'Getting the refund ready',
  manage_plan: 'Setting up the plan',
  manage_customer_plan: 'Getting their plan ready',
  update_numbering_and_ways_to_pay: 'Changing numbering and ways to pay',
  update_auto_topup: 'Changing automatic top-up',
};
