/**
 * AI Social Media Content Creator setting itself up (docs/socialcontent.md, "Setting up on its own"; the owner's
 * decisions 28 to 33, 12 Nov 2026). Once the add-on is on and a reading computer is picked, with no press:
 *
 * 1. it ticks the business's own niche and the 2 closest (decision 29);
 * 2. it searches them for creators on each network studied;
 * 3. once the searches end, the AI scores how close each suggested creator is to what the business does, their
 *    profiles are read again for their latest likes and comments, and the best 10 on each network are studied
 *    (decision 30); the notes and the Playbook follow as before;
 * 4. it fills the calendar once the Playbook is written, or 3 days after it started, and only once the main offer is
 *    live and its lists for content are all filled (decision 32). Each post still waits for an OK (decision 33).
 *
 * Each month it swaps out creators it picked that stopped posting or rarely stand out, never ones a person ticked or
 * added, and picks again once the month's searches end (decision 31). Every step is a person's to change: Settings
 * turns picking on its own off, and niches and creators can be ticked and skipped as ever.
 *
 * `socialcontent.setup` runs the next step, again whenever something it waits on happens, and every few hours until
 * it has written.
 */
import {
  checkedMatches,
  MATCH_SCHEMA,
  MATCH_SYSTEM,
  MatchAnswer,
  matchPrompt,
} from '@hfos/core/addons/socialcontent/match-ai';
import {
  PICKING,
  pickCreators,
  RECENT_FROM_VERSION,
  swapsFor,
  versionAtLeast,
  writeFrom,
  writeWaitsOn,
  type SetupMarks,
} from '@hfos/core/addons/socialcontent/picking';
import {
  aiPicked,
  creatorsMatched,
  creatorsPick,
  creatorsToWeigh,
  setupFactsOf,
  setupMark,
  studyingOn,
  type CreatorToWeigh,
} from '@hfos/core/addons/socialcontent/ops/setup';
import { workQueue } from '@hfos/core/addons/socialcontent/ops/worker';
import {
  CONTENT_NETWORK_INFO,
  isContentNetwork,
  type ContentNetwork,
} from '@hfos/core/addons/socialcontent/networks';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonJobHandler, AddonScopeContext, AddonSubscriber } from '../types';
import { businessText } from './business';
import { queueFill } from './content';
import { suggestNiches } from './niches';

export const SETUP_JOB = 'socialcontent.setup';
/** Looked at again this often until it has written, beside the events that move it on. */
const CHECK_MS = 6 * 60 * 60_000;
/** A busy AI is asked again this soon. */
const AI_AGAIN_MS = 15 * 60_000;

