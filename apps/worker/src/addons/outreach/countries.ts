/**
 * Where the people found live (docs/outreach.md, decision 61), for the business's country setting. A check of someone
 * reads it off their profile (./checks.ts); everyone else found, in a group, asking to be friends, writing a post or
 * engaging with one, is worked out here: from the lines Facebook showed under their name when one says where they live
 * ("Lives in Austin, Texas"), seen; otherwise the AI guesses from their name, posts and groups, guessed. Core holds the
 * words and the reading (packages/core/src/addons/outreach/countries.ts) and `outreach.countries.save` keeps it.
 *
 * - It runs only while the setting skips anyone: with Anywhere, nobody's country is needed.
 * - Each run takes up to `GUESS_RUN_MOST` people, the most lately seen first, and comes back for the rest.
 * - At the day's AI limit the rest wait a few hours; an answer it can't use marks those it asked about "couldn't tell",
 *   rather than asking forever.
 */
import { outreachSettings } from '@hfos/core/addons/outreach/chat-read';
import {
  countryRuleOn,
  GUESS_BATCH,
  GUESS_RUN_MOST,
  GUESS_SCHEMA,
  GUESS_SYSTEM,
  GuessAnswer,
  guessedCountries,
  guessPrompt,
  type GuessPerson,
} from '@hfos/core/addons/outreach/countries';
import { countriesSave } from '@hfos/core/addons/outreach/ops/countries';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const GUESS_COUNTRIES_JOB = 'outreach.guess_countries';
const HOUR = 3_600_000;
/** How much of a post the AI is shown. */
const POST_MOST = 240;

/**
 * `outreach.group.saved`, `outreach.friends.saved` and `addon.settings_saved`: people new to the business, or a
 * setting that now skips some, have their countries worked out soon. The job itself checks the setting.
 */
export async function countriesWanted(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (ctx.event.eventType === 'addon.settings_saved' && p['addonId'] !== undefined)
    if (p['addonId'] !== ctx.manifest.id) return;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: GUESS_COUNTRIES_JOB,
        dedupeKey: `${GUESS_COUNTRIES_JOB}:${ctx.scope.workspaceId}`,
        // A minute's wait gathers a group's members saved a page at a time into one run.
        runAt: new Date(Date.now() + 60_000),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

/** `outreach.guess_countries`: works out where the business's people live, a run at a time. */
export async function guessCountriesJob(ctx: AddonJobContext): Promise<JobResult> {
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [installed] = await rows<{ settings: unknown }>(
      tx,
      sql`select settings from app.addon_installations
          where workspace_id = ${ws} and addon_id = ${ctx.manifest.id}`,
    );
    if (!countryRuleOn(outreachSettings(installed?.settings).countries)) return null;
    // Anyone found, not worked out yet, and not waiting for a check, which reads it off their profile.
    return rows<{
      id: string;
      name: string;
      intro: string[];
      lines: string[] | null;
      groups: string[] | null;
      posts: string[] | null;
    }>(
      tx,
      sql`select p.id, p.name, p.intro,
            (select gp.lines from addon_outreach.group_people gp where gp.profile_id = p.id
              order by gp.seen_at desc limit 1) as lines,
            array(select distinct g.name from addon_outreach.group_people gp
              join addon_outreach.groups g on g.id = gp.group_id
              where gp.profile_id = p.id and g.name is not null limit 3) as groups,
            array(select left(po.body, ${POST_MOST}) from addon_outreach.posts po
              where po.profile_id = p.id order by po.seen_at desc limit 2) as posts
          from addon_outreach.profiles p
          where p.workspace_id = ${ws} and p.country_at is null and p.friendship <> 'self'
            and not exists (select 1 from addon_outreach.checks ch
              where ch.profile_id = p.id and ch.verdict = 'waiting')
          order by p.last_seen_at desc, p.id
          limit ${GUESS_RUN_MOST + 1}`,
    );
  });
  if (!found?.length) return;
  const people: GuessPerson[] = found.slice(0, GUESS_RUN_MOST).map((p) => ({
    key: p.id,
    name: p.name,
    lines: [...(p.lines ?? []), ...p.intro],
    groups: p.groups ?? [],
    posts: p.posts ?? [],
  }));
  // What a line shows needs no AI: only the rest are asked about.
  const plain = guessedCountries(people, null);
  const seen = plain.filter((p) => p.how === 'seen');
  const ask = people.filter((p) => !seen.some((s) => s.key === p.key));
  const save = async (list: ReturnType<typeof guessedCountries>) => {
    if (!list.length) return;
    await executeCommand(
      ctx.db,
      countriesSave,
      {
        workspaceId: ws,
        people: list.map((p) => ({ profileId: p.key, country: p.country, how: p.how })),
      },
      ctx.actor,
      ctx.meta,
    );
  };
  await save(seen);
  for (let i = 0; i < ask.length; i += GUESS_BATCH) {
    const batch = ask.slice(i, i + GUESS_BATCH);
    let answer: GuessAnswer | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: GUESS_SYSTEM,
        messages: [{ role: 'user', content: guessPrompt(batch) }],
        schema: GUESS_SCHEMA,
        zod: GuessAnswer,
        maxTokens: 60 * batch.length + 100,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      answer = value;
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // The day's limit or an empty balance: the rest wait a few hours. Not set up: nothing is guessed.
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.code === 'ai_unavailable') return;
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      answer = null;
    }
    await save(guessedCountries(batch, answer));
  }
  if (found.length > GUESS_RUN_MOST) return { rescheduleAt: new Date(ctx.now) };
}
