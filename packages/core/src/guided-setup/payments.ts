/**
 * The guided payments setup (the owner, 23 Nov 2026, "a" on all four picks): seven questions, one at a time, then
 * Check it over, where Save writes the money settings (money.save_settings) and, for a business with no account yet,
 * sends them to sign in to Stripe or Square last (P1). The answers start from what the kind of business usually picks
 * (P2) until the business has saved money settings of its own; from then on they start from those. With an account
 * already connected the same questions open without the first one (Settings → Payments, "Go through the questions
 * again", and each answer's Change).
 *
 * What the web and the phone both decide lives here: the answers as they are saved (guided_setup.save_draft, under
 * `payments`), which questions a path asks, what is wrong with an answer, the lines beside the questions and on
 * Settings → Payments, and the settings Save writes. Browser-safe.
 */
import { z } from 'zod';
import { findIndustry, type IndustryGroupName } from '../industries';
import { money } from '../money/format';
import {
  nextNumberProblem,
  numberingAtCounter,
  numberPreview,
  prefixProblem,
} from '../money/numbering';
import {
  PAYMENT_TERMS,
  TERMS_DAYS,
  defaultMoneySettings,
  type MoneySettings,
  type PaymentTerms,
} from '../money/settings';
import { PAYMENTS_PAGE_WORDS } from '../money/words';
import {
  isConnectableProvider,
  PAYMENT_PROVIDER_NAMES,
  type ConnectableProvider,
} from '../schemas/money';

export const PAYMENTS_SETUP_QUESTIONS = [
  'where',
  'ways',
  'tax',
  'due',
  'estimates',
  'reminders',
  'documents',
] as const;
export type PaymentsSetupQuestion = (typeof PAYMENTS_SETUP_QUESTIONS)[number];
/** A question, or the last screen. */
export type PaymentsSetupScreen = PaymentsSetupQuestion | 'review';
export const paymentsSetupScreen = z.enum([...PAYMENTS_SETUP_QUESTIONS, 'review']);

export const PAYMENTS_SETUP_WHERE = ['stripe', 'square', 'paypal', 'later'] as const;
export type PaymentsSetupWhere = (typeof PAYMENTS_SETUP_WHERE)[number];
/** The usual reminders, a nudge or two, none, or the business's own schedule kept as it is. */
export const PAYMENTS_SETUP_REMINDERS = ['usual', 'few', 'none', 'own'] as const;
export type PaymentsSetupReminders = (typeof PAYMENTS_SETUP_REMINDERS)[number];
export type PaymentsSetupDeposit = 'none' | 'percent' | 'amount';

/**
 * The answers as the screens keep them. The numbers stay as typed (a half-typed rate is still worth keeping):
 * `paymentsSetupProblems` says what is wrong, and money.save_settings checks the real thing again.
 */
export const PaymentsSetupAnswers = z.object({
  where: z.enum(PAYMENTS_SETUP_WHERE),
  bankTransfer: z.boolean(),
  venmo: z.boolean(),
  payLater: z.boolean(),
  /** Null until they say: a tax rate is never guessed. */
  tax: z.enum(['no', 'yes']).nullable(),
  taxRate: z.string().max(10),
  taxName: z.string().max(40),
  newTaxable: z.boolean(),
  terms: z.enum(PAYMENT_TERMS),
  estimates: z.boolean(),
  estimateDays: z.string().max(4),
  deposit: z.enum(['none', 'percent', 'amount']),
  depositPercent: z.string().max(6),
  depositAmount: z.string().max(14),
  reminders: z.enum(PAYMENTS_SETUP_REMINDERS),
  estimateNudge: z.boolean(),
  address: z.string().max(300),
  invoicePrefix: z.string().max(20),
  invoiceNext: z.string().max(12),
  note: z.string().max(2_000),
});
export type PaymentsSetupAnswers = z.infer<typeof PaymentsSetupAnswers>;

/** The account money goes into, as the setup shows it. */
export interface PaymentsSetupAccount {
  readonly provider: ConnectableProvider;
  /** Its own name, when it has one ("Shop account"). */
  readonly label: string | null;
  /** Connected and taking payments, connected but still being checked, or needing its sign-in again. */
  readonly state: 'ready' | 'checking' | 'broken';
}

export interface PaymentsSetupContext {
  /** No account yet: the first question picks one. With one: the same questions, without that. */
  readonly mode: 'new' | 'again';
  readonly account: PaymentsSetupAccount | null;
  /** Connect PayPal is open to everyone (NEXT_PUBLIC_PAYPAL_ENABLED, the phone's payPalEnabled). */
  readonly payPalOpen: boolean;
  /** The settings as they are now: the next number only moves forward from here. */
  readonly settings: MoneySettings;
  /** The address the onboarding setup asked for, as lines: documents show it while none is written. */
  readonly setupAddress: string | null;
  /** The business has saved money settings of its own; until it has, answers start from its kind of business. */
  readonly configured: boolean;
}

