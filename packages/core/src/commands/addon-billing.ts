/**
 * Paying for a paid add-on (20261027028500, the owner's picks of 2026-11-17): turning one off at the end of what's
 * paid, keeping it after all (or after a gift ends), and the worker's half: what a monthly charge did, and turning off
 * an add-on nobody pays for any more.
 *
 * Starting and stopping as an add-on comes on or goes off is the lifecycle's (`makeMoves` in ./addon.ts), so the
 * Assistant, the screens and the tests all go through the same moves. Every write goes through a function in the
 * database that checks the person's permission itself (or that the worker is the one asking), because nobody in a
 * business writes what it pays.
 *
 * Made by a factory over a catalogue, as the lifecycle commands are: the price is in each manifest.
 */
import { rows, sql } from '@hfos/db/client';
import { addonPriceOf } from '../addons/billing';
import { findAddon, type Catalog } from '../addons/graph';
import { nextPlanRetryAt } from '../billing/rules';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import {
  AddonBillingKeepInput,
  AddonBillingKeepOutput,
  AddonBillingRecordChargeInput,
  AddonBillingRecordChargeOutput,
  AddonBillingStopInput,
  AddonBillingStopOutput,
  AddonBillingTurnOffInput,
  AddonBillingTurnOffOutput,
} from '../schemas/addon';
import { ADDON_MOVE_EVENTS } from './addon';
import { noteCardTries } from './billing';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

