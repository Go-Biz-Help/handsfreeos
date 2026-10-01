/**
 * Buyer memory, step 7 (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"). Chris decided: the AI
 * suggests what a buyer said from their messages and call notes, each with the words it came from, and the agent
 * confirms each one. The AI never confirms: what it adds (here, or through the Assistant) waits as a suggestion.
 * Anything about who lives somewhere or a protected class is never kept: the worker drops it before it's suggested,
 * and a person's own words go through the same fair-housing list.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { realestateAddon } from '../manifest';
import { MEMORY_KINDS, sameMemory } from '../memory';
import {
  MemoryAddInput,
  MemoryAddOutput,
  MemoryDecideInput,
  MemoryDecideOutput,
  MemoryListInput,
  MemoryListOutput,
  MemoryRequestInput,
  MemoryRequestOutput,
  MemorySuggestInput,
  MemorySuggestOutput,
} from '../schemas';
import { deals, memoryItems } from '../tables';
import {
  actorKind,
  actorUserId,
  historyLine,
  inWorkspace,
  loadDeal,
  requireNotArchived,
  userNames,
  type Ctx,
} from './common';
import { refuseFairHousingWords, requireBuyerSide } from './homes';

type Item = typeof memoryItems.$inferSelect;

async function waitingOn(ctx: Ctx, dealId: string): Promise<number> {
  const list = await ctx.tx
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(and(eq(memoryItems.dealRecordId, dealId), eq(memoryItems.status, 'suggested')));
  return list.length;
}

/** What's remembered or waiting; with `turnedDown`, also what a person said no to (never suggested again). */
async function keptWords(ctx: Ctx, dealId: string, turnedDown = false): Promise<string[]> {
  const list = await ctx.tx
    .select({ words: memoryItems.words })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.dealRecordId, dealId),
        inArray(
          memoryItems.status,
          turnedDown ? ['suggested', 'confirmed', 'rejected'] : ['suggested', 'confirmed'],
        ),
      ),
    );
  return list.map((i) => i.words);
}

export const memoryAdd = defineAddonCommand(realestateAddon, {
  name: 'realestate.memory.add',
  description:
    'Remember something a buyer wants or said (“A fenced yard for the dog”, “Must close by June 30”) on their deal. A person’s is kept; the AI’s waits for a person to confirm.',
  risk: 1,
  input: MemoryAddInput,
  output: MemoryAddOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_remember',
    description: 'Suggest something to remember about what a buyer wants; the agent confirms it.',
  },
  emits: ['realestate.memory.added'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    requireNotArchived(deal);
    requireBuyerSide(deal);
    refuseFairHousingWords([input.words]);
    if ((await keptWords(ctx, deal.recordId)).some((w) => sameMemory(w, input.words)))
      throw HfosError.rule(
        'realestate_memory_already',
        409,
        `“${input.words}” is already remembered on ${deal.name}.`,
      );
    // The AI only ever suggests (Chris); a person's own is kept as they said it.
    const byAi = actorKind(ctx) === 'ai';
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .insert(memoryItems)
      .values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        kind: input.kind,
        words: input.words,
        sourceKind: 'typed',
        status: byAi ? 'suggested' : 'confirmed',
        suggestedBy: byAi ? 'ai' : 'person',
        createdBy: actorUserId(ctx),
        ...(byAi ? {} : { decidedBy: actorUserId(ctx), decidedAt: at }),
      })
      .returning({ id: memoryItems.id });
    await ctx.emit({
      type: 'realestate.memory.added',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { itemId: row!.id, kind: input.kind, suggested: byAi },
      after: { words: input.words },
    });
    return { itemId: row!.id, status: byAi ? ('suggested' as const) : ('confirmed' as const) };
  },
});

export const memoryDecide = defineAddonCommand(realestateAddon, {
  name: 'realestate.memory.decide',
  description:
    'Confirm or reject something the AI suggested about a buyer (with the words fixed if need be), or retire something that’s no longer true. Only a person decides.',
  risk: 1,
  input: MemoryDecideInput,
  output: MemoryDecideOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.memory.decided'],
  async handler(ctx, input) {
    if (ctx.actor.type !== 'human' || actorKind(ctx) === 'ai')
      throw HfosError.forbidden('Only a person decides what’s remembered about a buyer.');
    const [item] = await ctx.tx
      .select()
      .from(memoryItems)
      .where(
        and(eq(memoryItems.id, input.itemId), eq(memoryItems.workspaceId, ctx.scope.workspaceId!)),
      )
      .for('update');
    if (!item)
      throw HfosError.notFound(
        'That isn’t remembered on the deal anymore. Refresh to see what is.',
      );
    const deal = await loadDeal(ctx, item.dealRecordId);
    requireNotArchived(deal);
    const fits =
      input.decision === 'retire' ? item.status === 'confirmed' : item.status === 'suggested';
    if (!fits)
      throw HfosError.rule(
        'realestate_memory_decided',
        409,
        input.decision === 'retire'
          ? 'Only something confirmed can be marked no longer true.'
          : 'That was already decided. Refresh to see it as it is now.',
      );
    const words = input.decision === 'confirm' && input.words ? input.words : item.words;
    if (words !== item.words) refuseFairHousingWords([words]);
    const status: 'confirmed' | 'rejected' | 'retired' =
      input.decision === 'confirm'
        ? 'confirmed'
        : input.decision === 'reject'
          ? 'rejected'
          : 'retired';
    const at = changeMoment(ctx.meta);
    await ctx.tx
      .update(memoryItems)
      .set({
        status,
        words,
        decidedBy: actorUserId(ctx),
        decidedAt: at,
        decidedNote: input.note ?? null,
      })
      .where(eq(memoryItems.id, item.id));
    if (status !== 'rejected')
      await historyLine(ctx, deal, status === 'confirmed' ? 'memory_confirmed' : 'memory_retired', {
        after: { words, kind: item.kind },
      });
    const waiting = await waitingOn(ctx, deal.recordId);
    await ctx.emit({
      type: 'realestate.memory.decided',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: { itemId: item.id, status, waiting },
      before: { status: item.status, words: item.words },
      after: { status, words },
    });
    return { itemId: item.id, status, waiting };
  },
});

