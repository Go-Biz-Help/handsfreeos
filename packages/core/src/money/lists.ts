/**
 * Money as a list: the four tabs, the three headline figures, the "Due" column, what a document is for, the empty
 * states, and the one rule that decides **what a person may see**.
 *
 * Shared by the web's Money section (`components/money/headline-strip.tsx`, `invoices-list.tsx`, `list-bits.tsx`,
 * `subnav.tsx`, the section's `load.ts`) and the phone's Money screens, so an owner and a member read the same
 * words on either. Pure and browser-safe; the arithmetic itself is `totals.ts` and `status.ts`.
 *
 * **Members and money.** A member may see the estimates and invoices for the jobs they are on — nothing else. That
 * is enforced in the database (migration 0056's viewer lists) and in the phone's copy (the `me_v1` sync bucket), so
 * a screen never has a figure it should hide. What a screen still has to get right is the parts that are *about the
 * whole business*: the headline figures, the payments list and the plans list. `moneyTabsFor` and
 * `seesWholeBusiness` are that decision, in one place, so no screen has to remember it.
 */
import { dayLabel } from '../attention/wording';
import { addDays, localDateOf } from '../calendar/engine/zoned';
import { formatDateOnly } from '../crm/format';
import { money, moneyRounded } from './format';
import type { InvoiceState } from './status';
import { dueWording } from './words';

/** Whose money it is. Agency staff arrive as one of these three, flattened in. */
export type MoneyRole = 'owner' | 'admin' | 'member';

/**
 * What a person may do here, as the API (workspace.get) or the phone's own access row gives it (0105): their role's
 * permissions with the business's settings for the role and for them applied.
 */
export type MoneyPermissions = readonly string[];

/**
 * Whether this person sees the business's money rather than only their own jobs' (money.manage). Owners and admins
 * do unless the business says otherwise; anyone else sees the documents they are on and no totals — the canvas's
 * "Marco is a member, so the phone only ever receives the invoices for jobs he is on: no totals, no other customers."
 */
export const seesWholeBusiness = (permissions: MoneyPermissions): boolean =>
  permissions.includes('money.manage');

/** Whether they may write, send and void estimates and invoices and run plans (money.bill), for what they see. */
export const canBill = (permissions: MoneyPermissions): boolean =>
  permissions.includes('money.bill');

/** Whether they run the business's money: refunds, the catalogue, the settings and the accounts. */
export const canManageMoney = (permissions: MoneyPermissions): boolean =>
  seesWholeBusiness(permissions);

// ---- The tabs ----

export type MoneyTab = 'invoices' | 'estimates' | 'payments' | 'plans';

export const MONEY_TAB_LABELS: Readonly<Record<MoneyTab, string>> = {
  invoices: 'Invoices',
  estimates: 'Estimates',
  payments: 'Payments',
  plans: 'Plans',
};

export const MONEY_TABS: readonly MoneyTab[] = ['invoices', 'estimates', 'payments', 'plans'];

/**
 * The phone's tabs. Payments and Plans are the whole business's, and its copy of them is the managers' (the sync
 * rules' `managed` arm), so only someone who manages money gets them; anyone else, Invoices and Estimates — someone
 * who bills starts and runs their customers' plans on the web.
 */
export function moneyTabsFor(permissions: MoneyPermissions): readonly MoneyTab[] {
  return seesWholeBusiness(permissions) ? MONEY_TABS : ['invoices', 'estimates'];
}

/** What Money is for, under its title. */
export const MONEY_DESCRIPTION = 'What you have quoted, what you are owed and what has come in.';

// ---- The three figures above the lists ----

/** How far back "collected" reaches. */
export const COLLECTED_DAYS = 30;

export interface MoneySummaryFacts {
  readonly outstandingCents: number;
  readonly outstandingCount: number;
  /** Money on its way: a bank transfer still settling. */
  readonly settlingCents: number;
  readonly overdueCents: number;
  readonly overdueCount: number;
  readonly collectedCents: number;
  readonly refundedCents: number;
  /** The moment the figures were worked out, as an instant or an ISO string. */
  readonly now: number | string;
}

export type FigureTone = 'bad' | 'good' | null;

