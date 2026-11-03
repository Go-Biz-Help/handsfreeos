/**
 * The AI's read of the people a person already knows on Facebook (docs/outreach.md, decision 46): whether each of
 * their friends, or someone they've chatted with, fits one of the business's playbooks, why, who they are and a first
 * step. Core holds what the model is asked and what it may answer (packages/core/src/addons/outreach/checks.ts), and
 * `outreach.check.save` keeps it and lets go of what their pages said.
 *
 * - What the extension reads off their pages (`outreach.check.looked`) queues one read per business, so a morning's
 *   checks are read together.
 * - Each read takes a batch, the oldest first, with what HandsFreeOS knows of them and the person's own chat with them.
 * - Someone found by topic on Instagram, LinkedIn or Alignable (decision 92, a check `via = 'found'`) gets its own ask
 *   (`foundCheckSystem`): how they were found (`findFact`), the post it was on and what they said under it, against
 *   the playbooks' niche, who they're for and their problem; never a chat, as the person doesn't know them yet.
 * - One of the person's followers on Facebook who isn't a friend (decision 113, a check `via = 'follower'`) is asked
 *   about like a friend, told they follow the owner; someone in one of the business's groups there who isn't (decision
 *   116, `via = 'member'`), told which group.
 * - Someone who sent the person a friend request they haven't answered (decision 136, `via = 'request'`) gets its own
 *   ask (`requestCheckSystem`): the known check's, told they asked, with their mutual friends and where the business
 *   reaches, and it says too whether to confirm the request, delete it or leave it to the person, and why.
 * - While the business reaches only some countries, the AI also weighs where they live (decision 86): what their
 *   profile says, how many friends they have, where their mutual friends live, and how the person's own friends are
 *   spread, so it knows what "most of them" means here.
 *   At the day's AI limit the rest wait a few hours; an answer it can't use marks that one as failed, tried again in
 *   a week, rather than trying it forever.
 */