/** Runs the next step of setting up, now or a little later. */
export async function queueSetup(ctx: AddonScopeContext, inMs = 0): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: SETUP_JOB,
        dedupeKey: `${SETUP_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(Date.now() + inMs),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

const factsHere = (ctx: AddonScopeContext) =>
  asWorker(ctx.db, ctx.scope, (tx) => setupFactsOf(tx, ctx.scope.workspaceId));

async function mark(ctx: AddonScopeContext, marks: SetupMarks): Promise<void> {
  await executeCommand(
    ctx.db,
    setupMark,
    { workspaceId: ctx.scope.workspaceId, marks },
    ctx.actor,
    ctx.meta,
  );
}

/** The reading computer, as the settings say: whether there is one, and whether its extension reads latest posts. */
async function readerHere(
  ctx: AddonScopeContext,
): Promise<{ set: boolean; readsRecent: boolean; networks: ContentNetwork[] }> {
  const [s] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      reader_user_id: string | null;
      reader_version: string | null;
      networks: string[] | null;
    }>(
      tx,
      sql`select reader_user_id, reader_version, networks from addon_socialcontent.settings
          where workspace_id = ${ctx.scope.workspaceId}`,
    ),
  );
  return {
    set: !!s?.reader_user_id,
    readsRecent: versionAtLeast(s?.reader_version ?? null, RECENT_FROM_VERSION),
    networks: (s?.networks ?? ['instagram']).filter(
      (n): n is ContentNetwork => isContentNetwork(n) && CONTENT_NETWORK_INFO[n].ready,
    ),
  };
}

/**
 * Has the AI say how close each suggested creator not yet scored is to what the business does (decision 30), a few
 * at a time, up to the most in one run. A refusal for the AI's limit or the balance stops it; what's scored stays.
 */
async function matchCreators(
  ctx: AddonScopeContext,
  unscored: readonly CreatorToWeigh[],
): Promise<void> {
  if (!unscored.length) return;
  const niches = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ name: string }>(
      tx,
      sql`select name from addon_socialcontent.niches
          where workspace_id = ${ctx.scope.workspaceId} and state = 'picked' order by own desc, created_at`,
    ),
  );
  const business = await businessText(ctx);
  const list = unscored.slice(0, PICKING.matchRunMost);
  for (let i = 0; i < list.length; i += PICKING.matchBatch) {
    const batch = list.slice(i, i + PICKING.matchBatch);
    const { value } = await askStructured(ctx, ctx.scope, {
      system: MATCH_SYSTEM,
      messages: [
        {
          role: 'user',
          content: matchPrompt({ business, niches: niches.map((n) => n.name), creators: batch }),
        },
      ],
      schema: MATCH_SCHEMA,
      zod: MatchAnswer,
      maxTokens: 2000,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    const matches = checkedMatches(value, batch);
    if (matches.length)
      await executeCommand(
        ctx.db,
        creatorsMatched,
        { workspaceId: ctx.scope.workspaceId, matches },
        ctx.actor,
        ctx.meta,
      );
  }
}

/**
 * Picks who to study (decision 30): the AI scores the suggested creators it hasn't, the closest are read again
 * first when they need it, and the best 10 on each network are studied, counting those already studied.
 */
export async function pickNow(ctx: AddonScopeContext): Promise<{ picked: number; asked: number }> {
  const reader = await readerHere(ctx);
  const weigh = () =>
    asWorker(ctx.db, ctx.scope, async (tx) => ({
      candidates: await creatorsToWeigh(tx, ctx.scope.workspaceId, reader.networks),
      studying: await studyingOn(tx, ctx.scope.workspaceId),
    }));
  let here = await weigh();
  const roomy = reader.networks.some((n) => (here.studying[n] ?? 0) < PICKING.perNetwork);
  if (!roomy) return { picked: 0, asked: 0 };
  const unscored = here.candidates.filter((c) => c.match === null);
  if (unscored.length) {
    await matchCreators(ctx, unscored);
    here = await weigh();
  }
  const { pick, readFirst } = pickCreators({
    candidates: here.candidates,
    studying: here.studying,
    networks: reader.networks,
    canRead: reader.set,
    readsRecent: reader.readsRecent,
    now: Date.now(),
  });
  if (!pick.length && !readFirst.length) return { picked: 0, asked: 0 };
  const { output } = await executeCommand(
    ctx.db,
    creatorsPick,
    {
      workspaceId: ctx.scope.workspaceId,
      pick: pick.map((p) => p.id),
      swap: [],
      read: readFirst.map((r) => r.id),
    },
    ctx.actor,
    ctx.meta,
  );
  return { picked: output.picked, asked: output.asked };
}

/** The monthly swap (decision 31): creators the AI picked that stopped posting or rarely stand out. */
export async function swapQuiet(ctx: AddonScopeContext): Promise<number> {
  const picked = await asWorker(ctx.db, ctx.scope, (tx) => aiPicked(tx, ctx.scope.workspaceId));
  const swap = swapsFor(picked, Date.now());
  if (!swap.length) return 0;
  const { output } = await executeCommand(
    ctx.db,
    creatorsPick,
    {
      workspaceId: ctx.scope.workspaceId,
      pick: [],
      swap: swap.map((s) => ({ creatorId: s.id, why: s.why })),
      read: [],
    },
    ctx.actor,
    ctx.meta,
  );
  return output.swapped;
}

/**
 * Takes the next steps of setting up there are to take now (see the top of this file), and says when to look again:
 * null once it has written, or while there's no reading computer (picking one starts it again).
 */
export async function advanceSetup(ctx: AddonScopeContext): Promise<Date | null> {
  let f = await factsHere(ctx);
  if (!f.readerSet) return null;
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  if (!f.marks.startedAt) {
    await mark(ctx, { startedAt: stamp });
    f = await factsHere(ctx);
  }
  if (f.autoPick && !f.marks.nichesAt) {
    if (!f.nichesPicked) await suggestNiches(ctx, 2);
    await mark(ctx, { nichesAt: stamp });
    f = await factsHere(ctx);
  }
  if (f.autoPick && f.marks.nichesAt && !f.marks.findAt) {
    await executeCommand(
      ctx.db,
      workQueue,
      { workspaceId: ctx.scope.workspaceId, kind: 'find', askedFor: 'person' },
      ctx.actor,
      ctx.meta,
    );
    await mark(ctx, { findAt: stamp });
    f = await factsHere(ctx);
  }
  if (f.autoPick && f.marks.findAt && !f.findsLeft && !f.readsLeft) {
    const done = await pickNow(ctx);
    if (done.picked || done.asked) f = await factsHere(ctx);
  }
  if (!f.marks.writeAt) {
    if (f.filledAt) await mark(ctx, { writeAt: f.filledAt });
    else if (f.autoFill && writeWaitsOn(f, now) === null) {
      await queueFill(ctx, new Date(now), true);
      await mark(ctx, { writeAt: stamp });
    } else {
      // Looked at again in a few hours, or when the 3 days are up if that's sooner.
      const from = writeFrom(f.marks);
      return new Date(
        from !== null && from > now ? Math.min(from + 60_000, now + CHECK_MS) : now + CHECK_MS,
      );
    }
  }
  return null;
}

/** `socialcontent.setup`: the next steps, then again later while it hasn't written. */
export const runSetup: AddonJobHandler = async (ctx) => {
  try {
    const next = await advanceSetup(ctx);
    return next ? { rescheduleAt: next } : undefined;
  } catch (e) {
    if (!(e instanceof AiAskError)) throw e;
    // A busy model is worth another try soon; the AI's limit or the balance, later.
    if (e.retryable && ctx.attempt < 3) throw e;
    ctx.log.info({ code: e.code }, 'content setup waits for the AI');
    return { rescheduleAt: new Date(ctx.now + (e.retryable ? AI_AGAIN_MS : CHECK_MS)) };
  }
};

/** A search or a profile read ended: picking may go on (decision 30). */
export const onWorkFinished: AddonSubscriber = async (ctx) => {
  const kind = (ctx.event.payload as { kind?: unknown } | null)?.kind;
  if (kind === 'find' || kind === 'profile') await queueSetup(ctx);
};

/** The Playbook written, or the main offer's lists saved: writing may start (decision 32). */
export const onSetupMayGoOn: AddonSubscriber = async (ctx) => {
  await queueSetup(ctx);
};