export interface HeadlineFigure {
  readonly key: 'outstanding' | 'overdue' | 'collected';
  readonly value: string;
  readonly label: string;
  readonly sub: string;
  readonly tone: FigureTone;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * What you are owed, what is late and what has come in: the three numbers above every list. Outstanding and
 * overdue are exact to the cent — they are what someone chases — while collected is a summary, so it rounds.
 */
export function headlineFigures(
  s: MoneySummaryFacts,
  timeZone: string,
  days = COLLECTED_DAYS,
): readonly HeadlineFigure[] {
  const at = typeof s.now === 'number' ? s.now : Date.parse(s.now);
  const today = localDateOf(at, timeZone);
  const from = addDays(today, -days);
  const settling = s.settlingCents > 0;
  return [
    {
      key: 'outstanding',
      value: money(s.outstandingCents),
      label: 'Outstanding',
      sub:
        s.outstandingCount === 0
          ? 'Nothing waiting to be paid'
          : settling
            ? `${plural(s.outstandingCount, 'invoice')} waiting · ${money(s.settlingCents)} on its way`
            : `${plural(s.outstandingCount, 'invoice')} waiting to be paid`,
      tone: null,
    },
    {
      key: 'overdue',
      value: money(s.overdueCents),
      label: 'Overdue',
      sub:
        s.overdueCount === 0
          ? 'Nothing is late'
          : `${plural(s.overdueCount, 'invoice')} past the due date`,
      tone: s.overdueCents > 0 ? 'bad' : null,
    },
    {
      key: 'collected',
      value: moneyRounded(s.collectedCents),
      label: `Collected in ${days} days`,
      sub:
        s.refundedCents > 0
          ? `${formatDateOnly(from)} to ${formatDateOnly(today)} · after ${money(s.refundedCents)} refunded`
          : `${formatDateOnly(from)} to ${formatDateOnly(today)}`,
      tone: s.collectedCents > 0 ? 'good' : null,
    },
  ];
}

// ---- One invoice on a list ----

export interface InvoiceRowFacts {
  readonly status: string;
  readonly state: InvoiceState | string;
  readonly dueOn: string | null;
  readonly paidAt: string | null;
  readonly voidedAt: string | null;
}

/**
 * What the "Due" column says: a paid invoice is done, a settling one is on its way, a draft hasn't gone out. One
 * whose money all went back is refunded, not "paid" — the badge beside it and the column say the same.
 */
export function invoiceDueLabel(
  inv: InvoiceRowFacts,
  now: number | Date,
  timeZone: string,
): string {
  if (inv.voidedAt) return 'Voided';
  if (inv.state === 'refunded') return 'Refunded';
  if (inv.status === 'paid')
    return inv.paidAt ? `Paid ${dayLabel(Date.parse(inv.paidAt), timeZone)}` : 'Paid';
  if (inv.state === 'paying') return 'A payment is on its way';
  if (inv.status === 'draft') return 'Not sent';
  return dueWording(inv.dueOn, now, timeZone);
}

/** "Deposit", "Plan", "Setup fee" — why this invoice exists, when it isn't just a job. */
export function purposeLabel(purpose: string): string | null {
  if (purpose === 'deposit') return 'Deposit';
  if (purpose === 'subscription') return 'Plan';
  if (purpose === 'setup_fee') return 'Setup fee';
  return null;
}

/**
 * The Status column answers "where is this document", so an opened one still reads Sent — the fuller state is on
 * the document's own page.
 */
export const listState = (state: string): string => (state === 'viewed' ? 'sent' : state);

/** The provider a payment came through, as people name it. */
export const PAYMENT_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  stripe: 'Stripe',
  square: 'Square',
  paypal: 'PayPal',
  nmi: 'NMI',
  authorize_net: 'Authorize.net',
};

// ---- Nothing to show ----

export interface ListEmpty {
  readonly title: string;
  readonly body: string;
}

/** `filtered` is true when a search or a status is on: then it's "no match", not "none yet". */
export function invoicesEmpty(filtered: boolean): ListEmpty {
  return filtered
    ? { title: 'No invoices match', body: 'Try a different search, or show every status.' }
    : {
        title: 'No invoices yet',
        body: 'Bill a job, or turn an approved estimate into an invoice in one press.',
      };
}

export function estimatesEmpty(filtered: boolean): ListEmpty {
  return filtered
    ? { title: 'No estimates match', body: 'Try a different search, or show every status.' }
    : {
        title: 'No estimates yet',
        body: 'Quote a job from the catalogue. The customer approves it on their own page.',
      };
}

export function paymentsEmpty(filtered: boolean): ListEmpty {
  return filtered
    ? { title: 'No payments match', body: 'Try a different filter.' }
    : {
        title: 'No payments yet',
        body: 'Money lands here the moment a customer pays, and when you record cash or a cheque.',
      };
}

// ---- A customer's own link ----

export type MoneyLinkKind = 'estimate' | 'invoice' | 'plan';

/** What the link lets whoever has it do: said once, as the link is copied. */
export const MONEY_LINK_WHAT_IT_DOES: Readonly<Record<MoneyLinkKind, string>> = {
  estimate: 'Anyone with this link can see and approve this estimate.',
  invoice: 'Anyone with this link can pay this invoice.',
  plan: 'Anyone with this link can put a card on this plan.',
};

export const LINK_COPIED = 'Link copied';

/** When the worker couldn't be reached at all. Its own words are used when it answered. */
export const LINK_UNAVAILABLE = 'We couldn’t get the link just now. Try again in a minute.';
