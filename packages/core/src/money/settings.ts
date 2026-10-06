/**
 * The money settings document, `workspaces.settings.money`: the sales tax and what it's called, invoice and
 * estimate numbering, payment terms and notes, how long an estimate stays good, the deposit a business asks for,
 * whether bank transfer is offered, and when reminders go out.
 *
 * Browser-safe: Settings validates with the same schema the server saves with, and every reader falls back field
 * by field, so old or partial settings (or none at all) still work.
 *
 * Numbering is mirrored by the save command into `app.document_counters` (one row per business and kind), the
 * way the calendar's settings mirror `team.members` into `calendar_members`. The counter row is the authority
 * while a document is being sent: it's locked and incremented inside that transaction.
 *
 * Settings never lock each other out. When two of them fight, `checkMoneySettings` explains it in a short
 * sentence and offers fixes as settings patches, the way the calendar's rules do.
 */
import { z } from 'zod';
import { mergePatch } from '../calendar/config';
import { addDays } from '../calendar/engine/zoned';
import { readForgiving } from '../schemas/forgiving';
import {
  NUMBER_MAX,
  NUMBER_MIN,
  NUMBER_PAD_MAX,
  NUMBER_PAD_MIN,
  NUMBER_PREFIX_MAX,
  prefixProblem,
  type DocumentNumbering,
} from './numbering';
import { BASIS_POINTS, type DepositTerms } from './totals';

const MAX_CENTS = 100_000_000_00;

/** At most 20%: higher than any US state and local rate put together, and a typo guard. */
export const MAX_TAX_RATE_BP = 2_000;

export const PAYMENT_TERMS = ['due_on_receipt', 'net_7', 'net_14', 'net_30'] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

/** How many days after it's issued an invoice is due. */
export const TERMS_DAYS: Readonly<Record<PaymentTerms, number>> = {
  due_on_receipt: 0,
  net_7: 7,
  net_14: 14,
  net_30: 30,
};

/** The day an invoice issued on `issuedDate` (a local date) is due. */
export function dueDateFor(terms: PaymentTerms, issuedDate: string): string {
  return addDays(issuedDate, TERMS_DAYS[terms]);
}

const Tax = z.object({
  /** In basis points: 825 is 8.25%. One rate per business, each line marked taxable or not. */
  rateBp: z.int().min(0).max(MAX_TAX_RATE_BP, 'At most 20%.').default(0),
  /** What it's called on a document: "Sales tax", "GST", "Tax". */
  name: z
    .string()
    .trim()
    .min(1, 'Name the tax.')
    .max(40, 'Keep it under 40 characters.')
    .default('Sales tax'),
  /** A new product or service starts taxable. */
  newProductsTaxable: z.boolean().default(true),
});

const numbering = (fallbackPrefix: string) =>
  z.object({
    prefix: z
      .string()
      .trim()
      .max(NUMBER_PREFIX_MAX, `Keep the prefix under ${NUMBER_PREFIX_MAX + 1} characters.`)
      .refine((p) => prefixProblem(p) === null, {
        error: 'A prefix can have letters, numbers and hyphens.',
      })
      .default(fallbackPrefix),
    /** The next number to be used. It only moves forward: see `nextNumberProblem`. */
    next: z
      .int()
      .min(NUMBER_MIN, 'At least 1.')
      .max(NUMBER_MAX, 'That number is too long.')
      .default(1001),
    pad: z.int().min(NUMBER_PAD_MIN).max(NUMBER_PAD_MAX).default(4),
  });

const Numbering = z.object({
  estimate: numbering('EST-').prefault({}),
  invoice: numbering('INV-').prefault({}),
});

const Deposit = z.object({
  kind: z.enum(['none', 'percent', 'amount']).default('none'),
  /** For 'percent', in basis points: 2,500 is 25%. Kept when the kind changes, so the figure isn't lost. */
  percentBp: z.int().min(0).max(BASIS_POINTS, 'At most 100%.').default(2_500),
  /** For 'amount', in cents. */
  amountCents: z.int().min(0).max(MAX_CENTS).default(0),
});

