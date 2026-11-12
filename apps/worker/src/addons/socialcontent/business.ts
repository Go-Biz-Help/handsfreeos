/**
 * What AI Social Media Content Creator's AI knows about the business (docs/socialcontent.md): its profile's brief, the
 * short answers in its knowledge base, and its main offer live now with its lists for content (docs/main-offer.md,
 * "For your content"), quoted as data. Its own copy: add-ons never share code.
 *
 * Until the main offer is live, the AI writes no posts and no ideas, as Social Outreach writes no messages (the
 * owner's pick 7b, 11 Nov 2026): `requireLiveOffer` refuses, and the calendar waits for `main_offer.published`.
 */
import { offerForContent } from '@hfos/core/addons/socialcontent/offer-ai';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import {
  formatKnowledgeForPrompt,
  groundingBrief,
  HfosError,
  listsFilled,
  listsOf,
  MainOfferParts,
  OFFER_LISTS,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { shortKnowledge } from '../../knowledge/find';
import { loadGrounding } from '../../knowledge/grounding';
import type { AddonScopeContext } from '../types';

/** How much of the knowledge base it reads: the short answers, within this many characters. */
const KNOWLEDGE_CHARS = 6_000;
const KNOWLEDGE_ITEMS = 30;
const ITEM_CHARS = 1_200;

/** The main offer as it's live, and the lists for content; `parts` is null while no version is live. */
async function offerHere(tx: Tx, workspaceId: string) {
  const [o] = await rows<{ lists: unknown; parts: unknown }>(
    tx,
    sql`select o.lists, v.parts from app.main_offers o
        left join app.main_offer_versions v on v.workspace_id = o.workspace_id and v.version = o.live_version
        where o.workspace_id = ${workspaceId}`,
  );
  const parts = o?.parts ? MainOfferParts.safeParse(o.parts) : null;
  return { parts: parts?.success ? parts.data : null, lists: listsOf(o?.lists) };
}

export async function businessText(ctx: AddonScopeContext): Promise<string> {
  try {
    return await asWorker(ctx.db, ctx.scope, async (tx) => {
      const grounding = await loadGrounding(tx, ctx.scope.workspaceId);
      const items = await shortKnowledge(tx, {
        workspaceId: ctx.scope.workspaceId,
        limit: KNOWLEDGE_ITEMS,
        itemChars: ITEM_CHARS,
      });
      const offer = await offerHere(tx, ctx.scope.workspaceId);
      return [
        groundingBrief(grounding),
        formatKnowledgeForPrompt(items, KNOWLEDGE_CHARS),
        offerForContent(offer.parts, offer.lists),
      ]
        .filter(Boolean)
        .join('\n');
    });
  } catch (e) {
    ctx.log.warn({ err: e }, 'couldn’t read what the business knows for content research');
    return '<business_profile>\n(not available)\n</business_profile>';
  }
}

/** Whether the business's main offer is live. */
export async function offerIsLive(ctx: AddonScopeContext): Promise<boolean> {
  const [o] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ live: number | null }>(
      tx,
      sql`select live_version as live from app.main_offers where workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  return o?.live != null;
}

/** Refuses while the main offer isn't live: the AI writes no posts and no ideas until it is (pick 7b). */
export async function requireLiveOffer(ctx: AddonScopeContext): Promise<void> {
  if (!(await offerIsLive(ctx)))
    throw HfosError.rule('socialcontent_offer_not_live', 409, W.offer.notLive);
}

/**
 * Whether every one of the main offer's lists for content has something in it: setting up on its own writes only then
 * (decision 32), and the calendar writes from them when there's no Playbook or idea yet.
 */
export async function listsAllFilled(ctx: AddonScopeContext): Promise<boolean> {
  const { lists } = await asWorker(ctx.db, ctx.scope, (tx) => offerHere(tx, ctx.scope.workspaceId));
  return listsFilled(lists) >= OFFER_LISTS.length;
}
