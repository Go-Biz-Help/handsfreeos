/**
 * The document an editor holds while it is being written, and the body it turns into. One shape for estimates
 * and invoices: they diverge at the ends (a deposit and an expiry; an account, terms and a due date), and
 * everything in the middle — the customer, the lines, the discount, the notes — is the same document.
 */
import {
  computeTotals,
  type DepositTerms,
  type DocumentDiscount,
  type DocumentTotals,
  type MoneySettings,
} from '@hfos/core';
import type {
  EstimateDetail,
  EstimateUpdateBody,
  InvoiceDetail,
  MoneyLineRow,
  PaymentConnectionRow,
} from '@/lib/api/types';

/** Everything both documents send on every save. The ends they differ at ride alongside it. */
export type DocumentHeaderBody = Pick<
  EstimateUpdateBody,
  | 'workspaceId'
  | 'personId'
  | 'leadId'
  | 'assigneeUserId'
  | 'title'
  | 'notes'
  | 'lines'
  | 'discount'
>;

export type TermsKind = 'none' | 'percent' | 'amount';

/** A discount or a deposit, in the one shape core's arithmetic and the command's body both take. */
export interface MoneyTermsValue {
  readonly kind: TermsKind;
  readonly percentBp?: number;
  readonly amountCents?: number;
}

export interface DraftLine {
  /** Stable while the line is on screen, so React keeps the field you are typing in. */
  readonly key: string;
  productId: string | null;
  name: string;
  description: string;
  quantity: number;
  unitLabel: string;
  unitPriceCents: number;
  taxable: boolean;
  /** Money off this line, before the document discount is shared out. */
  discountCents: number;
}

export interface DocumentDraft {
  personId: string;
  person: { id: string; fullName: string; email: string | null; phone: string | null } | null;
  leadId: string | null;
  assigneeUserId: string | null;
  title: string;
  notes: string;
  lines: DraftLine[];
  discountKind: TermsKind;
  discountPercentBp: number;
  discountAmountCents: number;
  /** Estimates only. */
  depositKind: TermsKind;
  depositPercentBp: number;
  depositAmountCents: number;
  expiresOn: string | null;
  /** Invoices only. */
  connectionId: string | null;
  dueOn: string | null;
  terms: string | null;
}

let counter = 0;
export const lineKey = (): string => `line-${++counter}`;

export function newLine(partial: Partial<DraftLine> = {}): DraftLine {
  return {
    key: lineKey(),
    productId: null,
    name: '',
    description: '',
    quantity: 1,
    unitLabel: 'each',
    unitPriceCents: 0,
    taxable: true,
    discountCents: 0,
    ...partial,
  };
}

const lineOf = (row: MoneyLineRow): DraftLine => ({
  key: lineKey(),
  productId: row.productId,
  name: row.name,
  description: row.description ?? '',
  quantity: row.quantity,
  unitLabel: row.unitLabel,
  unitPriceCents: row.unitPriceCents,
  taxable: row.taxable,
  discountCents: row.discountCents,
});

/** A discount as it reads back: a percentage when one was given, otherwise the amount that was taken. */
function discountOf(totals: {
  discountCents: number;
  discountPercentBp: number | null;
}): Pick<DocumentDraft, 'discountKind' | 'discountPercentBp' | 'discountAmountCents'> {
  if (totals.discountPercentBp)
    return {
      discountKind: 'percent',
      discountPercentBp: totals.discountPercentBp,
      discountAmountCents: totals.discountCents,
    };
  if (totals.discountCents > 0)
    return {
      discountKind: 'amount',
      discountPercentBp: 1_000,
      discountAmountCents: totals.discountCents,
    };
  return { discountKind: 'none', discountPercentBp: 1_000, discountAmountCents: 0 };
}

/**
 * A deposit as it reads back: the terms that were written, straight from the query. The figure the document
 * isn't using comes back as 0, so the business's own default stands in for it — switching a 25% deposit to an
 * amount starts somewhere sensible instead of at nothing, and switching back finds the 25% still there.
 */
function depositOf(
  deposit: EstimateDetail['deposit'],
  settings: MoneySettings,
): Pick<DocumentDraft, 'depositKind' | 'depositPercentBp' | 'depositAmountCents'> {
  const remembered = <T extends number>(inUse: boolean, stored: T, fallback: T): T =>
    inUse ? stored : stored || fallback;
  return {
    depositKind: deposit.kind,
    depositPercentBp: remembered(
      deposit.kind === 'percent',
      deposit.percentBp,
      settings.deposit.percentBp || 2_500,
    ),
    depositAmountCents: remembered(
      deposit.kind === 'amount',
      deposit.amountCents,
      settings.deposit.amountCents,
    ),
  };
}

function base(settings: MoneySettings): DocumentDraft {
  return {
    personId: '',
    person: null,
    leadId: null,
    assigneeUserId: null,
    title: '',
    notes: '',
    lines: [],
    discountKind: 'none',
    discountPercentBp: 1_000,
    discountAmountCents: 0,
    depositKind: settings.deposit.kind,
    depositPercentBp: settings.deposit.percentBp || 2_500,
    depositAmountCents: settings.deposit.amountCents,
    expiresOn: null,
    connectionId: null,
    dueOn: null,
    terms: null,
  };
}