/** The account a business has, from its connections: the first working one, else one that needs signing in again. */
export function paymentsSetupAccountOf(
  connections: readonly {
    readonly provider: string;
    readonly status: string;
    readonly label: string | null;
    readonly capabilities: Readonly<Record<string, unknown>>;
  }[],
): PaymentsSetupAccount | null {
  const usable = connections.filter((c) => isConnectableProvider(c.provider));
  const active = usable.find((c) => c.status === 'active');
  if (active) {
    // As Settings → Payments says it: nothing switched on yet means the provider is still checking the account.
    const on = ['card', 'bankTransfer', 'subscriptions', 'refunds'].some(
      (k) => active.capabilities[k] === true,
    );
    return {
      provider: active.provider as ConnectableProvider,
      label: active.label,
      state: on ? 'ready' : 'checking',
    };
  }
  const broken = usable.find((c) => c.status === 'reauth_required' || c.status === 'error');
  return broken
    ? { provider: broken.provider as ConnectableProvider, label: broken.label, state: 'broken' }
    : null;
}

/**
 * The setup's context, from money.settings, payment_connection.list and the onboarding address. The numbers start
 * where the counters are (a Send moves the counter, not the settings), so the preview is honest and Save is never
 * refused for going backwards.
 */
export const paymentsSetupContextFrom = (input: {
  readonly connections: Parameters<typeof paymentsSetupAccountOf>[0];
  readonly payPalOpen: boolean;
  readonly money: {
    readonly settings: MoneySettings;
    readonly nextEstimateNumber: string;
    readonly nextInvoiceNumber: string;
  };
  readonly setupAddress: string | null;
}): PaymentsSetupContext => {
  const account = paymentsSetupAccountOf(input.connections);
  return {
    mode: account ? 'again' : 'new',
    account,
    payPalOpen: input.payPalOpen,
    settings: paymentsSettingsAtCounters(input.money),
    setupAddress: input.setupAddress,
    configured: paymentsSettingsConfigured(input.money.settings),
  };
};

/** money.settings' settings with the numbers caught up to the counters: what Save starts from. */
export function paymentsSettingsAtCounters(m: {
  readonly settings: MoneySettings;
  readonly nextEstimateNumber: string;
  readonly nextInvoiceNumber: string;
}): MoneySettings {
  return {
    ...m.settings,
    numbering: {
      estimate: numberingAtCounter(m.settings.numbering.estimate, m.nextEstimateNumber),
      invoice: numberingAtCounter(m.settings.numbering.invoice, m.nextInvoiceNumber),
    },
  };
}

// ---------- the starting answers ----------

interface Usual {
  readonly terms: PaymentTerms;
  readonly estimates: boolean;
  readonly estimateDays: number;
  readonly deposit: PaymentsSetupDeposit;
  readonly depositPercent: number;
  readonly reminders: 'usual' | 'few';
}

/**
 * What each kind of business usually picks (P2): only a starting point, every answer changed on its own screen.
 * Trades quote first and take a share up front; a salon or a shop is paid on the spot and never quotes.
 */
const USUAL: Readonly<Record<IndustryGroupName, Usual>> = {
  'Home services & trades': {
    terms: 'net_14',
    estimates: true,
    estimateDays: 30,
    deposit: 'percent',
    depositPercent: 25,
    reminders: 'usual',
  },
  'Real estate & property': {
    terms: 'net_14',
    estimates: false,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'usual',
  },
  'Health & care': {
    terms: 'due_on_receipt',
    estimates: false,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'few',
  },
  'Beauty & fitness': {
    terms: 'due_on_receipt',
    estimates: false,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'few',
  },
  Pets: {
    terms: 'due_on_receipt',
    estimates: false,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'few',
  },
  'Auto & vehicles': {
    terms: 'due_on_receipt',
    estimates: true,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'few',
  },
  'Finance, legal & insurance': {
    terms: 'net_14',
    estimates: true,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'usual',
  },
  'Education & childcare': {
    terms: 'net_7',
    estimates: false,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'usual',
  },
  'Events, food & hospitality': {
    terms: 'net_14',
    estimates: true,
    estimateDays: 30,
    deposit: 'percent',
    depositPercent: 50,
    reminders: 'usual',
  },
  'Rentals & equipment': {
    terms: 'due_on_receipt',
    estimates: true,
    estimateDays: 14,
    deposit: 'percent',
    depositPercent: 25,
    reminders: 'few',
  },
  'Professional services': {
    terms: 'net_14',
    estimates: true,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'usual',
  },
  Retail: {
    terms: 'due_on_receipt',
    estimates: false,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'few',
  },
  Community: {
    terms: 'due_on_receipt',
    estimates: false,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'few',
  },
  'Something else': {
    terms: 'net_14',
    estimates: true,
    estimateDays: 14,
    deposit: 'none',
    depositPercent: 25,
    reminders: 'usual',
  },
};

