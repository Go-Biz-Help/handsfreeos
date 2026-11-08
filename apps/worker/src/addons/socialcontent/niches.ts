/**
 * The niches AI Social Media Content Creator looks in (docs/socialcontent.md, decision 4).
 *
 * - **Suggest niches** (`socialcontent.niches.suggest`): from the business's profile and what its knowledge base says,
 *   the AI names its own niche (kept ticked when there isn't one yet) and 3 to 5 similar ones, each with why and the
 *   words to search each network for creators in it. Each new one waits for someone to tick it.
 * - **A niche someone added** (`socialcontent.niche.added`): the AI writes the words to search each network for it.
 *
 * What the AI says is checked in core (../../../../packages/core/src/addons/socialcontent/niches-ai.ts) before it's kept.
 */
import {
  checkedNiches,
  cleanSearches,
  NICHES_SCHEMA,
  NICHES_SYSTEM,
  NichesAnswer,
  nichesPrompt,
  SEARCHES_SCHEMA,
  SEARCHES_SYSTEM,
  SearchesAnswer,
  searchesPrompt,
} from '@hfos/core/addons/socialcontent/niches-ai';
import { nicheSearchesPut, nichesPut } from '@hfos/core/addons/socialcontent/ops/worker';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { AiAskError, askStructured } from '../../ai/ask';
import { businessText } from './business';
import type { AddonScopeContext, AddonSubscriber, AddonWorkerAction } from '../types';

/** The niches already kept here: their names, and whether one is the business's own. */
async function nichesHere(ctx: AddonScopeContext): Promise<{ names: string[]; hasOwn: boolean }> {
  const found = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ name: string; own: boolean }>(
      tx,
      sql`select name, own from addon_socialcontent.niches where workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  return { names: found.map((f) => f.name), hasOwn: found.some((f) => f.own) };
}

/** Has the AI suggest the business's niche and ones like it. How many new ones were kept. */
export async function suggestNiches(ctx: AddonScopeContext): Promise<number> {
  const here = await nichesHere(ctx);
  const business = await businessText(ctx);
  const { value } = await askStructured(ctx, ctx.scope, {
    system: NICHES_SYSTEM,
    messages: [{ role: 'user', content: nichesPrompt({ business, already: here.names }) }],
    schema: NICHES_SCHEMA,
    zod: NichesAnswer,
    maxTokens: 2000,
    usage: { source: 'addon', addonId: ctx.manifest.id },
  });
  const checked = checkedNiches(value, here.names, here.hasOwn);
  if (!checked.own && !checked.similar.length) return 0;
  const { output } = await executeCommand(
    ctx.db,
    nichesPut,
    { workspaceId: ctx.scope.workspaceId, own: checked.own, similar: checked.similar },
    ctx.actor,
    ctx.meta,
  );
  return output.added;
}

/** Suggest niches, from Creators → Niches. */
export const suggestNichesNow: AddonWorkerAction<Record<string, never>> = {
  permission: 'socialcontent.use',
  ai: {
    tool: 'socialcontent_suggest_niches',
    description:
      'Have the AI suggest the business’s own niche (when it has none yet) and 3 to 5 similar niches from its profile, for AI Social Media Content Creator to look in for creators. Each new one waits under Creators → Niches for someone to tick it.',
    autonomy: 'auto',
    keywords: ['niches', 'similar niches', 'find niches'],
  },
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async run(ctx) {
    return { added: await suggestNiches(ctx) };
  },
};

/** A niche someone added: the words to search each network for it. */
export const onNicheAdded: AddonSubscriber = async (ctx) => {
  const nicheId = ctx.event.entityId;
  if (!nicheId) return;
  const [niche] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ name: string }>(
      tx,
      sql`select name from addon_socialcontent.niches where id = ${nicheId} and workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  if (!niche) return;
  try {
    const business = await businessText(ctx);
    const { value } = await askStructured(ctx, ctx.scope, {
      system: SEARCHES_SYSTEM,
      messages: [{ role: 'user', content: searchesPrompt({ business, niche: niche.name }) }],
      schema: SEARCHES_SCHEMA,
      zod: SearchesAnswer,
      maxTokens: 800,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    await executeCommand(
      ctx.db,
      nicheSearchesPut,
      { workspaceId: ctx.scope.workspaceId, nicheId, searches: cleanSearches(value.searches) },
      ctx.actor,
      ctx.meta,
    );
  } catch (e) {
    if (!(e instanceof AiAskError) || e.retryable) throw e;
    // The niche's own name is searched instead (socialcontent.work.next).
    ctx.log.info({ code: e.code }, 'no searches written for a niche');
  }
};