/**
 * The accounts someone may pick to be paid into (0105): the ones they may bill into, and the one a document
 * already uses even if it isn't theirs, so an invoice someone else raised still reads right.
 */
export function accountsFor(
  connections: readonly PaymentConnectionRow[],
  current: string | null = null,
): PaymentConnectionRow[] {
  return connections.filter((c) => c.usableByMe || c.id === current);
}

/**
 * Where something new is paid into unless they pick, as the server would choose it: the default if it's theirs,
 * else the first of theirs — connected ones only, never one still signing in or needing a reconnect.
 */
export function firstAccount(
  connections: readonly PaymentConnectionRow[],
): PaymentConnectionRow | undefined {
  const mine = accountsFor(connections).filter((c) => c.status === 'active');
  return mine.find((c) => c.isDefault) ?? mine[0];
}

/** A blank document, with the business's own defaults already in it. */
export function blankDraft(
  kind: 'estimate' | 'invoice',
  settings: MoneySettings,
  connections: readonly PaymentConnectionRow[],
  seed: {
    person?: DocumentDraft['person'];
    leadId?: string | null;
    title?: string;
    assigneeUserId?: string | null;
  } = {},
): DocumentDraft {
  const fallback = firstAccount(connections);
  return {
    ...base(settings),
    personId: seed.person?.id ?? '',
    person: seed.person ?? null,
    leadId: seed.leadId ?? null,
    title: seed.title ?? '',
    assigneeUserId: seed.assigneeUserId ?? null,
    notes: kind === 'estimate' ? settings.notes.estimate : settings.notes.invoice,
    connectionId: kind === 'invoice' ? (fallback?.id ?? null) : null,
  };
}

export function draftOfEstimate(est: EstimateDetail, settings: MoneySettings): DocumentDraft {
  return {
    ...base(settings),
    personId: est.person.id,
    person: est.person,
    leadId: est.leadId,
    assigneeUserId: est.assignee?.id ?? null,
    title: est.title ?? '',
    notes: est.notes ?? '',
    lines: est.lines.map(lineOf),
    ...discountOf(est.totals),
    ...depositOf(est.deposit, settings),
    expiresOn: est.expiresOn,
  };
}

export function draftOfInvoice(inv: InvoiceDetail, settings: MoneySettings): DocumentDraft {
  return {
    ...base(settings),
    personId: inv.person.id,
    person: inv.person,
    leadId: inv.leadId,
    assigneeUserId: inv.assignee?.id ?? null,
    title: inv.title ?? '',
    notes: inv.notes ?? '',
    lines: inv.lines.map(lineOf),
    ...discountOf(inv.totals),
    connectionId: inv.connectionId,
    dueOn: inv.dueOn,
    terms: inv.terms,
  };
}

const terms = (kind: TermsKind, percentBp: number, amountCents: number): MoneyTermsValue =>
  kind === 'percent'
    ? { kind, percentBp }
    : kind === 'amount'
      ? { kind, amountCents }
      : { kind: 'none' };

export const discountTerms = (d: DocumentDraft): MoneyTermsValue =>
  terms(d.discountKind, d.discountPercentBp, d.discountAmountCents);

export const depositTerms = (d: DocumentDraft): MoneyTermsValue =>
  terms(d.depositKind, d.depositPercentBp, d.depositAmountCents);

/** What the editor shows and what the server will store: the same arithmetic, from `@hfos/core`. */
export function draftTotals(draft: DocumentDraft, settings: MoneySettings): DocumentTotals {
  return computeTotals({
    lines: draft.lines.map((l) => ({
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      discountCents: l.discountCents,
      taxable: l.taxable,
    })),
    discount: discountTerms(draft) as DocumentDiscount,
    deposit: depositTerms(draft) as DepositTerms,
    taxRateBp: settings.tax.rateBp,
  });
}

/** The header and lines every save sends, whole: there are no partial document saves. */
export function draftBody(draft: DocumentDraft, workspaceId: string): DocumentHeaderBody {
  return {
    workspaceId,
    personId: draft.personId,
    leadId: draft.leadId,
    assigneeUserId: draft.assigneeUserId,
    title: draft.title.trim() || null,
    notes: draft.notes.trim() || null,
    lines: draft.lines.map((l) => ({
      productId: l.productId,
      name: l.name.trim(),
      description: l.description.trim() || null,
      quantity: l.quantity,
      unitLabel: l.unitLabel.trim() || 'each',
      unitPriceCents: l.unitPriceCents,
      taxable: l.taxable,
      discountCents: l.discountCents,
    })),
    discount: discountTerms(draft),
  };
}

/** What stops a draft being saved, in the order someone would fix it. */
export function draftProblem(draft: DocumentDraft): string | null {
  if (!draft.personId) return 'Pick who this is for.';
  if (draft.lines.length === 0) return 'Add at least one line.';
  if (draft.lines.some((l) => !l.name.trim())) return 'Every line needs a name.';
  if (draft.lines.some((l) => !(l.quantity > 0))) return 'Every line needs a quantity.';
  return null;
}