const Notes = z.object({
  estimate: z
    .string()
    .trim()
    .max(2_000, 'Keep it under 2,000 characters.')
    .default('Thanks for the opportunity. Call or text us with any questions.'),
  invoice: z
    .string()
    .trim()
    .max(2_000, 'Keep it under 2,000 characters.')
    .default('Thank you for your business.'),
});

const reminderDays = z.int().min(1, 'At least 1 day.').max(90, 'At most 90 days.');

const Reminders = z.object({
  /**
   * Days before the due date a reminder goes out. One, three days out: with Net 14 that's a nudge in the second
   * week, while there's still time to pay without anyone being late. A business on due-on-receipt terms should
   * empty this — `checkMoneySettings` says so, because the reminder would land before the invoice.
   */
  beforeDueDays: z
    .array(reminderDays)
    .max(3, 'At most three.')
    .default(() => [3]),
  /** One on the day it's due. */
  onDue: z.boolean().default(true),
  /** Days after the due date a reminder goes out. */
  afterDueDays: z
    .array(reminderDays)
    .max(4, 'At most four.')
    .default(() => [3, 7, 14]),
  /** One nudge this many days after an estimate goes out unanswered; null for none. */
  estimateAfterDays: reminderDays.nullable().default(3),
});

export const MoneySettings = z.object({
  /**
   * Where the business is, as they write it themselves — a few lines, exactly as it should read at the top of
   * an estimate or an invoice. Free text on purpose: a seller's address belongs on the document they send, and
   * nothing in HandsFreeOS has any business parsing it into a city and a state.
   */
  businessAddress: z
    .string()
    .trim()
    .max(300, 'Keep it under 300 characters.')
    .refine((a) => a.split('\n').length <= 5, { error: 'Five lines at most.' })
    .default(''),
  tax: Tax.prefault({}),
  numbering: Numbering.prefault({}),
  /** When an invoice is due, unless a document says otherwise. */
  terms: z.enum(PAYMENT_TERMS).default('net_14'),
  notes: Notes.prefault({}),
  /** How many days an estimate stays good after it's sent. */
  estimateGoodForDays: z.int().min(1, 'At least 1 day.').max(365, 'At most a year.').default(14),
  deposit: Deposit.prefault({}),
  /** Offer bank transfer on the customer's page. It's the cheap rail, so it leads. */
  bankTransfer: z.boolean().default(true),
  reminders: Reminders.prefault({}),
});
export type MoneySettings = z.infer<typeof MoneySettings>;
export type MoneySettingsInput = z.input<typeof MoneySettings>;

type Patch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: Patch<T[K]> }
    : T;
/** A partial money settings document: objects merge, arrays and null replace. */
export type MoneySettingsPatch = Patch<MoneySettingsInput>;

/** Every setting at its default. */
export function defaultMoneySettings(): MoneySettings {
  return MoneySettings.parse({});
}

/** Validates settings being saved, filling defaults. Throws a ZodError with Settings' messages when invalid. */
export function parseMoneySettings(raw: unknown): MoneySettings {
  return MoneySettings.parse(raw ?? {});
}

/** Reads stored settings forgivingly: anything that doesn't pass falls back to its default. Never throws. */
export function readMoneySettings(raw: unknown): MoneySettings {
  return readForgiving(MoneySettings, raw);
}

/** A business's money settings, from its workspace settings (like `openHoursOf`). */
export function moneySettingsOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): MoneySettings {
  return readMoneySettings(settings?.['money']);
}

/** Applies a fix's patch and validates the result. */
export function applyMoneyPatch(settings: MoneySettings, patch: MoneySettingsPatch): MoneySettings {
  return MoneySettings.parse(mergePatch(settings, patch));
}

/** One counter, as numbering works with it. */
export function numberingOf(
  settings: MoneySettings,
  kind: 'estimate' | 'invoice',
): DocumentNumbering {
  return settings.numbering[kind];
}

/** The deposit a new document starts with. */
export function defaultDeposit(settings: MoneySettings): DepositTerms {
  return settings.deposit;
}

