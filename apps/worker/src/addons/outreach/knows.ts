/**
 * What the business knows, for what Social Outreach's AI writes (docs/outreach.md decision 122): its profile's brief
 * and its Knowledge, as the AI Teammate answers from them, read in the business's own scope. The items that match what
 * they wrote come first, a little of each, then the short answers and facts whole, the most used first (core's
 * packages/core/src/addons/outreach/knows.ts says how a prompt is told them). Nothing here stops a draft: when it
 * can't be read, the AI is told it isn't available and says nothing of the business it wasn't given.
 */
import {
  KNOWS_FOUND,
  KNOWS_FOUND_CHARS,
  KNOWS_ITEM_CHARS,
  KNOWS_ITEMS,
  type DraftKnows,
} from '@hfos/core/addons/outreach/knows';
import { briefFromProfile } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { anyOfWords, findKnowledge, shortKnowledge } from '../../knowledge/find';
import { loadGrounding } from '../../knowledge/grounding';
import type { AddonScopeContext } from '../types';

/** The business's profile and Knowledge, with what matches `said` (their message, their post) ahead of the rest. */
export async function businessKnows(
  ctx: AddonScopeContext,
  said: readonly (string | null | undefined)[] = [],
): Promise<DraftKnows | null> {
  const ws = ctx.scope.workspaceId!;
  try {
    return await asWorker(ctx.db, ctx.scope, async (tx) => {
      const grounding = await loadGrounding(tx, ws);
      const short = await shortKnowledge(tx, {
        workspaceId: ws,
        limit: KNOWS_ITEMS,
        itemChars: KNOWS_ITEM_CHARS,
      });
      const words = anyOfWords(said.filter((s): s is string => !!s?.trim()).join(' '));
      const found = words
        ? await findKnowledge(tx, { workspaceId: ws, queries: [words], limit: KNOWS_FOUND })
        : [];
      const first = found.map((m) => ({
        id: m.id,
        kind: m.kind,
        title: m.title,
        body:
          m.body.length > KNOWS_FOUND_CHARS
            ? `${m.body.slice(0, KNOWS_FOUND_CHARS - 1).trimEnd()}…`
            : m.body,
        sourceUrl: m.sourceUrl,
      }));
      const seen = new Set(first.map((m) => m.id));
      return {
        brief: briefFromProfile(grounding.profile, grounding.business),
        items: [...first, ...short.filter((i) => !seen.has(i.id))],
        allowPrices: grounding.profile.allowPrices,
        avoid: grounding.profile.wordsToAvoid,
      };
    });
  } catch (e) {
    ctx.log.warn({ err: e }, 'couldn’t read what the business knows for an outreach draft');
    return null;
  }
}
