/** Current offers (M18), for the Knowledge screen: newest first, with where each stands today. */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { offers } from '@hfos/db/schema';
import { localDateOf } from '../calendar/engine/zoned';
import { workspaceTimezone } from '../crm/records';
import { defineQuery } from '../kernel/define';
import { OfferListInput, OfferListOutput, type OfferOut } from '../schemas/offer';

/** Where an offer stands on a local date: running, not started, or over. */
export function offerState(
  o: { readonly startsOn: string | null; readonly endsOn: string | null },
  today: string,
): OfferOut['state'] {
  if (o.startsOn && o.startsOn > today) return 'upcoming';
  if (o.endsOn && o.endsOn < today) return 'ended';
  return 'live';
}

export const offerList = defineQuery({
  name: 'offer.list',
  description: 'The business’s offers, newest first, and whether each is running today.',
  input: OfferListInput,
  output: OfferListOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const today = localDateOf(Date.now(), await workspaceTimezone(ctx.tx, input.workspaceId));
    const list = await ctx.tx
      .select()
      .from(offers)
      .where(and(eq(offers.workspaceId, input.workspaceId), isNull(offers.archivedAt)))
      .orderBy(desc(offers.createdAt));
    return {
      offers: list.map((o) => ({
        id: o.id,
        name: o.name,
        details: o.details,
        startsOn: o.startsOn,
        endsOn: o.endsOn,
        state: offerState(o, today),
        updatedAt: o.updatedAt.toISOString(),
      })),
    };
  },
});