export interface ReminderStep {
  readonly when: 'before' | 'on' | 'after';
  /** Days either side of the due date; 0 on the day itself. */
  readonly days: number;
}

/**
 * The reminders an invoice gets, earliest first: the before-due ones furthest out, then the due day, then the
 * after-due ones. Duplicates are dropped, so a schedule always fires once per moment.
 */
export function reminderSchedule(settings: MoneySettings): ReminderStep[] {
  const before = [...new Set(settings.reminders.beforeDueDays)].sort((a, b) => b - a);
  const after = [...new Set(settings.reminders.afterDueDays)].sort((a, b) => a - b);
  return [
    ...before.map((days) => ({ when: 'before' as const, days })),
    ...(settings.reminders.onDue ? [{ when: 'on' as const, days: 0 }] : []),
    ...after.map((days) => ({ when: 'after' as const, days })),
  ];
}

// ---- What fights with what ----

export const MONEY_ISSUE_CODES = [
  'no_business_address',
  'deposit_without_amount',
  'tax_without_taxable',
  'same_prefix',
  'no_reminders',
  'reminder_before_sending',
  'nudge_after_expiry',
] as const;
export type MoneyIssueCode = (typeof MONEY_ISSUE_CODES)[number];

export interface MoneyIssueFix {
  readonly id: string;
  readonly label: string;
  readonly patch: MoneySettingsPatch;
}

export interface MoneyIssue {
  readonly code: MoneyIssueCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Dotted settings paths the page highlights, e.g. 'deposit.kind'. */
  readonly fields: readonly string[];
  readonly fixes: readonly MoneyIssueFix[];
}

/**
 * What the settings document itself can't know. A business that has never sent anything is not doing anything
 * wrong by having no address on file yet, so the one check that depends on this stays quiet until it's passed.
 */
export interface MoneyFacts {
  /** Whether this business has ever sent an estimate or an invoice. */
  readonly hasSentDocuments?: boolean;
  /** The address the onboarding setup asked for, which documents carry while none is typed here. */
  readonly setupAddress?: string | null;
}

