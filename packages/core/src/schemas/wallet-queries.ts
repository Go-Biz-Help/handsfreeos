/**
 * What the usage page asks for and gets back (M16, step 8).
 *
 * Nothing here carries `cost_cents` or `markup_bp`. They are on every ledger row and they stay in the database:
 * a business is shown what it was charged and what it was for, which is the number it decides on. What we pay
 * is ours, and putting it on the page would turn every line into an argument about the markup.
 */
import { z } from 'zod';
import { uuid } from './common';

const inWorkspace = { workspaceId: uuid };

export const WalletGetInput = z.strictObject({ ...inWorkspace });

export const WalletGetOutput = z.strictObject({
  /** False for a business that has never spent anything: "nothing yet", not "empty". */
  opened: z.boolean(),
  balanceCents: z.int(),
  autoTopup: z.boolean(),
  floorCents: z.int(),
  topupCents: z.int(),
  overdraftCents: z.int(),
  /**
   * The most one automatic top-up could be for this business today. The terms promise this number is shown,
   * so it is the cap that actually applies — the lowest ceiling in force, not the headline one.
   */
  maxTopupCents: z.int(),
  card: z
    .strictObject({
      brand: z.string().nullable(),
      last4: z.string().nullable(),
      expiryMonth: z.int().nullable(),
      expiryYear: z.int().nullable(),
      provider: z.string().nullable(),
    })
    .nullable(),
  /** Somebody has started putting a card on and has not finished. */
  cardRequested: z.boolean(),
  suspended: z.strictObject({ at: z.string(), reason: z.string().nullable() }).nullable(),
  spent30dCents: z.int(),
  spentThisMonthCents: z.int(),
  /** A top-up on its way right now, if there is one. */
  pendingTopUpCents: z.int().nullable(),
  /** Why the top-up is bigger than usual, and how to make it stop. Null when it is not. */
  escalation: z.string().nullable(),
});

export const UsageStatementInput = z.strictObject({
  ...inWorkspace,
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
  limit: z.int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const UsageStatementOutput = z.strictObject({
  items: z.array(
    z.strictObject({
      id: uuid,
      kind: z.enum(['spend', 'topup', 'adjustment', 'credit', 'refund']),
      /** Signed as the ledger holds it: negative is money out. */
      amountCents: z.int(),
      balanceAfterCents: z.int(),
      subject: z.string(),
      rateKey: z.string().nullable(),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      /** What it was about, so a row links to the message, call or number it came from. */
      entityType: z.string().nullable(),
      entityId: uuid.nullable(),
      occurredAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const UsagePricesInput = z.strictObject({ ...inWorkspace });

export const UsagePricesOutput = z.strictObject({
  /** Which version of the card these prices came from, so a statement and a price list can be lined up. */
  version: z.int(),
  items: z.array(
    z.strictObject({
      /** Null for a made-up line like "an AI reply", which is several keys added together. */
      key: z.string().nullable(),
      what: z.string(),
      unit: z.string(),
      cents: z.int(),
    }),
  ),
});
