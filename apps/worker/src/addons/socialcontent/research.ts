/**
 * Looking things up online, in the worker (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decision 38;
 * docs/socialcontent.md, "Variety"): once a week (`socialcontent.research`) the AI searches the web for news and
 * interesting facts in the business's line of work and its customers' world, and keeps up to 10 waiting as ideas,
 * each a tip with the page it came from. The calendar writes every other tip from one when one waits. The prompts
 * are core's (packages/core/src/addons/socialcontent/research-ai.ts).
 *
 * A search is charged as `ai.web_search` (2¢) beside the AI's words. With no main offer live it waits, as every post
 * and idea does (pick 7b).
 */
import { ideasPut } from '@hfos/core/addons/socialcontent/ops/worker';
import {
  checkedFacts,
  FACTS_SCHEMA,
  FACTS_SYSTEM,
  FactsAnswer,
  factsPrompt,
  RESEARCH,
  RESEARCH_SYSTEM,
  researchPrompt,
} from '@hfos/core/addons/socialcontent/research-ai';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askSearching, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import { businessText, offerIsLive } from './business';
import type { AddonJobHandler, AddonScopeContext } from '../types';

export const RESEARCH_JOB = 'socialcontent.research';
const WEEK_MS = 7 * 86_400_000;
/** The AI's limit or the balance ran out: it looks again this much later. */
const LATER_MS = 6 * 3_600_000;

/** Queues the weekly look: `pullEarlier` brings a queued one forward; otherwise one already queued stays as it is. */
export async function queueResearch(
  ctx: AddonScopeContext,
  at: Date,
  pullEarlier = false,
): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: RESEARCH_JOB,
        dedupeKey: `${RESEARCH_JOB}:${ctx.scope.workspaceId}`,
        runAt: at,
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier },
    ),
  );
}

/** Whether it ever looked things up for this business: a fact kept, or its weekly look queued. */
export async function everResearched(ctx: AddonScopeContext): Promise<boolean> {
  const [r] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ yes: boolean }>(
      tx,
      sql`select exists (select 1 from addon_socialcontent.ideas
            where workspace_id = ${ctx.scope.workspaceId} and source_url is not null)
          or exists (select 1 from app.scheduled_jobs
            where workspace_id = ${ctx.scope.workspaceId} and kind = ${RESEARCH_JOB}) as yes`,
    ),
  );
  return r?.yes ?? false;
}

/**
 * One look: searches, writes what it found, and keeps the facts as new ideas, up to 10 waiting. How many it kept.
 * Throws AiAskError when the AI couldn't be asked.
 */
export async function researchNow(ctx: AddonScopeContext, business?: string): Promise<number> {
  const here = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const niches = await rows<{ name: string }>(
      tx,
      sql`select name from addon_socialcontent.niches
          where workspace_id = ${ctx.scope.workspaceId} and (own or state = 'picked')
          order by own desc, created_at limit 10`,
    );
    const facts = await rows<{ title: string; state: string }>(
      tx,
      sql`select title, state from addon_socialcontent.ideas
          where workspace_id = ${ctx.scope.workspaceId} and source_url is not null
          order by created_at desc limit 200`,
    );
    const titles = await rows<{ title: string }>(
      tx,
      sql`select title from addon_socialcontent.ideas where workspace_id = ${ctx.scope.workspaceId}
          order by created_at desc limit 200`,
    );
    return {
      niches: niches.map((n) => n.name),
      earlier: facts.map((f) => f.title),
      waiting: facts.filter((f) => f.state === 'new' || f.state === 'saved').length,
      titles: titles.map((t) => t.title),
    };
  });
  const room = RESEARCH.factsWaiting - here.waiting;
  if (room <= 0) return 0;
  const found = await askSearching(
    ctx,
    ctx.scope,
    {
      system: RESEARCH_SYSTEM,
      prompt: researchPrompt({
        business: business ?? (await businessText(ctx)),
        niches: here.niches,
        earlier: here.earlier,
      }),
      searches: RESEARCH.searches,
      maxTokens: RESEARCH.notesTokens,
      usage: { source: 'addon', addonId: ctx.manifest.id },
      subject: 'AI Social Media Content Creator looking up news for your posts',
    },
    RESEARCH.continues,
  );
  // No page found (the search is off, or the backup answered): nothing kept, since every fact needs its page.
  if (!found.pages.length || !found.notes) {
    ctx.log.info({ searches: found.searches }, 'the content research found no pages to keep');
    return 0;
  }
  const { value } = await askStructured(ctx, ctx.scope, {
    system: FACTS_SYSTEM,
    messages: [{ role: 'user', content: factsPrompt({ notes: found.notes, pages: found.pages }) }],
    schema: FACTS_SCHEMA,
    zod: FactsAnswer,
    maxTokens: 4000,
    usage: { source: 'addon', addonId: ctx.manifest.id },
  });
  const ideas = checkedFacts(value, found.pages, here.titles, room);
  if (!ideas.length) return 0;
  const { output } = await executeCommand(
    ctx.db,
    ideasPut,
    { workspaceId: ctx.scope.workspaceId, ideas },
    ctx.actor,
    ctx.meta,
  );
  return output.added;
}

/** `socialcontent.research`: this week's look, then next week's. With no main offer live, it waits a week. */
export const runResearch: AddonJobHandler = async (ctx) => {
  if (!(await offerIsLive(ctx))) return { rescheduleAt: new Date(ctx.now + WEEK_MS) };
  try {
    const kept = await researchNow(ctx);
    ctx.log.info({ kept }, 'the content research kept news and facts as ideas');
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    if (e.retryable && ctx.attempt < 3) throw e;
    ctx.log.info({ code: e.code }, 'the content research waits for the AI');
    return { rescheduleAt: new Date(ctx.now + LATER_MS) };
  }
  return { rescheduleAt: new Date(ctx.now + WEEK_MS) };
};
