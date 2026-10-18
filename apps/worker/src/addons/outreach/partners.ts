/**
 * The AI's partner check (docs/outreach.md, decision 81): whether someone the person's computer read could send the
 * business its customers, by a partner playbook's audience, fit first and size second; what kind of partner they are,
 * who their audience is and how big, why, and a first warm-up. Core holds what the model is asked and what it may
 * answer (packages/core/src/addons/outreach/partners.ts), and `outreach.partner.save` keeps it and lets go of what
 * their profile said.
 *
 * - What the extension reads off a profile (`outreach.partner.looked`) queues one read per business, as the customer
 *   checks do (./checks.ts).
 * - Each read takes a batch, the oldest first, with what HandsFreeOS knows of them: the groups they run and how big,
 *   their followers, and the lines under their name. At the day's AI limit the rest wait a few hours; an answer it
 *   can't use marks that one as failed, tried again in a week.
 */
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { partnerSave } from '@hfos/core/addons/outreach/ops/partners';
import {
  checkedPartnerAnswer,
  PARTNER_SCHEMA,
  PartnerAnswer,
  partnerKindsOf,
  partnerPrompt,
  partnerSystem,
  type PartnerPlaybook,
} from '@hfos/core/addons/outreach/partners';
import {
  forPartners,
  PARTNER_GOAL,
  PlaybookDetails,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const CHECK_PARTNERS_JOB = 'outreach.check_partners';
/** How many one read takes. */
export const CHECK_PARTNERS_BATCH = 20;
/** The groups someone runs that the AI is told about, the biggest first. */
const GROUPS_TOLD = 5;
const HOUR = 3_600_000;

/** `outreach.partner.looked`: the people waiting are read now. */
export async function partnerLooked(ctx: AddonEventContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: CHECK_PARTNERS_JOB,
        dedupeKey: `${CHECK_PARTNERS_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

const count = (n: number) => n.toLocaleString('en-US');

/** What HandsFreeOS knows of someone, as the partner check is told it: their groups, their following, their lines. */
export function partnerFacts(person: {
  readonly platform: Platform;
  readonly intro: readonly string[];
  readonly followers: number | null;
  readonly mutual_friends: number | null;
  readonly groups: readonly { name: string | null; members: number | null; who: string | null }[];
}): string[] {
  return [
    ...person.groups.map((g) =>
      [
        `Runs the group ${g.name ?? 'with no name shown'}`,
        g.members !== null ? ` (${count(g.members)} members)` : '',
        g.who ? `: ${g.who}` : '',
      ].join(''),
    ),
    ...(person.followers !== null ? [`${count(person.followers)} followers`] : []),
    ...person.intro,
    ...(person.mutual_friends
      ? [`${count(person.mutual_friends)} mutual ${NETWORKS[person.platform].words.friends}`]
      : []),
  ];
}

/** `outreach.check_partners`: reads a batch of the business's people waiting, and comes back for the rest. */
export async function checkPartnersJob(ctx: AddonJobContext): Promise<JobResult> {
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    business: (
      await rows<{ name: string }>(tx, sql`select name from app.workspaces where id = ${ws}`)
    )[0],
    waiting: await rows<{
      id: string;
      looked_at: Date | string;
      lines: string[];
      name: string;
      platform: Platform;
      intro: string[];
      followers: number | null;
      mutual_friends: number | null;
      groups: { name: string | null; members: number | null; who: string | null }[] | null;
    }>(
      tx,
      sql`select pa.id, pa.looked_at, pa.lines, p.name, p.platform, p.intro, p.followers, p.mutual_friends,
            (select json_agg(json_build_object('name', g.name, 'members', g.members, 'who', g.check_who)
                order by g.members desc nulls last)
              from (select g.* from addon_outreach.group_people gp
                join addon_outreach.groups g on g.id = gp.group_id
                where gp.profile_id = p.id and gp.runs_group
                order by g.members desc nulls last limit ${GROUPS_TOLD}) g) as groups
          from addon_outreach.partners pa
          join addon_outreach.profiles p on p.id = pa.profile_id
          where pa.workspace_id = ${ws} and pa.fit = 'waiting'
          order by pa.looked_at limit ${CHECK_PARTNERS_BATCH + 1}`,
    ),
    playbooks: await rows<{ id: string; name: string; details: unknown }>(
      tx,
      sql`select id, name, details from addon_outreach.playbooks
          where workspace_id = ${ws} and archived_at is null and (details ->> 'goal') = ${PARTNER_GOAL}
          order by created_at`,
    ),
  }));
  if (!found.waiting.length) return;
  const playbooks = found.playbooks.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success && forPartners(read.data)
      ? [{ id: p.id, name: p.name, details: read.data }]
      : [];
  });

  for (const person of found.waiting.slice(0, CHECK_PARTNERS_BATCH)) {
    // Only the partner playbooks on their network: with none, there's nothing to check them against.
    const theirs = playbooks.filter((p) => p.details.platforms.includes(person.platform));
    const told: PartnerPlaybook[] = theirs.map((p) => ({
      name: p.name,
      offer: p.details.offer,
      audience: p.details.audience,
      signs: p.details.signs,
      skip: p.details.skip,
      niche: p.details.niche ?? null,
      area: p.details.area,
      kinds: partnerKindsOf(p.details),
    }));
    let answer: ReturnType<typeof checkedPartnerAnswer> | null = null;
    if (told.length)
      try {
        const { value } = await askStructured(ctx, ctx.scope, {
          system: partnerSystem(person.platform),
          messages: [
            {
              role: 'user',
              content: partnerPrompt({
                business: found.business?.name ?? 'the business',
                name: person.name,
                facts: partnerFacts({ ...person, groups: person.groups ?? [] }),
                lines: person.lines,
                playbooks: told,
                platform: person.platform,
              }),
            },
          ],
          schema: PARTNER_SCHEMA,
          zod: PartnerAnswer,
          maxTokens: 500,
          usage: { source: 'addon', addonId: ctx.manifest.id },
        });
        answer = checkedPartnerAnswer(value, theirs);
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
      }
    await executeCommand(
      ctx.db,
      partnerSave,
      {
        workspaceId: ws,
        partnerId: person.id,
        lookedAt: new Date(person.looked_at).toISOString(),
        answer,
      },
      ctx.actor,
      ctx.meta,
    );
  }
  if (found.waiting.length > CHECK_PARTNERS_BATCH) return { rescheduleAt: new Date(ctx.now) };
}