export const memoryRequest = defineAddonCommand(realestateAddon, {
  name: 'realestate.memory.request',
  description:
    'Ask the AI to read what the buyer has said since it last looked, now, and suggest what to remember.',
  risk: 0,
  input: MemoryRequestInput,
  output: MemoryRequestOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  emits: ['realestate.memory.requested'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    requireNotArchived(deal);
    requireBuyerSide(deal);
    await ctx.emit({
      type: 'realestate.memory.requested',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {},
    });
    return { dealId: deal.recordId, requested: true };
  },
});

export const memorySuggest = defineAddonCommand(realestateAddon, {
  name: 'realestate.memory.suggest',
  description:
    'Worker: what the AI found worth remembering in the buyer’s own words, each with its quote, for a person to confirm; and how far it read.',
  risk: 0,
  input: MemorySuggestInput,
  output: MemorySuggestOutput,
  permission: 'realestate.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['realestate.memory.suggested'],
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId, { lock: true });
    const kept = await keptWords(ctx, deal.recordId, true);
    let added = 0;
    for (const i of input.items) {
      if (kept.some((w) => sameMemory(w, i.words))) continue;
      await ctx.tx.insert(memoryItems).values({
        workspaceId: deal.workspaceId,
        dealRecordId: deal.recordId,
        kind: i.kind,
        words: i.words,
        quote: i.quote,
        sourceKind: i.sourceKind,
        sourceId: i.sourceId,
        status: 'suggested',
        suggestedBy: 'ai',
      });
      kept.push(i.words);
      added += 1;
    }
    await ctx.tx
      .update(deals)
      .set({ memoryReadThrough: new Date(input.readThrough) })
      .where(eq(deals.recordId, deal.recordId));
    const waiting = await waitingOn(ctx, deal.recordId);
    // Only how many were dropped, never what: nothing protected is written anywhere.
    await ctx.emit({
      type: 'realestate.memory.suggested',
      entityType: 'realestate_deal',
      entityId: deal.recordId,
      payload: {
        added,
        waiting,
        unquoted: input.unquoted,
        protectedDropped: input.protectedDropped,
        ownerUserId: deal.ownerUserId,
        name: deal.name,
      },
      broadcast: added > 0,
    });
    return { added, waiting };
  },
});

const itemOut = (i: Item, names: ReadonlyMap<string, string>) => ({
  id: i.id,
  kind: i.kind,
  words: i.words,
  quote: i.quote,
  sourceKind: i.sourceKind,
  sourceId: i.sourceId,
  status: i.status,
  suggestedBy: i.suggestedBy,
  createdBy: i.createdBy
    ? { id: i.createdBy, fullName: names.get(i.createdBy) ?? 'Former member' }
    : null,
  decidedBy: i.decidedBy
    ? { id: i.decidedBy, fullName: names.get(i.decidedBy) ?? 'Former member' }
    : null,
  decidedAt: i.decidedAt?.toISOString() ?? null,
  createdAt: i.createdAt.toISOString(),
});

export const memoryList = defineAddonQuery(realestateAddon, {
  name: 'realestate.memory',
  description:
    'What’s remembered about a buyer on their deal: what they like, can’t stand, must have, their timing and money, each with the words it came from; and the AI’s suggestions waiting for a person.',
  input: MemoryListInput,
  output: MemoryListOutput,
  permission: 'realestate.use',
  scope: inWorkspace,
  ai: {
    tool: 'realestate_buyer_memory',
    description: 'What’s remembered about what a buyer wants, from their own words.',
  },
  async handler(ctx, input) {
    const deal = await loadDeal(ctx, input.dealId);
    const list = await ctx.tx
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.dealRecordId, deal.recordId),
          ...(input.includeClosed ? [] : [inArray(memoryItems.status, ['suggested', 'confirmed'])]),
        ),
      )
      .orderBy(desc(memoryItems.createdAt));
    const names = await userNames(
      ctx,
      list.flatMap((i) => [i.createdBy, i.decidedBy]),
    );
    return {
      items: list.map((i) => itemOut(i, names)),
      waiting: list.filter((i) => i.status === 'suggested').length,
    };
  },
});

/** "Must have: A fenced yard", for the Assistant and history. */
export const memoryWords = (kind: string, words: string): string =>
  `${MEMORY_KINDS[kind as keyof typeof MEMORY_KINDS] ?? 'Other'}: ${words}`;

export const memoryCommands = [memoryAdd, memoryDecide, memoryRequest, memorySuggest] as const;
export const memoryQueries = [memoryList] as const;