/** 825 → "8.25", 800 → "8". */
export function paymentsRateText(bp: number): string {
  const value = bp / 100;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** "8.25" or "8.25%" → 825; null for anything that isn't a share up to `max` basis points. */
export function paymentsRateOf(text: string, max: number): number | null {
  const cleaned = text.replace(/[%\s,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const bp = Math.round(Number(cleaned) * 100);
  return bp > max ? null : bp;
}

/** "$500" → 50000; null for nothing, nonsense or zero. */
export function paymentsCentsOf(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return cents > 0 && cents <= 100_000_000_00 ? cents : null;
}

/** Which of the reminder schedules a business's own settings are, or `own` when they are none of them. */
export function paymentsRemindersOf(s: MoneySettings): PaymentsSetupReminders {
  for (const kind of ['usual', 'few', 'none'] as const) {
    const r = remindersFor(kind, s.terms);
    if (
      same(r.beforeDueDays, s.reminders.beforeDueDays) &&
      r.onDue === s.reminders.onDue &&
      same(r.afterDueDays, s.reminders.afterDueDays)
    )
      return kind;
  }
  return 'own';
}

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length &&
  [...a].sort((x, y) => x - y).every((n, i) => n === [...b].sort((x, y) => x - y)[i]);

/**
 * A schedule's days. A reminder before the due date only when there is time for one: on "Right away" terms it would
 * land before the invoice does.
 */
function remindersFor(
  kind: 'usual' | 'few' | 'none',
  terms: PaymentTerms,
): { beforeDueDays: number[]; onDue: boolean; afterDueDays: number[] } {
  if (kind === 'none') return { beforeDueDays: [], onDue: false, afterDueDays: [] };
  if (kind === 'few') return { beforeDueDays: [], onDue: true, afterDueDays: [7] };
  return {
    beforeDueDays: TERMS_DAYS[terms] > 3 ? [3] : [],
    onDue: true,
    afterDueDays: [3, 7, 14],
  };
}

/** The answers the business's own saved settings give. */
export function paymentsSetupAnswersFromSettings(
  s: MoneySettings,
  setupAddress: string | null,
  where: PaymentsSetupWhere = 'stripe',
): PaymentsSetupAnswers {
  const estimates = s.deposit.kind !== 'none' || s.reminders.estimateAfterDays !== null;
  return {
    where,
    bankTransfer: s.bankTransfer,
    venmo: s.venmo,
    payLater: s.payLater,
    tax: s.tax.rateBp > 0 ? 'yes' : 'no',
    taxRate: s.tax.rateBp > 0 ? paymentsRateText(s.tax.rateBp) : '',
    taxName: s.tax.name,
    newTaxable: s.tax.newProductsTaxable,
    terms: s.terms,
    estimates,
    estimateDays: String(s.estimateGoodForDays),
    deposit: s.deposit.kind,
    depositPercent: paymentsRateText(s.deposit.percentBp),
    depositAmount: s.deposit.amountCents > 0 ? money(s.deposit.amountCents) : '',
    reminders: paymentsRemindersOf(s),
    estimateNudge: s.reminders.estimateAfterDays !== null,
    address: s.businessAddress || setupAddress || '',
    invoicePrefix: s.numbering.invoice.prefix,
    invoiceNext: String(s.numbering.invoice.next),
    note: s.notes.invoice,
  };
}

/**
 * Where the answers start. A business that has saved money settings starts from them; one that hasn't, from what
 * its kind of business usually picks (P2), with the sales tax left for them to say.
 */
export function paymentsSetupStart(
  ctx: Pick<PaymentsSetupContext, 'settings' | 'setupAddress' | 'configured'>,
  industry: string | null | undefined,
): PaymentsSetupAnswers {
  const now = paymentsSetupAnswersFromSettings(ctx.settings, ctx.setupAddress);
  if (ctx.configured) return now;
  const usual = USUAL[findIndustry(industry)?.group ?? 'Something else'];
  return {
    ...now,
    tax: null,
    taxRate: '',
    terms: usual.terms,
    estimates: usual.estimates,
    estimateDays: String(usual.estimateDays),
    deposit: usual.estimates ? usual.deposit : 'none',
    depositPercent: String(usual.depositPercent),
    reminders: usual.reminders,
    estimateNudge: usual.estimates,
  };
}

/** The kind of business the starting answers came from, for the line under the answers so far ("Roofing"). */
export function paymentsSetupUsualFor(
  ctx: Pick<PaymentsSetupContext, 'configured'>,
  industry: string | null | undefined,
): string | null {
  if (ctx.configured) return null;
  const kind = findIndustry(industry);
  return kind && kind.group !== 'Something else' ? kind.label : null;
}

/** Saved answers read back over where they start, a field at a time: one that no longer fits is left at its start. */
export function paymentsSetupAnswersOf(
  raw: unknown,
  start: PaymentsSetupAnswers,
): PaymentsSetupAnswers {
  const from = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...start };
  for (const [key, schema] of Object.entries(PaymentsSetupAnswers.shape)) {
    const got = (schema as z.ZodType).safeParse(from[key]);
    if (got.success) out[key] = got.data;
  }
  return out as PaymentsSetupAnswers;
}

// ---------- which questions ----------

/** The provider a path pays into: the one picked, or the one connected. Null for Not now. */
export function paymentsSetupProvider(
  a: Pick<PaymentsSetupAnswers, 'where'>,
  ctx: Pick<PaymentsSetupContext, 'mode' | 'account'>,
): ConnectableProvider | null {
  if (ctx.mode === 'again') return ctx.account?.provider ?? null;
  return a.where === 'later' ? null : a.where;
}

/**
 * The questions a path asks, in order. The first only while there's no account; ways to pay only when there's an
 * account to pay into (Not now has nothing online to offer).
 */
export function paymentsSetupQuestions(
  a: PaymentsSetupAnswers,
  ctx: Pick<PaymentsSetupContext, 'mode' | 'account'>,
): PaymentsSetupQuestion[] {
  return PAYMENTS_SETUP_QUESTIONS.filter((q) => {
    if (q === 'where') return ctx.mode === 'new';
    if (q === 'ways') return paymentsSetupProvider(a, ctx) !== null;
    return true;
  });
}

// ---------- what is wrong ----------

export interface PaymentsSetupProblem {
  /** The answer's field. */
  readonly path: keyof PaymentsSetupAnswers;
  readonly message: string;
}

/** What stops Next on a question; empty when it can go on. */
export function paymentsSetupProblems(
  q: PaymentsSetupScreen,
  a: PaymentsSetupAnswers,
  ctx: Pick<PaymentsSetupContext, 'payPalOpen' | 'settings'>,
): PaymentsSetupProblem[] {
  const P = PAYMENTS_SETUP_WORDS.problems;
  const out: PaymentsSetupProblem[] = [];
  switch (q) {
    case 'where':
      if (a.where === 'paypal' && !ctx.payPalOpen)
        out.push({ path: 'where', message: P.payPalSoon });
      break;
    case 'tax':
      if (a.tax === null) out.push({ path: 'tax', message: P.tax });
      else if (a.tax === 'yes') {
        const bp = paymentsRateOf(a.taxRate, 2_000);
        if (bp === null || bp === 0) out.push({ path: 'taxRate', message: P.taxRate });
        if (!a.taxName.trim()) out.push({ path: 'taxName', message: P.taxName });
      }
      break;
    case 'estimates':
      if (a.estimates) {
        const days = Number(a.estimateDays);
        if (!/^\d+$/.test(a.estimateDays.trim()) || days < 1 || days > 365)
          out.push({ path: 'estimateDays', message: P.estimateDays });
        if (a.deposit === 'percent') {
          const bp = paymentsRateOf(a.depositPercent, 10_000);
          if (bp === null || bp === 0)
            out.push({ path: 'depositPercent', message: P.depositPercent });
        }
        if (a.deposit === 'amount' && paymentsCentsOf(a.depositAmount) === null)
          out.push({ path: 'depositAmount', message: P.depositAmount });
      }
      break;
    case 'documents': {
      const address = a.address.trim();
      if (address.length > 300) out.push({ path: 'address', message: P.addressLong });
      else if (address.split('\n').length > 5)
        out.push({ path: 'address', message: P.addressLines });
      const prefix = prefixProblem(a.invoicePrefix);
      if (prefix) out.push({ path: 'invoicePrefix', message: prefix });
      const typed = a.invoiceNext.trim();
      const next = /^\d+$/.test(typed) ? Number(typed) : Number.NaN;
      const number = nextNumberProblem(ctx.settings.numbering.invoice.next, next);
      if (number) out.push({ path: 'invoiceNext', message: number });
      if (a.note.trim().length > 2_000) out.push({ path: 'note', message: P.note });
      break;
    }
    case 'ways':
    case 'due':
    case 'reminders':
    case 'review':
      break;
  }
  return out;
}

/** The first question on this path with something wrong, for Check it over's Save; null when all is well. */
export function paymentsSetupFirstProblem(
  a: PaymentsSetupAnswers,
  ctx: Pick<PaymentsSetupContext, 'mode' | 'account' | 'payPalOpen' | 'settings'>,
): PaymentsSetupQuestion | null {
  return (
    paymentsSetupQuestions(a, ctx).find((q) => paymentsSetupProblems(q, a, ctx).length > 0) ?? null
  );
}

// ---------- what Save writes ----------

/**
 * The settings Save writes: the business's own, with these answers over them. What the setup doesn't ask (the
 * estimates' numbering and note, number padding) stays as it is, and so does whatever an answer doesn't touch:
 * a business that keeps its own reminders keeps them, a deposit figure is kept when no deposit is asked for.
 */
export function paymentsSetupSettings(
  current: MoneySettings,
  a: PaymentsSetupAnswers,
): MoneySettings {
  const reminders =
    a.reminders === 'own'
      ? current.reminders
      : { ...current.reminders, ...remindersFor(a.reminders, a.terms) };
  const percentBp = paymentsRateOf(a.depositPercent, 10_000);
  const amountCents = paymentsCentsOf(a.depositAmount);
  const days = Number(a.estimateDays);
  const rateBp = a.tax === 'yes' ? (paymentsRateOf(a.taxRate, 2_000) ?? current.tax.rateBp) : 0;
  const next = Number(a.invoiceNext);
  return {
    ...current,
    bankTransfer: a.bankTransfer,
    venmo: a.venmo,
    payLater: a.payLater,
    tax: {
      rateBp,
      name: a.taxName.trim() || current.tax.name,
      newProductsTaxable: a.newTaxable,
    },
    terms: a.terms,
    estimateGoodForDays:
      a.estimates && Number.isInteger(days) && days >= 1 && days <= 365
        ? days
        : current.estimateGoodForDays,
    deposit: {
      kind: a.estimates ? a.deposit : 'none',
      percentBp: percentBp && percentBp > 0 ? percentBp : current.deposit.percentBp,
      amountCents: amountCents ?? current.deposit.amountCents,
    },
    reminders: {
      ...reminders,
      estimateAfterDays:
        a.estimates && a.estimateNudge ? (current.reminders.estimateAfterDays ?? 3) : null,
    },
    businessAddress: a.address.trim(),
    numbering: {
      ...current.numbering,
      invoice: {
        ...current.numbering.invoice,
        prefix: a.invoicePrefix.trim(),
        next: Number.isInteger(next) && next >= 1 ? next : current.numbering.invoice.next,
      },
    },
    notes: { ...current.notes, invoice: a.note.trim() },
  };
}

// ---------- the lines ----------

/** "3 days before, on the day, then 3, 7 and 14 days late". */
export function paymentsRemindersSummary(
  r: Pick<MoneySettings['reminders'], 'beforeDueDays' | 'onDue' | 'afterDueDays'>,
): string {
  const parts: string[] = [];
  const before = [...r.beforeDueDays].sort((x, y) => y - x);
  if (before.length)
    parts.push(
      `${listOf(before)} ${before.length === 1 && before[0] === 1 ? 'day' : 'days'} before`,
    );
  if (r.onDue) parts.push('on the day');
  const after = [...r.afterDueDays].sort((x, y) => x - y);
  if (after.length)
    parts.push(
      `${parts.length ? 'then ' : ''}${listOf(after)} ${after.length === 1 && after[0] === 1 ? 'day' : 'days'} late`,
    );
  return parts.length ? sentence(parts.join(', ')) : PAYMENTS_SETUP_WORDS.reminders.noneLine;
}

const listOf = (ns: readonly number[]) =>
  ns.length <= 1 ? String(ns[0] ?? '') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The reminder days a schedule sends, as chips: "3 days before", "On the day", "7 days late". */
export function paymentsReminderChips(
  kind: PaymentsSetupReminders,
  terms: PaymentTerms,
  own: MoneySettings['reminders'],
): string[] {
  const r = kind === 'own' ? own : remindersFor(kind, terms);
  const day = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
  return [
    ...[...r.beforeDueDays].sort((x, y) => y - x).map((n) => `${day(n)} before`),
    ...(r.onDue ? ['On the day'] : []),
    ...[...r.afterDueDays].sort((x, y) => x - y).map((n) => `${day(n)} late`),
  ];
}

export interface PaymentsSetupLine {
  readonly key: PaymentsSetupQuestion;
  readonly label: string;
  /** What was answered; null while the question hasn't been answered yet. */
  readonly value: string | null;
}

/** One line a question, for the list beside the questions, Check it over and Settings → Payments. */
export function paymentsSetupLines(
  a: PaymentsSetupAnswers,
  ctx: Pick<PaymentsSetupContext, 'mode' | 'account' | 'settings'>,
): PaymentsSetupLine[] {
  const W = PAYMENTS_SETUP_WORDS.lines;
  const provider = paymentsSetupProvider(a, ctx);
  const name = provider ? PAYMENT_PROVIDER_NAMES[provider] : null;
  const rate = paymentsRateOf(a.taxRate, 2_000);
  const pct = paymentsRateOf(a.depositPercent, 10_000);
  const cents = paymentsCentsOf(a.depositAmount);
  const deposit =
    a.deposit === 'percent' && pct
      ? W.depositShare(paymentsRateText(pct))
      : a.deposit === 'amount' && cents
        ? W.depositAmount(money(cents))
        : W.noDeposit;
  const remind = paymentsRemindersSummary(
    a.reminders === 'own' ? ctx.settings.reminders : remindersFor(a.reminders, a.terms),
  );
  const next = /^\d+$/.test(a.invoiceNext.trim()) ? Number(a.invoiceNext) : null;
  const all: PaymentsSetupLine[] = [
    {
      key: 'where',
      label: W.where,
      value: name
        ? ctx.mode === 'again'
          ? W.connected(name)
          : name
        : PAYMENTS_SETUP_WORDS.where.later.title,
    },
    {
      key: 'ways',
      label: W.ways,
      value: W.waysValue(
        provider === 'paypal' ? W.payPalWays(a.venmo, a.payLater) : W.cardWays(a.bankTransfer),
      ),
    },
    {
      key: 'tax',
      label: W.tax,
      value:
        a.tax === null
          ? null
          : a.tax === 'no'
            ? W.noTax
            : W.taxed(
                rate ? paymentsRateText(rate) : a.taxRate.trim(),
                a.taxName.trim(),
                a.newTaxable,
              ),
    },
    { key: 'due', label: W.due, value: W.dueValue[a.terms] },
    {
      key: 'estimates',
      label: W.estimates,
      value: a.estimates ? W.estimatesYes(a.estimateDays.trim(), deposit) : W.estimatesNo,
    },
    {
      key: 'reminders',
      label: W.reminders,
      value: a.estimates && a.estimateNudge ? W.withNudge(remind) : remind,
    },
    {
      key: 'documents',
      label: W.documents,
      value: W.documentsValue(
        paymentsShortAddress(a.address),
        next
          ? numberPreview({
              ...ctx.settings.numbering.invoice,
              prefix: a.invoicePrefix.trim(),
              next,
            })
          : null,
        a.note.trim(),
      ),
    },
  ];
  const asked = new Set(paymentsSetupQuestions(a, ctx));
  return all.filter((l) => asked.has(l.key) || (l.key === 'where' && ctx.mode === 'again'));
}

/** "2210 Oak St, Houston" from the address lines: the street, then the town. Null for none. */
export function paymentsShortAddress(text: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? null;
  const town = lines[lines.length - 1]!.split(',')[0]!.trim();
  return town ? `${lines[0]}, ${town}` : lines[0]!;
}

// ---------- words ----------

const DUE: Readonly<Record<PaymentTerms, { readonly title: string; readonly hint: string }>> = {
  due_on_receipt: {
    title: 'Right away',
    hint: 'Due the day it’s sent. Good when you’re paid on the spot.',
  },
  net_7: { title: 'Within 7 days', hint: 'A week to pay.' },
  net_14: { title: 'Within 14 days', hint: 'Two weeks to pay.' },
  net_30: { title: 'Within 30 days', hint: 'A month, for businesses that bill other businesses.' },
};

/** Everything the payments setup says, on the web and the phone. */
export const PAYMENTS_SETUP_WORDS = {
  pageTitle: 'Set up payments',
  settingUp: (business: string) => `Setting up payments for ${business}`,
  soFar: 'Your payments so far',
  usualFor: (kind: string) =>
    `Started from what ${kind.toLowerCase()} businesses usually pick. Change anything.`,
  kicker: (at: number, of: number) => `Question ${at} of ${of}`,
  notAllowed: 'Only someone who can change the business’s payments can set them up.',
  notAllowedHint: 'Ask an owner of this business.',
  welcomeBack: (name: string | null, when: string) =>
    `Welcome back${name ? `, ${name}` : ''}. Your answers from ${when} are still here.`,

  where: {
    title: 'Where should customer payments go?',
    hint: PAYMENTS_PAGE_WORDS.accounts,
    stripe: {
      title: 'Stripe',
      badge: 'Card and bank transfer',
      hint: 'Customers pay by card, Apple Pay, Google Pay or bank transfer. No Stripe account yet? You make one when you sign in.',
    },
    square: {
      title: 'Square',
      hint: 'Good if you already take Square at the counter. Invoice payments land in the same place.',
    },
    paypal: {
      title: 'PayPal',
      hint: 'Customers pay with PayPal or a card through PayPal, and you can add Venmo and Pay Later.',
      soon: 'Coming soon',
      soonHint: 'PayPal, Venmo and Pay Later. You can pick it here once it’s open to everyone.',
    },
    later: {
      title: 'Not now',
      hint: 'Invoices still go out, without a Pay button. You mark cash and cheques paid by hand.',
    },
    note: (provider: string) =>
      `You sign in to ${provider} at the end, after you check everything over. Nothing changes before then.`,
    noteLater: 'You can connect an account any time from Settings → Payments.',
    skip: 'Skip, I’ll do it in Settings',
  },

  ways: {
    title: 'What can customers pay with?',
    hint: 'This is what they see on their invoice page, in this order.',
    bankTransfer: {
      title: 'Bank transfer',
      badge: 'Cheapest',
      hint: PAYMENTS_PAGE_WORDS.bankTransfer,
    },
    card: {
      title: 'Card',
      hint: 'Visa, Mastercard, Amex, Apple Pay and Google Pay. The money is there at once.',
      on: 'Always on',
    },
    payPal: { title: 'PayPal', hint: PAYMENTS_PAGE_WORDS.payPal },
    venmo: { title: 'Venmo', hint: PAYMENTS_PAGE_WORDS.venmo },
    payLater: { title: 'Pay Later', hint: PAYMENTS_PAGE_WORDS.payLater },
    cash: {
      title: 'Cash and cheque',
      hint: 'Not offered online. When one comes in, you mark the invoice paid.',
      on: 'By hand',
    },
    note: 'Nothing is ever added to what the customer owes for paying by card.',
  },

  tax: {
    title: 'Do you charge sales tax?',
    hint: 'One rate for the business. Each line on an estimate or invoice can still be taxed or not.',
    no: { title: 'No', hint: 'Estimates and invoices show no tax line.' },
    yes: { title: 'Yes', hint: 'It’s added to the lines you mark taxable.' },
    rate: 'Rate',
    name: 'What to call it on a document',
    newTaxable: 'New items start taxable',
    newTaxableHint: 'A new product or service is taxed unless you say otherwise.',
    note: 'Not sure of your rate? Your state’s tax office lists it by city. A document keeps the rate it was sent with.',
  },

  due: {
    title: 'When should customers pay an invoice?',
    hint: 'Counted from the day you send it. You can change it on any single invoice.',
    options: DUE,
    note: 'The reminders in the next questions count from this date.',
  },

  estimates: {
    title: 'Do you send estimates before the work?',
    hint: 'A price the customer says yes to first. It turns into the invoice when the job is done.',
    yes: { title: 'Yes', hint: 'The customer reads it, then says yes or no from their own page.' },
    no: {
      title: 'No, I just send invoices',
      hint: 'We skip estimates and deposits. You can still send one any time.',
    },
    goodFor: 'They stay good for',
    days: 'days',
    upFront: 'Do you ask for money up front before the work starts?',
    deposit: {
      none: 'Nothing up front',
      percent: 'A share of the total',
      amount: 'A set amount',
    } satisfies Record<PaymentsSetupDeposit, string>,
    percentAfter: '% of the total. They pay it when they say yes.',
    amountAfter: 'They pay it when they say yes.',
    note: 'A deposit to book a visit is set on each calendar, not here. You can change the deposit on any single estimate.',
  },

  reminders: {
    title: 'Should we remind customers who haven’t paid?',
    hint: 'A short, friendly message with the amount and the Pay link. It stops the moment they pay.',
    usual: {
      title: 'Yes, the usual',
      hint: 'After the last one it stops, and Home asks you what to do.',
      line: 'The usual reminders',
      most: (n: number) => `${n} reminders at most`,
    },
    few: {
      title: 'Just a nudge or two',
      hint: 'On the day it’s due, and once more 7 days later.',
      line: 'A nudge on the day and 7 days later',
    },
    none: {
      title: 'No, I’ll follow up myself',
      hint: 'Nothing goes out on its own. Home still shows you who’s late.',
      line: 'No reminders',
    },
    own: { title: 'Keep my own schedule', line: '' },
    noneLine: 'No reminders',
    nudge: 'Nudge an estimate nobody answers',
    nudgeHint: (days: number) => `Once, ${days} ${days === 1 ? 'day' : 'days'} after it goes out.`,
    note: 'They go by text if the customer agreed to texts, otherwise by email, and never during quiet hours.',
  },

  documents: {
    title: 'What goes on every invoice?',
    hint: 'Estimates get the same. We filled in what we know, so check it reads right.',
    address: 'Your address',
    addressHint: 'It shows at the top, exactly as written here. Five lines at most.',
    addressFromSetup: 'From your setup. It shows at the top, exactly as written here.',
    numbers: 'Invoice numbers',
    startWith: 'Start with',
    nextNumber: 'Next number',
    preview: 'The next one will be',
    numbersHint: (estimates: string | null) =>
      `Moving from another app? Carry on from your last number there.${estimates ? ` Estimates start at ${estimates}.` : ''}`,
    note: 'Note at the bottom',
    noteHint: 'You can change it on a single invoice while you write it.',
  },

  lines: {
    where: 'Where money goes',
    ways: 'Ways to pay',
    tax: 'Sales tax',
    due: 'When invoices are due',
    estimates: 'Estimates and deposits',
    reminders: 'Reminders',
    documents: 'On every invoice',
    connected: (provider: string) => `${provider}, connected`,
    cardWays: (bank: boolean) => (bank ? 'Bank transfer first, then card' : 'Card'),
    payPalWays: (venmo: boolean, payLater: boolean) =>
      ['PayPal', 'card', venmo ? 'Venmo' : null, payLater ? 'Pay Later' : null]
        .filter(Boolean)
        .join(', '),
    waysValue: (online: string) => `${online}. Cash and cheques by hand.`,
    noTax: 'No sales tax',
    taxed: (rate: string, name: string, newTaxable: boolean) =>
      `${rate}%, called “${name || 'Sales tax'}”. New items start ${newTaxable ? 'taxable' : 'not taxed'}.`,
    dueValue: {
      due_on_receipt: 'The day it’s sent',
      net_7: 'Within 7 days of sending',
      net_14: 'Within 14 days of sending',
      net_30: 'Within 30 days of sending',
    } satisfies Record<PaymentTerms, string>,
    estimatesYes: (days: string, deposit: string) => `Good for ${days} days. ${deposit}.`,
    estimatesNo: 'No estimates, just invoices',
    depositShare: (pct: string) => `${pct}% up front when they say yes`,
    depositAmount: (amount: string) => `${amount} up front when they say yes`,
    noDeposit: 'Nothing up front',
    withNudge: (reminders: string) => `${reminders}. One nudge on an unanswered estimate.`,
    documentsValue: (where: string | null, number: string | null, note: string) =>
      [
        where ?? 'No address',
        number ? `Next number ${number}` : null,
        note ? `“${note.length > 32 ? `${note.slice(0, 30).trimEnd()}…` : note}”` : null,
      ]
        .filter(Boolean)
        .join('. '),
  },

  review: {
    kicker: 'Check it over',
    title: 'Here’s how you’ll get paid',
    hint: 'Nothing changes until you press the button at the bottom.',
    change: 'Change',
    already: 'Already set for you',
    alreadyAccess: 'Everyone who can bill in your business can use the account.',
    alreadyEstimateNote: (note: string) => `Estimates end with “${note}”`,
    alreadyEstimateNumbers: (first: string) => `Estimates are numbered from ${first}.`,
    alreadyLater: 'You can change these later under Settings → Payments → All settings.',
    next: 'What happens next',
    nextSave: 'We save your answers. New estimates and invoices use them straight away.',
    nextSignIn: (provider: string) =>
      `You sign in to ${provider}. No account yet? ${provider} makes one with you. It asks for your bank and a few details about the business.`,
    nextBack: (provider: string) =>
      `You come back here. ${provider} checks your account, which can take a day or two. The Pay button shows on invoices once it’s done.`,
    nextLater:
      'Invoices go out without a Pay button until you connect an account in Settings → Payments.',
    connect: (provider: string) => `Save and connect ${provider}`,
    save: 'Save my answers',
    saved: 'Saved. New estimates and invoices use your answers.',
    accountHere: (provider: string) =>
      `${provider} stays as it is. Manage it in Settings → Payments.`,
  },

  done: {
    title: 'You’re set up to get paid',
    hint: 'Your estimates and invoices use your answers from now on.',
    checking: (provider: string) => `${provider} is checking your account`,
    checkingHint: (provider: string) =>
      `That can take a day or two. You can send estimates and invoices now. The Pay button shows on them once ${provider} is done.`,
    ready: (provider: string) => `${provider} is connected`,
    readyHint: 'Customers can pay from the link on every invoice.',
    notConnected: (provider: string) => `${provider} isn’t connected yet`,
    notConnectedHint:
      'Your answers are saved. Connect the account to put a Pay button on invoices.',
    connect: (provider: string) => `Connect ${provider}`,
    later: 'No account connected',
    laterHint:
      'Invoices go out without a Pay button. Connect an account any time in Settings → Payments.',
    nextTitle: 'What to do next',
    prices: {
      title: 'Add your services and prices',
      hint: 'Pick them from a list when you write an estimate.',
    },
    estimate: {
      title: 'Send your first estimate',
      hint: 'Try it on yourself first to see what customers see.',
    },
    invoice: {
      title: 'Send your first invoice',
      hint: 'Try it on yourself first to see what customers see.',
    },
    bookingDeposit: {
      title: 'Take a deposit when they book',
      hint: 'Set on each calendar, so no-shows cost you less.',
    },
    close: 'Back to Getting started',
    toSettings: 'Back to Settings',
    chips: {
      bankAndCard: 'Bank transfer and card',
      card: 'Card',
      payPal: 'PayPal and card',
      tax: (rate: string) => `${rate}% sales tax`,
      noTax: 'No sales tax',
      due: {
        due_on_receipt: 'Due right away',
        net_7: 'Due in 7 days',
        net_14: 'Due in 14 days',
        net_30: 'Due in 30 days',
      } satisfies Record<PaymentTerms, string>,
      deposit: (what: string) => `${what} deposit`,
      reminders: 'Reminders on',
      noReminders: 'No reminders',
    },
  },

  summary: {
    title: 'Your answers',
    again: 'Go through the questions again',
    allSettings: 'All settings',
    hideAll: 'Hide all settings',
    setUp: 'Set up payments',
    setUpHint:
      'Seven quick questions, then connect Stripe or Square so customers can pay from your invoices.',
    start: 'Start',
    resume: 'Pick up where you left off',
    howPaid: (business: string) => `How ${business} gets paid.`,
    account: {
      ready: 'Connected',
      checking: 'Checking',
      broken: 'Sign in again',
      readyHint: 'Customers pay from the link on every invoice.',
      checkingHint: (provider: string) =>
        `${provider} is checking your account. Invoices get a Pay button once it’s done.`,
      brokenHint: (provider: string) =>
        `${provider} needs you to sign in again before customers can pay. Open All settings to do it.`,
      manage: 'Manage',
    },
    under: 'Under All settings',
    underHint:
      'A second account, who can use each account, PayPal’s Venmo and Pay Later, estimate numbers and their note, invoice reminders day by day, and your price list. Nothing from before is taken away.',
    fix: 'Something here needs fixing. It’s at the top of All settings.',
  },

  problems: {
    payPalSoon: 'PayPal isn’t open yet. Pick Stripe or Square, or Not now.',
    tax: 'Pick yes or no.',
    taxRate: 'Use a rate like 8.25, up to 20.',
    taxName: 'Name the tax, like Sales tax.',
    estimateDays: 'Use a whole number of days, 1 to 365.',
    depositPercent: 'Use a share like 25, up to 100.',
    depositAmount: 'Use an amount like $500.',
    addressLong: 'Keep it under 300 characters.',
    addressLines: 'Five lines at most.',
    note: 'Keep it under 2,000 characters.',
  },
} as const;

/**
 * Whether a business has saved money settings of its own: anything but every default. Until it has, the answers
 * start from what its kind of business usually picks (P2).
 */
export function paymentsSettingsConfigured(s: MoneySettings): boolean {
  return !sameValue(s, defaultMoneySettings());
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameValue(x, b[i]))
    );
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/** The Done screen's chips, from the settings as saved: "Bank transfer and card", "8.25% sales tax", "Due in 14 days". */
export function paymentsDoneChips(
  s: MoneySettings,
  provider: ConnectableProvider | null,
): string[] {
  const C = PAYMENTS_SETUP_WORDS.done.chips;
  const reminders =
    s.reminders.beforeDueDays.length + s.reminders.afterDueDays.length > 0 || s.reminders.onDue;
  return [
    provider === 'paypal' ? C.payPal : provider ? (s.bankTransfer ? C.bankAndCard : C.card) : null,
    s.tax.rateBp > 0 ? C.tax(paymentsRateText(s.tax.rateBp)) : C.noTax,
    C.due[s.terms],
    s.deposit.kind === 'percent'
      ? C.deposit(`${paymentsRateText(s.deposit.percentBp)}%`)
      : s.deposit.kind === 'amount'
        ? C.deposit(money(s.deposit.amountCents))
        : null,
    reminders ? C.reminders : C.noReminders,
  ].filter((x): x is string => !!x);
}