/** The add-on billing commands, over a catalogue. */
export function addonBillingCommands(catalog: Catalog) {
  const paidAddon = (addonId: string) => {
    const m = findAddon(catalog, addonId);
    if (!m)
      throw HfosError.rule(
        'addon_unknown',
        404,
        'HandsFreeOS doesn’t have that add-on. Refresh Add-ons (at the bottom of the side menu) and pick one from the list.',
      );
    const price = addonPriceOf(m);
    if (!price)
      throw HfosError.rule(
        'addon_free',
        409,
        `${m.name} doesn’t cost anything, so there’s nothing to pay or stop paying.`,
      );
    return { m, price };
  };

  const stop = defineCommand({
    name: 'addon_billing.stop',
    description:
      'Turn a paid add-on off at the end of its free trial or the month already paid: it keeps working until then, then turns off on its own, and nothing more is charged. To turn it off straight away, use addon.disable.',
    risk: 2,
    input: AddonBillingStopInput,
    output: AddonBillingStopOutput,
    permission: 'addons.manage',
    scope: inWorkspace,
    emits: ['addon_billing.stopping'],
    async handler(ctx, input) {
      const { m } = paidAddon(input.addonId);
      const [row] = await rows<{ at: Date | string }>(
        ctx.tx,
        sql`select private.addon_billing_schedule_stop(${input.workspaceId}::uuid, ${m.id}) as at`,
      );
      const stopAt = iso(row?.at)!;
      await ctx.emit({
        type: 'addon_billing.stopping',
        entityType: 'addon',
        payload: { addonId: m.id, name: m.name, stopAt },
        after: { stops: stopAt.slice(0, 10) },
      });
      return { addonId: m.id, stopAt };
    },
  });

  const keep = defineCommand({
    name: 'addon_billing.keep',
    description:
      'Keep a paid add-on: undo turning it off at the end of what was paid, so it renews each month; or, when HandsFreeOS gave it free until a date, keep it after that, with its first charge on that date. Charged to the default card.',
    risk: 2,
    input: AddonBillingKeepInput,
    output: AddonBillingKeepOutput,
    permission: 'money.manage',
    scope: inWorkspace,
    emits: ['addon_billing.kept'],
    async handler(ctx, input) {
      const { m, price } = paidAddon(input.addonId);
      const [row] = await rows<{ next: Date | string | null }>(
        ctx.tx,
        sql`select private.addon_billing_keep(${input.workspaceId}::uuid, ${m.id}, ${price.monthlyCents}::integer) as next`,
      );
      const nextChargeAt = iso(row?.next);
      await ctx.emit({
        type: 'addon_billing.kept',
        entityType: 'addon',
        payload: { addonId: m.id, name: m.name, nextChargeAt },
        after: { next: nextChargeAt?.slice(0, 10) ?? null },
      });
      return { addonId: m.id, nextChargeAt };
    },
  });

  const recordCharge = defineCommand({
    name: 'addon_billing.record_charge',
    description:
      'Worker: what a paid add-on’s monthly charge did, through every card in turn. Paid moves the month on and keeps the payment; refused is written down and tried again once a day, and after the last try the add-on turns off.',
    risk: 3,
    input: AddonBillingRecordChargeInput,
    output: AddonBillingRecordChargeOutput,
    permission: null,
    scope: inWorkspace,
    emits: ['addon_billing.charged', 'addon_billing.charge_failed', 'addon_billing.retry_failed'],
    actors: ['system'],
    async handler(ctx, input) {
      const workspaceId = ctx.scope.workspaceId!;
      const name = findAddon(catalog, input.addonId)?.name ?? input.addonId;
      // Locked, so a retry arriving beside the first answer waits and then finds the month already moved.
      const [sub] = await rows<{
        status: string;
        price_cents: number;
        next_charge_at: Date | string | null;
        stop_at: Date | string | null;
        retry_count: number;
        retry_from: Date | string | null;
        failed_at: Date | string | null;
      }>(
        ctx.tx,
        sql`select status, price_cents, next_charge_at, stop_at, retry_count, retry_from, failed_at
            from app.addon_subscriptions
            where workspace_id = ${workspaceId}::uuid and addon_id = ${input.addonId}
            for update`,
      );
      const already = { addonId: input.addonId, outcome: 'already' as const };
      if (
        !sub ||
        !sub.next_charge_at ||
        sub.stop_at ||
        sub.status === 'ended' ||
        iso(sub.next_charge_at) !== new Date(input.dueAt).toISOString()
      )
        return already;
      const failed = sub.status === 'past_due';
      if ((input.attempt === 0) === failed) return already;
      if (failed && input.attempt !== sub.retry_count + 1) return already;

      if (input.outcome === 'paid') {
        const [moved] = await rows<{ paid_through: Date | string }>(
          ctx.tx,
          sql`update app.addon_subscriptions
                 set status = 'active', paid_through = next_charge_at + interval '1 month',
                     next_charge_at = next_charge_at + interval '1 month', charge_count = charge_count + 1,
                     failed_at = null, problem = null, retry_count = 0, retry_from = null, next_retry_at = null
               where workspace_id = ${workspaceId}::uuid and addon_id = ${input.addonId}
              returning paid_through`,
        );
        const amount = input.paidCents ?? sub.price_cents;
        await ctx.tx.execute(
          sql`insert into app.addon_charges (workspace_id, organization_id, addon_id, amount_cents, period_from,
                period_to, payment_ref, card_id)
              values (${workspaceId}::uuid, ${ctx.scope.organizationId!}::uuid, ${input.addonId}, ${amount},
                ${input.dueAt}::timestamptz, ${iso(moved!.paid_through)}::timestamptz, ${input.paymentRef},
                ${input.cardId}::uuid)
              on conflict (workspace_id, addon_id, period_from) do nothing`,
        );
        await noteCardTries(ctx, workspaceId, input.cards);
        await ctx.emit({
          type: 'addon_billing.charged',
          entityType: 'addon',
          payload: {
            addonId: input.addonId,
            name,
            paidCents: amount,
            paymentRef: input.paymentRef,
            paidThrough: iso(moved!.paid_through),
          },
          after: { paid: (amount / 100).toFixed(2), until: iso(moved!.paid_through)!.slice(0, 10) },
        });
        return { addonId: input.addonId, outcome: 'recorded' as const };
      }

      const problem = input.problem ?? 'The card was declined.';
      if (failed) {
        // A daily retry that didn't go through: the next one, or none after the last.
        const from = new Date(sub.retry_from ?? sub.failed_at ?? Date.now());
        const next = nextPlanRetryAt(from, sub.retry_count + 1, input.random);
        await ctx.tx.execute(
          sql`update app.addon_subscriptions
                 set problem = ${problem.slice(0, 500)}, retry_count = retry_count + 1,
                     next_retry_at = ${next ? next.toISOString() : null}::timestamptz
               where workspace_id = ${workspaceId}::uuid and addon_id = ${input.addonId}`,
        );
        await noteCardTries(ctx, workspaceId, input.cards);
        await ctx.emit({
          type: 'addon_billing.retry_failed',
          entityType: 'addon',
          payload: {
            addonId: input.addonId,
            name,
            problem,
            attempt: input.attempt,
            nextRetryAt: next ? next.toISOString() : null,
            lastRetry: !next,
          },
          after: { retry: String(input.attempt), reason: problem.slice(0, 200) },
        });
        return { addonId: input.addonId, outcome: 'recorded' as const };
      }
      // The first try of a month: past due, still on, and tried again once a day from tomorrow.
      const failedAt = new Date();
      const next = nextPlanRetryAt(failedAt, 0, input.random);
      await ctx.tx.execute(
        sql`update app.addon_subscriptions
               set status = 'past_due', failed_at = ${failedAt.toISOString()}::timestamptz,
                   problem = ${problem.slice(0, 500)}, retry_count = 0,
                   retry_from = ${failedAt.toISOString()}::timestamptz,
                   next_retry_at = ${next ? next.toISOString() : null}::timestamptz
             where workspace_id = ${workspaceId}::uuid and addon_id = ${input.addonId}`,
      );
      await noteCardTries(ctx, workspaceId, input.cards);
      await ctx.emit({
        type: 'addon_billing.charge_failed',
        entityType: 'addon',
        payload: {
          addonId: input.addonId,
          name,
          problem,
          amountCents: sub.price_cents,
          failedAt: failedAt.toISOString(),
        },
        after: { charge: 'refused', reason: problem.slice(0, 200) },
      });
      return { addonId: input.addonId, outcome: 'recorded' as const };
    },
  });

  const turnOff = defineCommand({
    name: 'addon_billing.turn_off',
    description:
      'Worker: turn off a paid add-on nobody pays for any more (its stop came, its payment never went through, or a gift ended). Its data and settings are kept, as any add-on turned off.',
    risk: 2,
    input: AddonBillingTurnOffInput,
    output: AddonBillingTurnOffOutput,
    permission: null,
    scope: inWorkspace,
    emits: [ADDON_MOVE_EVENTS.disable, 'addon_billing.turned_off'],
    actors: ['system'],
    async handler(ctx, input) {
      const m = findAddon(catalog, input.addonId);
      const [row] = await rows<{ state: string; generation: number; previous_state: string }>(
        ctx.tx,
        sql`select * from private.addon_billing_turn_off(${ctx.scope.workspaceId!}::uuid, ${input.addonId})`,
      );
      if (!row) return { addonId: input.addonId, turnedOff: false };
      const name = m?.name ?? input.addonId;
      // The lifecycle's own event, so the worker finishes turning it off as it does any other.
      await ctx.emit({
        type: ADDON_MOVE_EVENTS.disable,
        entityType: 'addon',
        payload: {
          addonId: input.addonId,
          name,
          version: m?.version ?? null,
          from: row.previous_state,
          to: row.state,
          generation: row.generation,
        },
      });
      await ctx.emit({
        type: 'addon_billing.turned_off',
        entityType: 'addon',
        payload: { addonId: input.addonId, name, reason: input.reason },
        after: { off: input.reason },
      });
      return { addonId: input.addonId, turnedOff: true };
    },
  });

  return { stop, keep, recordCharge, turnOff };
}
