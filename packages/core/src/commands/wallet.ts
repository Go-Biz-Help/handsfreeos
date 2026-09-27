/**
 * The usage wallet's writes (M16, step 5).
 *
 * **Who may write what** is the whole design, and it is the same arrangement a subscription's card has:
 *
 * - A **person** with `money.manage` owns four settings, may ask for a card, may forget one, and may press Top
 *   up. That is the complete list.
 * - The **worker** writes everything the provider decides and everywhere the ladders have got to: the card, the
 *   recharge rows, the suspensions. Those are `actors: ['system']`, so `apps/api/src/routes.ts` never mounts an
 *   HTTP route for them and no browser can reach them at all.
 * - **Support** may put a credit on a wallet with a reason, under `platform.wallets.adjust`.
 *
 * Postgres enforces the same split independently (`private.guard_usage_wallet`), so a command that got this
 * wrong would be refused rather than obeyed. The two are deliberate duplication: the command is where the rule
 * is readable, the trigger is where it is true.
 *
 * **Nothing here ever writes `balance_cents`.** Money moves by inserting a ledger row and letting the trigger
 * do the arithmetic, which is what stops a balance and its statement ever disagreeing.
 */
import { eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { usageWallets, walletRecharges } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { topUpUsageKey } from '../money/usage-keys';
import {
  WalletAdjustInput,
  WalletAdjustOutput,
  WalletCardOutput,
  WalletRecordCardInput,
  WalletRecordRechargeInput,
  WalletRechargeOutput,
  WalletRefOutput,
  WalletNoteCrossingInput,
  WalletRequestCardInput,
  WalletResumeInput,
  WalletSettingsInput,
  WalletStartRechargeInput,
  WalletSuspendInput,
  WalletTopUpInput,
} from '../schemas/wallet';
import { WalletSetStageInput, WalletSetStageOutput, WalletStageValue } from '../schemas/support';
import type { CommandContext } from '../kernel/types';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Staff act on HandsFreeOS, not inside a business — which is also the only scope that resolves a staff role. */
const onPlatform = () => ({ kind: 'platform' as const });

type WalletRow = typeof usageWallets.$inferSelect;

/**
 * The wallet, opened if it has none. A business that has never spent anything has no row, and every one of
 * these commands would otherwise have to say "no wallet" instead of doing the obvious thing.
 *
 * Opened through `private.open_usage_wallet` rather than by an insert from here, because a person has no
 * insert privilege on the table and never will: what that closes off is somebody opening a wallet of their
 * own choosing, with a balance on it or its stage turned off. The function checks `money.manage` for itself,
 * reads the organisation from the workspace, and writes defaults and only defaults — so this is the one way
 * a business's own press opens its wallet, and the four `money.manage` commands below all use it.
 */
async function wallet(ctx: CommandContext): Promise<WalletRow> {
  const ws = ctx.scope.workspaceId!;
  const [found] = await ctx.tx.select().from(usageWallets).where(eq(usageWallets.workspaceId, ws));
  if (found) return found;
  await ctx.tx.execute(sql`select private.open_usage_wallet(${ws}::uuid)`);
  const [made] = await ctx.tx.select().from(usageWallets).where(eq(usageWallets.workspaceId, ws));
  if (!made) throw HfosError.notFound('This business has no usage wallet.');
  return made;
}

const refOf = (w: WalletRow) => ({
  workspaceId: w.workspaceId,
  balanceCents: w.balanceCents,
  autoTopup: w.autoTopup,
  floorCents: w.floorCents,
  topupCents: w.topupCents,
  overdraftCents: w.overdraftCents,
  hasCard: w.methodToken !== null,
  suspended: w.suspendedAt !== null,
});

const cardOf = (w: WalletRow) => ({
  workspaceId: w.workspaceId,
  hasCard: w.methodToken !== null,
  cardBrand: w.cardBrand,
  cardLast4: w.cardLast4,
  cardExpiryMonth: w.cardExpiryMonth,
  cardExpiryYear: w.cardExpiryYear,
});

// ---------- what a business chooses ----------

export const walletSetAutoTopup = defineCommand({
  name: 'wallet.set_auto_topup',
  description:
    'Turn automatic top-up on or off, and set the balance it happens at, how much it adds, and how far the balance may go under before outbound texts and calls stop.',
  risk: 2,
  input: WalletSettingsInput,
  output: WalletRefOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['wallet.settings_changed'],
  /**
   * Never queued from a phone that waited. This decides when money moves and how much, so a change replayed a
   * day later could charge a card long after somebody changed their mind — which is the rule
   * `mobile-kernel.test.ts` holds every `money.manage` command to.
   */
  offline: 'online',
  async handler(ctx, input) {
    const before = await wallet(ctx);
    const patch = {
      ...(input.autoTopup === undefined ? {} : { autoTopup: input.autoTopup }),
      ...(input.floorCents === undefined ? {} : { floorCents: input.floorCents }),
      ...(input.topupCents === undefined ? {} : { topupCents: input.topupCents }),
      ...(input.overdraftCents === undefined ? {} : { overdraftCents: input.overdraftCents }),
    };
    if (Object.keys(patch).length === 0) return refOf(before);
    // Once HandsFreeOS has put a business on `enforce`, there is no overdraft to set: the gate reads it as zero
    // there, and a business raising its own would be the way round the stage it was put on.
    if (before.stage === 'enforce' && (patch.overdraftCents ?? 0) > 0)
      throw HfosError.rule(
        'wallet_overdraft_enforced',
        409,
        'Your balance can’t go below zero right now. Top up to keep texts and calls going.',
      );
    // Turning it on without a card is the commonest way to think you are covered and not be.
    if (patch.autoTopup === true && !before.methodToken)
      throw HfosError.rule(
        'wallet_no_card',
        409,
        'There is no card on this wallet yet. Add one, and automatic top-up will start working.',
      );
    await ctx.tx
      .update(usageWallets)
      .set(patch)
      .where(eq(usageWallets.workspaceId, before.workspaceId));
    const after = await wallet(ctx);
    await ctx.emit({
      type: 'wallet.settings_changed',
      entityType: 'usage_wallet',
      entityId: after.workspaceId,
      payload: patch,
      before: { autoTopup: before.autoTopup, floor: before.floorCents, topup: before.topupCents },
      after: { autoTopup: after.autoTopup, floor: after.floorCents, topup: after.topupCents },
    });
    return refOf(after);
  },
});

export const walletRequestCard = defineCommand({
  name: 'wallet.request_card',
  description:
    'Start putting a card on the wallet. The worker opens the page the card is typed on; nothing about the card is ever written here.',
  risk: 2,
  input: WalletRequestCardInput,
  output: WalletCardOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['wallet.card_requested'],
  async handler(ctx) {
    const w = await wallet(ctx);
    await ctx.tx
      .update(usageWallets)
      .set({ cardRequestedAt: new Date() })
      .where(eq(usageWallets.workspaceId, w.workspaceId));
    await ctx.emit({
      type: 'wallet.card_requested',
      entityType: 'usage_wallet',
      entityId: w.workspaceId,
      payload: {},
      after: { asked: true, hasCard: w.methodToken !== null },
    });
    return cardOf(w);
  },
});

export const walletForgetCard = defineCommand({
  name: 'wallet.forget_card',
  description:
    'Take the card off the wallet. Automatic top-up goes off with it, because a top-up with nothing to charge is a promise nobody can keep.',
  risk: 3,
  input: WalletRequestCardInput,
  output: WalletCardOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['wallet.card_forgotten'],
  async handler(ctx) {
    const w = await wallet(ctx);
    if (!w.methodToken) return cardOf(w);
    // The token is cleared here and the provider is told by the worker: the row is the record of intent, and
    // a provider that is down must not stop somebody removing their card.
    await ctx.tx
      .update(usageWallets)
      .set({
        methodToken: null,
        cardBrand: null,
        cardLast4: null,
        cardExpiryMonth: null,
        cardExpiryYear: null,
        autoTopup: false,
      })
      .where(eq(usageWallets.workspaceId, w.workspaceId));
    await ctx.emit({
      type: 'wallet.card_forgotten',
      entityType: 'usage_wallet',
      entityId: w.workspaceId,
      payload: { customerRef: w.customerRef, methodToken: w.methodToken, provider: w.provider },
      before: { card: w.cardLast4, autoTopup: w.autoTopup },
      after: { card: null, autoTopup: false },
    });
    const after = await wallet(ctx);
    return cardOf(after);
  },
});

export const walletTopUp = defineCommand({
  name: 'wallet.top_up',
  description:
    'Add money to the balance now, from the card on file. A top-up somebody asked for never raises the automatic amount.',
  risk: 3,
  input: WalletTopUpInput,
  output: WalletRechargeOutput,
  permission: 'money.manage',
  scope: inWorkspace,
  emits: ['wallet.recharge_requested'],
  async handler(ctx, input) {
    const w = await wallet(ctx);
    if (!w.methodToken)
      throw HfosError.rule(
        'wallet_no_card',
        409,
        'There is no card on this wallet to charge. Add one first.',
      );
    const amount = input.amountCents ?? w.topupCents;
    const id = crypto.randomUUID();
    const [made] = await ctx.tx
      .insert(walletRecharges)
      .values({
        id,
        workspaceId: w.workspaceId,
        organizationId: ctx.scope.organizationId!,
        amountCents: amount,
        // Deliberately step 0: somebody pressing the button is not the runaway the ladder exists for.
        escalationStep: 0,
        requestedBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
        idempotencyKey: topUpUsageKey(id),
      })
      .onConflictDoNothing()
      .returning();
    // The one-pending-per-business index refused it: one is already on its way, which is the right answer.
    if (!made)
      throw HfosError.rule(
        'wallet_recharge_pending',
        409,
        'A top-up is already going through. Give it a moment.',
      );
    await ctx.emit({
      type: 'wallet.recharge_requested',
      entityType: 'wallet_recharge',
      entityId: made.id,
      payload: { workspaceId: w.workspaceId, amountCents: amount, manual: true },
      after: { amount: `${(amount / 100).toFixed(2)}` },
    });
    return {
      rechargeId: made.id,
      workspaceId: w.workspaceId,
      amountCents: amount,
      status: 'pending' as const,
    };
  },
});

// ---------- what the worker writes ----------

export const walletRecordCard = defineCommand({
  name: 'wallet.record_card',
  description:
    'Worker: a card was put on the wallet. What the provider handed back is written down — their customer, their token, and the brand, last four and expiry. Never a card number.',
  risk: 1,
  input: WalletRecordCardInput,
  output: WalletCardOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['wallet.card_saved'],
  actors: ['system'],
  async handler(ctx, input) {
    const w = await wallet(ctx);
    await ctx.tx
      .update(usageWallets)
      .set({
        provider: input.provider,
        customerRef: input.customerRef,
        methodToken: input.methodToken,
        cardBrand: input.cardBrand,
        cardLast4: input.cardLast4,
        cardExpiryMonth: input.cardExpiryMonth,
        cardExpiryYear: input.cardExpiryYear,
        cardRequestedAt: null,
        // A new card is a fresh start for the decline ladder: the old card's failures are not this one's.
        declinesInRow: 0,
        pausedUntil: null,
        suspendedAt: null,
        suspendedReason: null,
      })
      .where(eq(usageWallets.workspaceId, w.workspaceId));
    const after = await wallet(ctx);
    await ctx.emit({
      type: 'wallet.card_saved',
      entityType: 'usage_wallet',
      entityId: after.workspaceId,
      payload: { provider: input.provider },
      before: { card: w.cardLast4, suspended: w.suspendedAt !== null },
      after: { card: after.cardLast4, suspended: false },
    });
    return cardOf(after);
  },
});

export const walletStartRecharge = defineCommand({
  name: 'wallet.start_recharge',
  description:
    'Worker: the balance crossed its floor, so a top-up is starting. The row is written before the provider is called, and its key is what stops a card being charged twice.',
  risk: 1,
  input: WalletStartRechargeInput,
  output: WalletRechargeOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['wallet.recharge_requested'],
  actors: ['system'],
  async handler(ctx, input) {
    const w = await wallet(ctx);
    if (!w.methodToken)
      throw HfosError.rule('wallet_no_card', 409, 'There is no card on this wallet to charge.');
    const [made] = await ctx.tx
      .insert(walletRecharges)
      .values({
        workspaceId: w.workspaceId,
        organizationId: ctx.scope.organizationId!,
        amountCents: input.amountCents,
        escalationStep: input.escalationStep,
        requestedBy: input.requestedBy,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    if (!made)
      throw HfosError.rule(
        'wallet_recharge_pending',
        409,
        'A top-up for this business is already going through.',
      );
    await ctx.emit({
      type: 'wallet.recharge_requested',
      entityType: 'wallet_recharge',
      entityId: made.id,
      payload: {
        workspaceId: w.workspaceId,
        amountCents: input.amountCents,
        escalationStep: input.escalationStep,
        manual: false,
      },
      after: { amount: `${(input.amountCents / 100).toFixed(2)}` },
    });
    return {
      rechargeId: made.id,
      workspaceId: w.workspaceId,
      amountCents: made.amountCents,
      status: 'pending' as const,
    };
  },
});

export const walletRecordRecharge = defineCommand({
  name: 'wallet.record_recharge',
  description:
    'Worker: what the provider said about a top-up. On success it writes its own ledger row, so the balance and the top-up can never disagree about what landed. A decline is recorded, not thrown.',
  risk: 1,
  input: WalletRecordRechargeInput,
  output: WalletRechargeOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['wallet.recharged', 'wallet.recharge_failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [row] = await ctx.tx
      .select()
      .from(walletRecharges)
      .where(eq(walletRecharges.id, input.rechargeId));
    if (!row || row.workspaceId !== ws) throw HfosError.notFound('Top-up not found.');
    // Already settled: a late callback says the same thing twice, and the status guard would ignore it anyway.
    if (row.status !== 'pending')
      return {
        rechargeId: row.id,
        workspaceId: ws,
        amountCents: row.amountCents,
        status: row.status as 'succeeded' | 'failed' | 'cancelled',
      };

    let entryId: string | null = null;
    if (input.status === 'succeeded') {
      // The money arrives as a ledger row, never as a write to the balance: the trigger does the arithmetic,
      // which is the only reason a statement always adds up to what the wallet says.
      const made = await ctx.tx.execute(sql`
        insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, subject,
          entity_type, entity_id, provider_ref, idempotency_key, occurred_at)
        values (${ws}, ${ctx.scope.organizationId!}, 'topup', ${row.amountCents},
          'Top-up', 'wallet_recharge', ${row.id}, ${input.providerPaymentId},
          ${topUpUsageKey(row.id)}, now())
        on conflict (workspace_id, idempotency_key) do nothing
        returning id`);
      entryId = (made as unknown as { id: string }[])[0]?.id ?? null;
    }

    await ctx.tx
      .update(walletRecharges)
      .set({
        status: input.status,
        provider: input.provider,
        providerPaymentId: input.providerPaymentId,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
        succeededAt: input.status === 'succeeded' ? new Date() : null,
        ...(entryId ? { ledgerEntryId: entryId } : {}),
      })
      .where(eq(walletRecharges.id, row.id));

    const w = await wallet(ctx);
    if (input.status === 'succeeded') {
      // A card that worked clears the decline ladder, and the window this top-up counts against moves on.
      await ctx.tx
        .update(usageWallets)
        .set({
          declinesInRow: 0,
          pausedUntil: null,
          lastRechargeAt: new Date(),
          rechargesInWindow: sql`${usageWallets.rechargesInWindow} + 1`,
          windowStartedAt: w.windowStartedAt ?? new Date(),
          escalationStep: row.escalationStep,
          // Back above the floor: the next crossing is a new warning, not the same one again.
          lowWarnedAt: null,
          warnFingerprint: null,
        })
        .where(eq(usageWallets.workspaceId, ws));
    } else if (input.status === 'failed') {
      await ctx.tx
        .update(usageWallets)
        .set({ declinesInRow: sql`${usageWallets.declinesInRow} + 1` })
        .where(eq(usageWallets.workspaceId, ws));
    }

    await ctx.emit({
      type: input.status === 'succeeded' ? 'wallet.recharged' : 'wallet.recharge_failed',
      entityType: 'wallet_recharge',
      entityId: row.id,
      payload: {
        workspaceId: ws,
        amountCents: row.amountCents,
        failureCode: input.failureCode,
        escalationStep: row.escalationStep,
      },
      after: {
        amount: `${(row.amountCents / 100).toFixed(2)}`,
        ...(input.failureMessage ? { why: input.failureMessage } : {}),
      },
    });
    return {
      rechargeId: row.id,
      workspaceId: ws,
      amountCents: row.amountCents,
      status: input.status,
    };
  },
});

/**
 * The one place a low balance becomes an event.
 *
 * The charge itself is deliberately **not** a command. It happens on every text, every call and every AI
 * request, and putting all of that through the kernel would write an event, an outbox row and an audit row per
 * message — doubling the writes on the hottest path in the system to record something nobody reads. The
 * crossing is different: it happens rarely, somebody acts on it, and it needs to reach an outbox handler. So
 * the funnel inserts its ledger rows directly and calls this only when the balance went under a line.
 *
 * The funnel already made sure this is said once: it only reports a crossing on a row it actually inserted,
 * and only when the balance was above the line before and is not now.
 */
export const walletNoteCrossing = defineCommand({
  name: 'wallet.note_crossing',
  description:
    'Worker: a business’s balance went under its top-up line, or under zero. Says so once, so the top-up and the warnings can happen.',
  risk: 0,
  input: WalletNoteCrossingInput,
  output: WalletRefOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['wallet.low', 'wallet.empty'],
  actors: ['system'],
  async handler(ctx, input) {
    const w = await wallet(ctx);
    await ctx.emit({
      type: input.crossed === 'empty' ? 'wallet.empty' : 'wallet.low',
      entityType: 'usage_wallet',
      entityId: w.workspaceId,
      payload: {
        balanceCents: w.balanceCents,
        floorCents: w.floorCents,
        autoTopup: w.autoTopup,
        hasCard: w.methodToken !== null,
      },
      after: { balance: `${(w.balanceCents / 100).toFixed(2)}` },
    });
    return refOf(w);
  },
});

export const walletSuspend = defineCommand({
  name: 'wallet.suspend',
  description:
    'Worker: the card has stopped working and the ladder has run out of rungs. Outbound stops, and the usage page asks for a new card.',
  risk: 2,
  input: WalletSuspendInput,
  output: WalletRefOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['wallet.suspended'],
  actors: ['system'],
  async handler(ctx, input) {
    const w = await wallet(ctx);
    if (w.suspendedAt) return refOf(w);
    await ctx.tx
      .update(usageWallets)
      .set({ suspendedAt: new Date(), suspendedReason: input.reason })
      .where(eq(usageWallets.workspaceId, w.workspaceId));
    await ctx.emit({
      type: 'wallet.suspended',
      entityType: 'usage_wallet',
      entityId: w.workspaceId,
      payload: { reason: input.reason },
      after: { suspended: true, why: input.reason },
    });
    return refOf(await wallet(ctx));
  },
});

export const walletResume = defineCommand({
  name: 'wallet.resume',
  description: 'Worker: a working card is on the wallet again, so it goes back to normal.',
  risk: 1,
  input: WalletResumeInput,
  output: WalletRefOutput,
  permission: null,
  scope: inWorkspace,
  emits: ['wallet.resumed'],
  actors: ['system'],
  async handler(ctx) {
    const w = await wallet(ctx);
    if (!w.suspendedAt) return refOf(w);
    await ctx.tx
      .update(usageWallets)
      .set({ suspendedAt: null, suspendedReason: null, declinesInRow: 0, pausedUntil: null })
      .where(eq(usageWallets.workspaceId, w.workspaceId));
    await ctx.emit({
      type: 'wallet.resumed',
      entityType: 'usage_wallet',
      entityId: w.workspaceId,
      payload: {},
      before: { suspended: true },
      after: { suspended: false },
    });
    return refOf(await wallet(ctx));
  },
});

// ---------- what support may do ----------

/**
 * Support puts a credit on a business's balance.
 *
 * **Scoped to the platform, not to the business**, and that is not a detail. Every `platform.*`
 * permission is checked against the staff role, and the staff role is only resolved by a platform
 * scope — a workspace-scoped command asking for one can never pass, whoever is calling. That is how
 * this shipped unreachable in step 5.
 *
 * **The row goes in through `private.staff_credit_wallet`**, a security-definer function, because the
 * usage ledger has no insert policy or grant for a signed-in person at all and its guard demands the
 * system's scope. Staff are not an exception to that rule; the function is HandsFreeOS saying so for
 * exactly one row, and it does its own `staff_can` check rather than trusting this caller.
 */
export const walletAdjust = defineCommand({
  name: 'wallet.adjust',
  description:
    'Support: put a credit on a business’s balance, or take one back, with a reason. It shows on their statement like everything else.',
  risk: 4,
  input: WalletAdjustInput,
  output: WalletAdjustOutput,
  permission: 'platform.wallets.adjust',
  scope: onPlatform,
  emits: ['wallet.adjusted'],
  async handler(ctx, input) {
    const by = ctx.actor.type === 'human' ? ctx.actor.userId : null;
    const [row] = await rows<{
      entry_id: string | null;
      balance_cents: number | string;
      recorded: boolean;
    }>(
      ctx.tx,
      sql`select * from private.staff_credit_wallet(${input.workspaceId}::uuid,
            ${input.amountCents}::bigint, ${input.reason}, ${input.reference}, ${by}::uuid)`,
    );
    if (!row) throw HfosError.notFound('That business has no usage wallet.');
    const balanceCents = Number(row.balance_cents);
    // A platform-scoped event: it belongs to HandsFreeOS's own record of what staff did, beside every
    // other staff action, with the business named in it. What the business sees is the statement row.
    if (row.recorded)
      await ctx.emit({
        type: 'wallet.adjusted',
        entityType: 'usage_wallet',
        entityId: input.workspaceId,
        payload: {
          workspaceId: input.workspaceId,
          amountCents: input.amountCents,
          reason: input.reason,
        },
        after: { balance: `${(balanceCents / 100).toFixed(2)}`, why: input.reason },
      });
    return {
      workspaceId: input.workspaceId,
      entryId: row.entry_id,
      balanceCents,
      // The same reference twice is the same decision, recorded once.
      recorded: row.recorded,
    };
  },
});

/**
 * Move a business along the wallet: `off` → `warn` → `enforce` (M16, step 9).
 *
 * This is the switch the whole rollout runs on, and the only one in the product that can stop a business's
 * phone working. So it is deliberate in three ways: it is per business and there is no global form of it, a
 * global one being how this gets turned on for a thousand businesses by accident at two in the morning; it
 * takes a reason, because a rollout is a series of decisions somebody made and ought to be able to explain;
 * and it says where the business came from, so the same click twice is visibly a no-op rather than a second
 * decision.
 *
 * Platform-scoped, like everything staff do — and the SQL behind it checks `platform.wallets.adjust` for
 * itself rather than trusting this caller.
 */
export const walletSetStage = defineCommand({
  name: 'wallet.set_stage',
  description:
    'Support: move one business along the usage wallet — silent, warned, or stopped when the balance runs out.',
  risk: 4,
  input: WalletSetStageInput,
  output: WalletSetStageOutput,
  permission: 'platform.wallets.adjust',
  scope: onPlatform,
  emits: ['wallet.stage_changed'],
  async handler(ctx, input) {
    const [row] = await rows<{ was: string; changed: boolean }>(
      ctx.tx,
      sql`select * from private.set_wallet_stage(${input.workspaceId}::uuid,
            ${input.stage}::app.wallet_stage)`,
    );
    if (!row) throw HfosError.notFound('No business with that id.');
    const was = WalletStageValue.options.find((st) => st === row.was) ?? 'off';
    if (row.changed)
      await ctx.emit({
        type: 'wallet.stage_changed',
        entityType: 'usage_wallet',
        entityId: input.workspaceId,
        payload: { workspaceId: input.workspaceId, was, stage: input.stage, reason: input.reason },
        before: { stage: was },
        after: { stage: input.stage, why: input.reason },
      });
    return { workspaceId: input.workspaceId, was, stage: input.stage, changed: row.changed };
  },
});

export const walletCommands = [
  walletSetAutoTopup,
  walletRequestCard,
  walletForgetCard,
  walletTopUp,
  walletRecordCard,
  walletStartRecharge,
  walletRecordRecharge,
  walletNoteCrossing,
  walletSuspend,
  walletResume,
  walletAdjust,
  walletSetStage,
];