import {
  CHECK_SCHEMA,
  checkSystem,
  CheckAnswer,
  checkedAnswer,
  checkPrompt,
  FOUND_POST_MOST,
  foundCheckPrompt,
  foundCheckSystem,
  memberFact,
  reachesWords,
  REQUEST_CHECK_SCHEMA,
  RequestCheckAnswer,
  requestCheckPrompt,
  requestCheckSystem,
  type CheckPlaybook,
  type FoundCheckPlaybook,
} from '@hfos/core/addons/outreach/checks';
import { outreachSettings } from '@hfos/core/addons/outreach/chat-read';
import {
  countryRuleOn,
  whereLines,
  type MutualCountries,
} from '@hfos/core/addons/outreach/countries';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download';
import { findFact, type CheckVia, type FindHow } from '@hfos/core/addons/outreach/finds';
import { FOLLOWER_FACT } from '@hfos/core/addons/outreach/followers';
import { FOR_CUSTOMERS } from '@hfos/core/addons/outreach/ops/common';
import { checkSave, mutualCountries } from '@hfos/core/addons/outreach/ops/checks';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import {
  PlaybookDetails,
  runsOn,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const CHECK_PEOPLE_JOB = 'outreach.check_people';
/** How many people one read takes. */
export const CHECK_PEOPLE_BATCH = 20;
const HOUR = 3_600_000;

/** `outreach.check.looked`: the people waiting are read now. */
export async function checkLooked(ctx: AddonEventContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: CHECK_PEOPLE_JOB,
        dedupeKey: `${CHECK_PEOPLE_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/**
 * What's known of where the people in a batch live (decision 86): their mutual friends' countries, from the people the
 * business keeps, and how each person's own friends are spread across countries.
 */
async function whereFacts(
  ctx: AddonJobContext,
  batch: readonly {
    id: string;
    user_id: string;
    mutual_ids: string[];
    mutual_read: number | null;
  }[],
): Promise<{
  mutual: Map<string, MutualCountries>;
  own: Map<string, { code: string; n: number }[]>;
}> {
  const ws = ctx.scope.workspaceId;
  return asWorker(ctx.db, ctx.scope, async (tx) => {
    const mutual = new Map<string, MutualCountries>();
    for (const c of batch) {
      const found = await mutualCountries(tx, ws, c.mutual_ids, c.mutual_read);
      if (found) mutual.set(c.id, found);
    }
    const own = new Map<string, { code: string; n: number }[]>();
    for (const user of new Set(batch.map((c) => c.user_id)))
      own.set(
        user,
        await rows<{ code: string; n: number }>(
          tx,
          sql`select p.country as code, count(*)::int as n
              from addon_outreach.friends f join addon_outreach.profiles p on p.id = f.profile_id
              where f.workspace_id = ${ws} and f.user_id = ${user} and f.state = 'friends'
                and p.country is not null
              group by p.country order by count(*) desc, p.country limit 10`,
        ),
      );
    return { mutual, own };
  });
}

/** `outreach.check_people`: reads a batch of the business's people waiting, and comes back for the rest. */
export async function checkPeopleJob(ctx: AddonJobContext): Promise<JobResult> {
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    business: (
      await rows<{ name: string }>(tx, sql`select name from app.workspaces where id = ${ws}`)
    )[0],
    settings: (
      await rows<{ settings: unknown }>(
        tx,
        sql`select settings from app.addon_installations
            where workspace_id = ${ws} and addon_id = ${ctx.manifest.id}`,
      )
    )[0]?.settings,
    waiting: await rows<{
      id: string;
      user_id: string;
      looked_at: Date | string;
      friends_count: number | null;
      mutual_ids: string[];
      mutual_read: number | null;
      lines: string[];
      name: string;
      platform: Platform;
      intro: string[];
      mutual_friends: number | null;
      group_name: string | null;
      group_lines: string[] | null;
      member_group: string | null;
      summary: string | null;
      recent: DownloadMessage[] | null;
      via: CheckVia;
      find_how: FindHow | null;
      find_words: string | null;
      find_place: string | null;
      find_group: string | null;
      find_post: string | null;
      find_said: string | null;
    }>(
      tx,
      // Each person's own chat with them: the check is theirs, and so is the chat it reads. Someone found by topic,
      // with how they were found by that person (decision 92).
      sql`select ch.id, ch.user_id, ch.looked_at, ch.lines, ch.mutual_ids, ch.mutual_read, p.name, p.platform,
            p.intro, p.mutual_friends, p.friends_count, g.name as group_name,
            (select gp.lines from addon_outreach.group_people gp where gp.profile_id = p.id
              order by gp.seen_at desc limit 1) as group_lines,
            (select mg.name from addon_outreach.group_people gp
              join addon_outreach.groups mg on mg.id = gp.group_id
              where gp.profile_id = p.id and not gp.runs_group
              order by gp.seen_at desc limit 1) as member_group,
            c.summary, c.recent, ch.via, fd.how as find_how, fd.words as find_words, fd.place as find_place,
            fg.name as find_group, left(fpo.body, ${FOUND_POST_MOST}) as find_post, fd.said as find_said
          from addon_outreach.checks ch
          join addon_outreach.profiles p on p.id = ch.profile_id
          left join addon_outreach.groups g on g.id = p.group_id
          left join lateral (
            select c.summary, c.recent from addon_outreach.file_chats c
            where c.profile_id = p.id and c.user_id = ch.user_id order by c.last_at desc limit 1
          ) c on true
          left join addon_outreach.finds fd on fd.profile_id = p.id and fd.user_id = ch.user_id
          left join addon_outreach.groups fg on fg.id = fd.group_id
          left join addon_outreach.posts fpo on fpo.id = fd.post_id
          where ch.workspace_id = ${ws} and ch.verdict = 'waiting'
          order by ch.looked_at limit ${CHECK_PEOPLE_BATCH + 1}`,
    ),
    playbooks: await rows<{ id: string; name: string; details: unknown }>(
      tx,
      sql`select id, name, details from addon_outreach.playbooks
          where workspace_id = ${ws} and archived_at is null and ${FOR_CUSTOMERS} order by created_at`,
    ),
  }));
  if (!found.waiting.length) return;
  // Where they live matters only while the business reaches some countries and not others.
  const where = countryRuleOn(outreachSettings(found.settings).countries)
    ? await whereFacts(ctx, found.waiting.slice(0, CHECK_PEOPLE_BATCH))
    : null;
  const playbooks = found.playbooks.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success ? [{ id: p.id, name: p.name, details: read.data }] : [];
  });
  // Each person is checked against the playbooks that run on their network (data version 7).
  const toldOn = (platform: Platform): CheckPlaybook[] =>
    playbooks
      .filter((p) => runsOn(p.details, platform))
      .map((p) => ({
        name: p.name,
        offer: p.details.offer,
        audience: p.details.audience,
        signs: p.details.signs,
        skip: p.details.skip,
      }));
  // Someone found by topic is weighed against who each is for: its niche and their problem too (decision 92).
  const toldFoundOn = (platform: Platform): FoundCheckPlaybook[] =>
    playbooks
      .filter((p) => runsOn(p.details, platform))
      .map((p) => ({
        name: p.name,
        offer: p.details.offer,
        audience: p.details.audience,
        signs: p.details.signs,
        skip: p.details.skip,
        niche: p.details.niche ?? null,
        problem: p.details.problem ?? null,
      }));
  const whereOf = (person: (typeof found.waiting)[number]) =>
    where
      ? {
          where: whereLines({
            lines: [...person.lines, ...person.intro],
            friends: person.friends_count,
            mutual: person.mutual_friends,
            mutualCountries: where.mutual.get(person.id) ?? null,
            own: where.own.get(person.user_id) ?? [],
          }),
        }
      : {};
  // Where the business reaches, for what to do with a friend request (decision 136).
  const reaches = reachesWords(outreachSettings(found.settings).countries);
  /** What the known check is told of someone: what HandsFreeOS knows, their pages and their chat. */
  const knownOf = (person: (typeof found.waiting)[number]) => ({
    business: found.business?.name ?? 'the business',
    name: person.name,
    facts: [
      ...(person.group_lines ?? []),
      ...person.intro,
      ...(person.group_name && person.via !== 'member'
        ? [`Found in the group ${person.group_name}`]
        : []),
      ...(person.via === 'follower' ? [FOLLOWER_FACT] : []),
      ...(person.via === 'member' ? [memberFact(person.member_group)] : []),
      ...(person.mutual_friends
        ? [
            `${person.mutual_friends.toLocaleString('en-US')} mutual ${NETWORKS[person.platform].words.friends}`,
          ]
        : []),
    ],
    lines: person.lines,
    chat:
      person.summary || person.recent?.length
        ? { summary: person.summary, recent: person.recent ?? [] }
        : null,
    playbooks: toldOn(person.platform),
    platform: person.platform,
    ...whereOf(person),
  });
  /**
   * What the AI is asked of someone: found by topic, someone who asked to be friends (decision 136, with what to do
   * with their request), or known.
   */
  const askOf = (person: (typeof found.waiting)[number]) =>
    person.via === 'request'
      ? {
          system: requestCheckSystem(person.platform),
          content: requestCheckPrompt({
            ...knownOf(person),
            mutualFriends: person.mutual_friends,
            reaches,
          }),
          request: true,
        }
      : person.via === 'found' && person.find_how
        ? {
            system: foundCheckSystem(person.platform),
            content: foundCheckPrompt({
              business: found.business?.name ?? 'the business',
              name: person.name,
              found: findFact({
                platform: person.platform,
                how: person.find_how,
                words: person.find_words,
                place: person.find_place,
                group: person.find_group,
              }),
              post: person.find_post,
              said: person.find_said,
              facts: [...(person.group_lines ?? []), ...person.intro],
              lines: person.lines,
              playbooks: toldFoundOn(person.platform),
              platform: person.platform,
              ...whereOf(person),
            }),
          }
        : {
            system: checkSystem(person.platform),
            content: checkPrompt(knownOf(person)),
          };

  for (const person of found.waiting.slice(0, CHECK_PEOPLE_BATCH)) {
    let answer: ReturnType<typeof checkedAnswer> | null;
    try {
      const ask = askOf(person);
      const messages = [{ role: 'user' as const, content: ask.content }];
      const usage = { source: 'addon' as const, addonId: ctx.manifest.id };
      // A request check answers what to do with the request too (decision 136).
      const { value } =
        'request' in ask
          ? await askStructured(ctx, ctx.scope, {
              system: ask.system,
              messages,
              schema: REQUEST_CHECK_SCHEMA,
              zod: RequestCheckAnswer,
              maxTokens: 600,
              usage,
            })
          : await askStructured(ctx, ctx.scope, {
              system: ask.system,
              messages,
              schema: CHECK_SCHEMA,
              zod: CheckAnswer,
              maxTokens: 500,
              usage,
            });
      answer = checkedAnswer(value, playbooks);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // The day's limit or an empty balance: the rest wait a few hours. Not set up: they wait for the next look.
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.code === 'ai_unavailable') return;
      // A busy model is worth another try; one still busy waits an hour.
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      answer = null;
    }
    await executeCommand(
      ctx.db,
      checkSave,
      {
        workspaceId: ws,
        checkId: person.id,
        lookedAt: new Date(person.looked_at).toISOString(),
        answer,
      },
      ctx.actor,
      ctx.meta,
    );
  }
  if (found.waiting.length > CHECK_PEOPLE_BATCH) return { rescheduleAt: new Date(ctx.now) };
}
