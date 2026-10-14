/**
 * The business's main offer, for its page and the add-ons' screens: the live version, the draft being edited with
 * its score and what it still needs, and every version published. Read by everyone in the business; kept, and read,
 * while no add-on that uses it is on (`inUse` says so, and the screens hide it).
 */
import { and, desc, eq } from 'drizzle-orm';
import { mainOfferVersions, mainOffers, users } from '@hfos/db/schema';
import { ADDON_CATALOG } from '../addons/catalog';
import { addonsUsing, coreFeatureRunning } from '../addons/capabilities';
import { loadActiveAddons } from '../addons/load';
import { defineQuery } from '../kernel/define';
import {
  MAIN_OFFER_BAR,
  MainOfferParts,
  MainOfferScore,
  missingParts,
  SCORED_PARTS,
} from '../main-offer/parts';
import {
  MainOfferGetInput,
  MainOfferGetOutput,
  MainOfferVersionsInput,
  MainOfferVersionsOutput,
  type MainOfferVersionOut,
} from '../schemas/main-offer';

const person = (id: string | null, name: string | null) =>
  id ? { id, name: name?.trim() || 'Someone' } : null;

export const mainOfferGet = defineQuery({
  name: 'main_offer.get',
  description:
    'The business’s main offer: the live version, the draft being edited with its score and what it still needs, and whether an add-on that uses it is on.',
  input: MainOfferGetInput,
  output: MainOfferGetOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const running = await loadActiveAddons(ctx.tx, input.workspaceId);
    const [row] = await ctx.tx
      .select({ offer: mainOffers, byName: users.fullName })
      .from(mainOffers)
      .leftJoin(users, eq(users.id, mainOffers.draftBy))
      .where(eq(mainOffers.workspaceId, input.workspaceId));
    const offer = row?.offer;
    let live: MainOfferVersionOut | null = null;
    if (offer?.liveVersion) {
      const [v] = await ctx.tx
        .select({ v: mainOfferVersions, byName: users.fullName })
        .from(mainOfferVersions)
        .leftJoin(users, eq(users.id, mainOfferVersions.publishedBy))
        .where(
          and(
            eq(mainOfferVersions.workspaceId, input.workspaceId),
            eq(mainOfferVersions.version, offer.liveVersion),
          ),
        );
      if (v)
        live = {
          version: v.v.version,
          parts: MainOfferParts.parse(v.v.parts),
          line: v.v.line,
          score: MainOfferScore.parse(v.v.score),
          anyway: v.v.anyway,
          publishedBy: person(v.v.publishedBy, v.byName),
          publishedAt: v.v.publishedAt.toISOString(),
        };
    }
    const draftParts = offer?.draft ? MainOfferParts.parse(offer.draft) : null;
    const scored = offer?.score && offer.scoredRevision === offer.revision;
    return {
      inUse: coreFeatureRunning(ADDON_CATALOG, running, 'main_offer'),
      comesWith: addonsUsing(ADDON_CATALOG, 'main_offer'),
      bar: MAIN_OFFER_BAR,
      revision: offer?.revision ?? 0,
      live,
      draft:
        offer && draftParts
          ? {
              parts: draftParts,
              by: person(offer.draftBy, row?.byName ?? null),
              at: offer.draftAt?.toISOString() ?? null,
              score: scored ? MainOfferScore.parse(offer.score) : null,
              missing: missingParts(draftParts),
            }
          : null,
    };
  },
});

export const mainOfferVersionList = defineQuery({
  name: 'main_offer.versions',
  description: 'Every version of the main offer published, the newest first.',
  input: MainOfferVersionsInput,
  output: MainOfferVersionsOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const list = await ctx.tx
      .select({ v: mainOfferVersions, byName: users.fullName })
      .from(mainOfferVersions)
      .leftJoin(users, eq(users.id, mainOfferVersions.publishedBy))
      .where(eq(mainOfferVersions.workspaceId, input.workspaceId))
      .orderBy(desc(mainOfferVersions.version));
    return {
      versions: list.map(({ v, byName }) => {
        const score = MainOfferScore.parse(v.score);
        return {
          version: v.version,
          line: v.line,
          lowest: Math.min(...SCORED_PARTS.map((p) => score.parts[p].score)),
          anyway: v.anyway,
          publishedBy: person(v.publishedBy, byName),
          publishedAt: v.publishedAt.toISOString(),
        };
      }),
    };
  },
});
