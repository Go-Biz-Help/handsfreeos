/**
 * Current offers (M18): the owner's short list of what the business is running, with the dates it runs. The AI
 * teammate reads the ones live today (worker, ai-team/context.ts); nothing here changes a price or a bill.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { offers } from '@hfos/db/schema';
import { formatDateOnly } from '../crm/format';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  OfferArchiveInput,
  OfferArchiveOutput,
  OfferCreateInput,
  OfferCreateOutput,
  OfferUpdateInput,
  OfferUpdateOutput,
} from '../schemas/offer';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

async function requireOffer(ctx: CommandContext, offerId: string) {
  const [row] = await ctx.tx
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.id, offerId),
        eq(offers.workspaceId, ctx.scope.workspaceId!),
        isNull(offers.archivedAt),
      ),
    )
    .for('update');
  if (!row)
    throw HfosError.notFound(
      'That promotion isn’t there anymore. It may have been archived. Refresh and try again.',
    );
  return row;
}

export const offerCreate = defineCommand({
  name: 'offer.create',
  description:
    'Add a promotion the business is running, with when it starts and ends. The AI teammate tells customers about it while it runs.',
  risk: 1,
  input: OfferCreateInput,
  output: OfferCreateOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['offer.created'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .insert(offers)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        name: input.name,
        details: input.details,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        createdBy: userIdOf(ctx.actor),
      })
      .returning({ id: offers.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'offer.created',
      entityType: 'offer',
      entityId: row.id,
      payload: { offerId: row.id },
      after: { name: input.name, starts: input.startsOn, ends: input.endsOn },
      broadcast: false,
    });
    return { offerId: row.id };
  },
});

export const offerUpdate = defineCommand({
  name: 'offer.update',
  description: 'Change a promotion’s name, details or dates.',
  risk: 1,
  input: OfferUpdateInput,
  output: OfferUpdateOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['offer.updated'],
  async handler(ctx, input) {
    const before = await requireOffer(ctx, input.offerId);
    const patch = {
      ...(input.name !== undefined && input.name !== before.name ? { name: input.name } : {}),
      ...(input.details !== undefined && input.details !== before.details
        ? { details: input.details }
        : {}),
      ...(input.startsOn !== undefined && input.startsOn !== before.startsOn
        ? { startsOn: input.startsOn }
        : {}),
      ...(input.endsOn !== undefined && input.endsOn !== before.endsOn
        ? { endsOn: input.endsOn }
        : {}),
    };
    const startsOn = patch.startsOn !== undefined ? patch.startsOn : before.startsOn;
    const endsOn = patch.endsOn !== undefined ? patch.endsOn : before.endsOn;
    if (startsOn && endsOn && endsOn < startsOn)
      throw HfosError.validation(
        [{ path: 'endsOn', message: 'End on or after the start.' }],
        `This promotion would end on ${formatDateOnly(endsOn)}, before it starts on ${formatDateOnly(startsOn)}. Pick an end date on or after the start.`,
      );
    const updated = Object.keys(patch);
    if (!updated.length) return { offerId: before.id, updated };
    await ctx.tx.update(offers).set(patch).where(eq(offers.id, before.id));
    await ctx.emit({
      type: 'offer.updated',
      entityType: 'offer',
      entityId: before.id,
      payload: { offerId: before.id, updated },
      before: Object.fromEntries(updated.map((k) => [k, before[k as keyof typeof before]])),
      after: patch,
      broadcast: false,
    });
    return { offerId: before.id, updated };
  },
});

export const offerArchive = defineCommand({
  name: 'offer.archive',
  description: 'Take a promotion off the list. The AI teammate stops mentioning it at once.',
  risk: 1,
  input: OfferArchiveInput,
  output: OfferArchiveOutput,
  permission: 'knowledge.manage',
  scope: inWorkspace,
  emits: ['offer.archived'],
  async handler(ctx, input) {
    const before = await requireOffer(ctx, input.offerId);
    await ctx.tx.update(offers).set({ archivedAt: new Date() }).where(eq(offers.id, before.id));
    await ctx.emit({
      type: 'offer.archived',
      entityType: 'offer',
      entityId: before.id,
      payload: { offerId: before.id },
      after: { name: before.name },
      broadcast: false,
    });
    return { offerId: before.id };
  },
});
