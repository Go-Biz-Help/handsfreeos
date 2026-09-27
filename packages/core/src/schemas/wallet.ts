/**
 * What goes in and out of the usage wallet's commands (M16, step 5).
 *
 * The line running through all of this: **a person owns four settings and nothing else.** The balance, the card
 * and where the top-up and decline ladders have got to are the worker's, written by `actors: ['system']`
 * commands and guarded in Postgres besides. A schema that let a person post a balance would be a schema the
 * database refuses, which is a confusing way to find out.
 */
import { z } from 'zod';
import { uuid } from './common';

/** Every command here names the business it acts on, as every other workspace command does. */
const inWorkspace = { workspaceId: uuid };

/** Money a person may type. A dollar is the floor for a top-up; a million is past any honest mistake. */
const cents = (min: number, max: number) => z.int().min(min).max(max);

export const WalletSettingsInput = z.strictObject({
  ...inWorkspace,
  /** Below `floorCents`, the wallet charges the card on file. Off means it simply runs down. */
  autoTopup: z.boolean().optional(),
  floorCents: cents(0, 100_000_000).optional(),
  topupCents: cents(500, 100_000_000).optional(),
  /**
   * How far under zero inbound usage may push the balance before outbound starts degrading. None at `enforce`:
   * the gate reads it as zero there, and `wallet.set_auto_topup` refuses a non-zero one.
   */
  overdraftCents: cents(0, 10_000_000).optional(),
});

export const WalletRefOutput = z.strictObject({
  workspaceId: uuid,
  balanceCents: z.int(),
  autoTopup: z.boolean(),
  floorCents: z.int(),
  topupCents: z.int(),
  overdraftCents: z.int(),
  hasCard: z.boolean(),
  suspended: z.boolean(),
});

export const WalletRequestCardInput = z.strictObject({ ...inWorkspace });

export const WalletCardOutput = z.strictObject({
  workspaceId: uuid,
  hasCard: z.boolean(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  cardExpiryMonth: z.int().nullable(),
  cardExpiryYear: z.int().nullable(),
});

/**
 * What the provider handed back when somebody put a card on the wallet. Never a card number: what is kept is
 * their id for the customer, their token for the card, and the brand, last four and expiry every provider
 * gives for free. That is what keeps HandsFreeOS in the lightest PCI bracket.
 */
export const WalletRecordCardInput = z.strictObject({
  ...inWorkspace,
  provider: z.enum(['stripe', 'square']),
  customerRef: z.string().trim().min(1).max(200),
  methodToken: z.string().trim().min(1).max(4000),
  cardBrand: z.string().trim().min(1).max(40).nullable(),
  cardLast4: z
    .string()
    .regex(/^[0-9]{4}$/)
    .nullable(),
  cardExpiryMonth: z.int().min(1).max(12).nullable(),
  cardExpiryYear: z.int().min(2000).max(2100).nullable(),
});

export const WalletTopUpInput = z.strictObject({
  ...inWorkspace,
  /** What to add. Left out, it is the business's own top-up amount — never an escalated one. */
  amountCents: cents(500, 100_000_000).optional(),
});

export const WalletRechargeOutput = z.strictObject({
  rechargeId: uuid,
  workspaceId: uuid,
  amountCents: z.int(),
  status: z.enum(['pending', 'succeeded', 'failed', 'cancelled']),
});

/** The worker, starting one: written `pending` before the provider is ever called. */
export const WalletStartRechargeInput = z.strictObject({
  ...inWorkspace,
  amountCents: cents(100, 100_000_000),
  /** Which rung of the ladder set this amount, for the sentence the page shows. */
  escalationStep: z.int().min(0).max(4).default(0),
  /** A person pressed Top up rather than a floor being crossed. A manual top-up never escalates. */
  requestedBy: uuid.nullable().default(null),
  idempotencyKey: z.string().trim().min(8).max(100),
});

/**
 * What the provider said. A decline arrives here as `failed` with its code, not as an exception: it is an
 * answer, and the ladder that decides what to do about it needs the answer written down.
 */
export const WalletRecordRechargeInput = z.strictObject({
  ...inWorkspace,
  rechargeId: uuid,
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  provider: z.enum(['stripe', 'square']).nullable().default(null),
  providerPaymentId: z.string().trim().min(1).max(200).nullable().default(null),
  failureCode: z.string().trim().min(1).max(80).nullable().default(null),
  /** Plain words for the business, from the provider adapter's own `declineWording`. */
  failureMessage: z.string().trim().min(1).max(300).nullable().default(null),
});

/** Which line the balance went under. The funnel works this out; nothing here decides it again. */
export const WalletNoteCrossingInput = z.strictObject({
  ...inWorkspace,
  crossed: z.enum(['low', 'empty']),
});

export const WalletSuspendInput = z.strictObject({
  ...inWorkspace,
  reason: z.string().trim().min(1).max(300),
});

export const WalletResumeInput = z.strictObject({ ...inWorkspace });

/** Support putting a credit on, or taking one off, with a reason. Never silent, and never by a business. */
export const WalletAdjustInput = z.strictObject({
  ...inWorkspace,
  /** Signed: positive is a credit to them, negative takes one back. */
  amountCents: z
    .int()
    .min(-10_000_000)
    .max(10_000_000)
    .refine((n) => n !== 0, {
      error: 'An adjustment of nothing is not an adjustment.',
    }),
  reason: z.string().trim().min(3).max(300),
  /** Support's own reference, so two credits of the same amount on one day are two rows and not one. */
  reference: z.string().trim().min(1).max(100),
});

export const WalletAdjustOutput = z.strictObject({
  workspaceId: uuid,
  entryId: uuid.nullable(),
  balanceCents: z.int(),
  /** False when this exact reference had already been credited: idempotent, and says so. */
  recorded: z.boolean(),
});

export type WalletSettingsIn = z.infer<typeof WalletSettingsInput>;
export type WalletRecordCardIn = z.infer<typeof WalletRecordCardInput>;
export type WalletStartRechargeIn = z.infer<typeof WalletStartRechargeInput>;
export type WalletRecordRechargeIn = z.infer<typeof WalletRecordRechargeInput>;
export type WalletAdjustIn = z.infer<typeof WalletAdjustInput>;