/** An error stops the settings being saved; a warning never does. */
export function hasBlockingMoneyIssues(issues: readonly MoneyIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

const NO_DEPOSIT_FIX: MoneyIssueFix = {
  id: 'deposit_off',
  label: 'No deposit',
  patch: { deposit: { kind: 'none' } },
};

/** Every conflict in a money settings document, in a stable order. */
export function checkMoneySettings(settings: MoneySettings, facts: MoneyFacts = {}): MoneyIssue[] {
  const issues: MoneyIssue[] = [];
  const { tax, deposit, numbering: numbers, reminders } = settings;

  // A warning, never an error: documents go out perfectly well without it, and stopping a save over it would
  // be worse than the gap. It waits until they have actually sent something, so a business setting itself up
  // is never told off for a field it hasn't reached yet, and the setup's address is on documents meanwhile.
  if (
    facts.hasSentDocuments === true &&
    !settings.businessAddress.trim() &&
    !facts.setupAddress?.trim()
  )
    issues.push({
      code: 'no_business_address',
      severity: 'warning',
      message: 'Estimates and invoices go out without your address on them',
      fields: ['businessAddress'],
      fixes: [],
    });

  if (deposit.kind === 'percent' && deposit.percentBp <= 0)
    issues.push({
      code: 'deposit_without_amount',
      severity: 'error',
      message: 'The deposit is set to a percentage of 0%',
      fields: ['deposit.kind', 'deposit.percentBp'],
      fixes: [
        { id: 'deposit_quarter', label: 'Ask for 25%', patch: { deposit: { percentBp: 2_500 } } },
        NO_DEPOSIT_FIX,
      ],
    });

  if (deposit.kind === 'amount' && deposit.amountCents <= 0)
    issues.push({
      code: 'deposit_without_amount',
      severity: 'error',
      message: 'The deposit is set to an amount of $0',
      fields: ['deposit.kind', 'deposit.amountCents'],
      fixes: [
        {
          id: 'deposit_percent',
          label: 'Ask for 25% instead',
          patch: { deposit: { kind: 'percent', percentBp: 2_500 } },
        },
        NO_DEPOSIT_FIX,
      ],
    });

  // A 0% rate with taxable lines is fine and common (services aren't taxed in plenty of states): tax comes to
  // nothing and nobody is misled. A rate that's set and never applied is the one that quietly loses money.
  if (tax.rateBp > 0 && !tax.newProductsTaxable)
    issues.push({
      code: 'tax_without_taxable',
      severity: 'warning',
      message: `${tax.name} is set, but new items aren’t taxable`,
      fields: ['tax.newProductsTaxable', 'tax.rateBp'],
      fixes: [
        {
          id: 'make_taxable',
          label: 'New items are taxable',
          patch: { tax: { newProductsTaxable: true } },
        },
        { id: 'tax_off', label: 'Set the rate to 0%', patch: { tax: { rateBp: 0 } } },
      ],
    });

  const estimatePrefix = numbers.estimate.prefix.trim().toLowerCase();
  if (estimatePrefix === numbers.invoice.prefix.trim().toLowerCase())
    issues.push({
      code: 'same_prefix',
      severity: 'warning',
      message: 'Estimates and invoices are numbered the same way',
      fields: ['numbering.estimate.prefix', 'numbering.invoice.prefix'],
      fixes: [
        {
          id: 'estimate_prefix',
          label: 'Use EST- for estimates',
          patch: { numbering: { estimate: { prefix: 'EST-' } } },
        },
      ],
    });

  if (!reminders.beforeDueDays.length && !reminders.onDue && !reminders.afterDueDays.length)
    issues.push({
      code: 'no_reminders',
      severity: 'warning',
      message: 'Nobody is reminded about an unpaid invoice',
      fields: ['reminders.onDue', 'reminders.afterDueDays'],
      fixes: [
        {
          id: 'remind_on_due',
          label: 'Remind on the due date',
          patch: { reminders: { onDue: true } },
        },
      ],
    });

  const termDays = TERMS_DAYS[settings.terms];
  const tooEarly = reminders.beforeDueDays.filter((d) => d >= termDays);
  if (tooEarly.length) {
    const kept = reminders.beforeDueDays.filter((d) => d < termDays);
    const longer = PAYMENT_TERMS.find((t) => TERMS_DAYS[t] > Math.max(...tooEarly));
    issues.push({
      code: 'reminder_before_sending',
      severity: 'warning',
      message:
        termDays === 0
          ? 'Invoices are due on receipt, so a reminder before the due date never goes out'
          : `A reminder ${Math.max(...tooEarly)} days before the due date would go out before the invoice does`,
      fields: ['reminders.beforeDueDays', 'terms'],
      fixes: [
        {
          id: 'drop_early_reminders',
          label: kept.length ? 'Drop the early reminders' : 'Only remind from the due date',
          patch: { reminders: { beforeDueDays: kept } },
        },
        ...(longer
          ? [
              {
                id: 'longer_terms',
                label: `Give them ${TERMS_DAYS[longer]} days to pay`,
                patch: { terms: longer } satisfies MoneySettingsPatch,
              },
            ]
          : []),
      ],
    });
  }

  const nudge = reminders.estimateAfterDays;
  if (nudge !== null && nudge >= settings.estimateGoodForDays)
    issues.push({
      code: 'nudge_after_expiry',
      severity: 'warning',
      message: `The estimate nudge would go out after the estimate stops being good (${settings.estimateGoodForDays} days)`,
      fields: ['reminders.estimateAfterDays', 'estimateGoodForDays'],
      fixes: [
        ...(settings.estimateGoodForDays > 3
          ? [
              {
                id: 'nudge_sooner',
                label: 'Nudge after 3 days',
                patch: { reminders: { estimateAfterDays: 3 } } satisfies MoneySettingsPatch,
              },
            ]
          : []),
        {
          id: 'nudge_off',
          label: 'Don’t nudge',
          patch: { reminders: { estimateAfterDays: null } },
        },
      ],
    });

  const order = new Map(MONEY_ISSUE_CODES.map((c, i) => [c, i]));
  return issues.sort((a, b) => (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0));
}
