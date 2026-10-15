/**
 * What the coach knows about the business (docs/salescoach.md): its profile's brief and the short answers in its
 * knowledge base, quoted as data, the same grounding the AI teammate answers calls from. Read once per call.
 */
import { formatKnowledgeForPrompt, groundingBrief } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { shortKnowledge } from '../../knowledge/find';
import { loadGrounding } from '../../knowledge/grounding';
import type { AddonScopeContext } from '../types';

/** How much of the knowledge base a call reads: the short answers, within this many characters. */
const KNOWLEDGE_CHARS = 6_000;
const KNOWLEDGE_ITEMS = 30;
/** An answer longer than this is left out: the coach reads short ones live. */
const ITEM_CHARS = 1_200;

export async function businessText(ctx: AddonScopeContext): Promise<string> {
  try {
    return await asWorker(ctx.db, ctx.scope, async (tx) => {
      const grounding = await loadGrounding(tx, ctx.scope.workspaceId);
      const items = await shortKnowledge(tx, {
        workspaceId: ctx.scope.workspaceId,
        limit: KNOWLEDGE_ITEMS,
        itemChars: ITEM_CHARS,
      });
      return [groundingBrief(grounding), formatKnowledgeForPrompt(items, KNOWLEDGE_CHARS)].join(
        '\n',
      );
    });
  } catch (e) {
    // The coach still has the playbook: nothing here stops a call being coached.
    ctx.log.warn({ err: e }, 'couldn’t read what the business knows for a coached call');
    return '<business_profile>\n(not available)\n</business_profile>';
  }
}
