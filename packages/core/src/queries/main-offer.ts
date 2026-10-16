/**
 * The business's main offer, for its page and the add-ons' screens: the live version, the draft being edited with
 * its score and what it still needs, the owner's direction, the AI's tries beside the draft, and every version
 * published. Read by everyone in the business; kept, and read,
 * while no add-on that uses it is on (`inUse` says so, and the screens hide it).
 */
import { and, desc, eq } from 'drizzle-orm';
import { mainOfferTries, mainOfferVersions, mainOffers, users } from '@hfos/db/schema';
import { ADDON_CATALOG } from '../addons/catalog';
import { addonsUsing, coreFeatureRunning } from '../addons/capabilities';
import { loadActiveAddons } from '../addons/load';
import { defineQuery } from '../kernel/define';
import {
  lowestScore,
  MAIN_OFFER_BAR,
  MainOfferKeep,
  MainOfferNotes,
  MainOfferParts,
  MainOfferScore,
  MainOfferTryWhy,
  missingParts,
} from '../main-offer/parts';
import {
  MainOfferGetInput,
  MainOfferGetOutput,
  MainOfferTriesInput,
  MainOfferTriesOutput,
  MainOfferVersionsInput,
  MainOfferVersionsOutput,
  type MainOfferVersionOut,
} from '../schemas/main-offer';

/** The tries a round lists at most, the newest first. */
export const MAIN_OFFER_TRIES_SHOWN = 20;

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
      direction: offer?.direction ?? null,
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
          lowest: lowestScore(score),
          anyway: v.anyway,
          publishedBy: person(v.publishedBy, byName),
          publishedAt: v.publishedAt.toISOString(),
        };
      }),
    };
  },
});

export const mainOfferTryList = defineQuery({
  name: 'main_offer.tries',
  description:
    'The AI’s tries of the main offer beside the draft since the last version went live, the newest first: each whole, with its score and what it followed.',
  input: MainOfferTriesInput,
  output: MainOfferTriesOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [offer] = await ctx.tx
      .select({ liveVersion: mainOffers.liveVersion })
      .from(mainOffers)
      .where(eq(mainOffers.workspaceId, input.workspaceId));
    const round = offer?.liveVersion ?? 0;
    const list = await ctx.tx
      .select({ t: mainOfferTries, byName: users.fullName })
      .from(mainOfferTries)
      .leftJoin(users, eq(users.id, mainOfferTries.madeBy))
      .where(
        and(eq(mainOfferTries.workspaceId, input.workspaceId), eq(mainOfferTries.round, round)),
      )
      .orderBy(desc(mainOfferTries.number))
      .limit(MAIN_OFFER_TRIES_SHOWN);
    return {
      round,
      tries: list.map(({ t, byName }) => {
        const score = MainOfferScore.parse(t.score);
        return {
          id: t.id,
          number: t.number,
          fromRevision: t.fromRevision,
          base: MainOfferParts.parse(t.base),
          parts: MainOfferParts.parse(t.parts),
          why: MainOfferTryWhy.parse(t.why),
          score,
          lowest: lowestScore(score),
          direction: t.direction,
          notes: MainOfferNotes.parse(t.notes),
          keep: MainOfferKeep.parse(t.keep),
          madeBy: person(t.madeBy, byName),
          madeAt: t.madeAt.toISOString(),
        };
      }),
    };
  },
});
