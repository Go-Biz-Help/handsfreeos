/**
 * A lead in the pipeline for whoever wants a demo (../leads.ts, docs/outreach.md decision 105). What can show it —
 * the AI's read of a chat, an answer, the person's Ready mark, a demo booked or marked — asks for it (`wantLead`,
 * `outreach.lead.wanted`); the worker then has `outreach.lead.open` look again and open it as the system, through
 * core's `lead.create`, so it lands in the main pipeline's first stage.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { leads, people, pipelines, pipelineStages, workspaces } from '@hfos/db/schema';
import { rows, sql } from '@hfos/db/client';
import { automationSettingsOf } from '../../../automations/settings';
import { leadCreate } from '../../../commands/lead.create';
import { leadMoveStage } from '../../../commands/lead.move_stage';
import { leadWaitForOutcome } from '../../../commands/lead.wait_for_outcome';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { addonTimelineLine, defineAddonCommand } from '../../server';
import {
  DEMO_LOST_WHY,
  DemoHeldInput,
  DemoHeldOutput,
  DemoOutcomeInput,
  DemoOutcomeOutput,
  LeadOpenInput,
  LeadOpenOutput,
  leadSourceOf,
  leadTitleOf,
  stageAfterDemo,
  type LeadSkip,
} from '../leads';
import { outreachAddon } from '../manifest';
import { PLATFORMS } from '../networks';
import { demos, profiles } from '../tables';
import { contactable, inWorkspace, isClient, pitchable, saveProfile, type Ctx } from './common';
import { playbooksInUse } from './friends';
import { keepMarks } from './stages';

/**
 * Asks for a lead for someone the person `me` reached, when nothing has opened one for them yet: the worker looks
 * again (`outreach.lead.open`). Whatever asks declares `outreach.lead.wanted` among its events.
 */
export async function wantLead(ctx: CommandContext, me: string, profileId: string): Promise<void> {
  const [profile] = await ctx.tx
    .select({ leadAt: profiles.leadAt })
    .from(profiles)
    .where(and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, profileId)));
  if (!profile || profile.leadAt) return;
  await ctx.emit({
    type: 'outreach.lead.wanted',
    entityType: 'outreach_profile',
    entityId: profileId,
    payload: { userId: me },
  });
}

/**
 * Whether someone wants the offer, for the person `me`, as Today's Pitch reads it: the AI read their chat as ready,
 * the person marked them ready, they said yes to the step before the link (the video, or the first message when the
 * playbooks have no video), or a demo was booked or marked. `p` is the profile's alias.
 */
export const wantsTheOffer = (me: string, p: string, hasVideo: boolean) => sql`(
  exists (select 1 from addon_outreach.file_chats wc
    where wc.profile_id = ${sql.raw(p)}.id and wc.user_id = ${me} and wc.pitch = 'ready')
  or exists (select 1 from addon_outreach.stages ws
    where ws.profile_id = ${sql.raw(p)}.id and ws.user_id = ${me} and ws.mark = 'ready')
  or exists (select 1 from addon_outreach.follow_ups wf
    where wf.profile_id = ${sql.raw(p)}.id and wf.user_id = ${me} and wf.answer = 'yes'
      and (wf.step = 'video' or (wf.step = 'first' and not ${hasVideo})))
  or exists (select 1 from addon_outreach.demos wd
    where wd.profile_id = ${sql.raw(p)}.id and wd.user_id = ${me} and wd.undone_at is null))`;

/** The business's main pipeline, as `lead.create` picks it, when it has an open stage to start a lead in. */
async function mainPipelineReady(ctx: Ctx): Promise<boolean> {
  const [pipeline] = await ctx.tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, ctx.scope.workspaceId!), isNull(pipelines.archivedAt)))
    .orderBy(asc(pipelines.position), asc(pipelines.createdAt))
    .limit(1);
  if (!pipeline) return false;
  const [open] = await ctx.tx
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(and(eq(pipelineStages.pipelineId, pipeline.id), eq(pipelineStages.kind, 'open')))
    .limit(1);
  return !!open;
}

/** Whether a customer is still here: not in the Deleted bin, nor erased. */
async function livePerson(ctx: Ctx, personId: string): Promise<boolean> {
  const [row] = await ctx.tx
    .select({ id: people.id })
    .from(people)
    .where(
      and(
        eq(people.id, personId),
        eq(people.workspaceId, ctx.scope.workspaceId!),
        isNull(people.binItemId),
        isNull(people.erasedAt),
      ),
    );
  return !!row;
}

export const leadOpen = defineAddonCommand(outreachAddon, {
  name: 'outreach.lead.open',
  description:
    'Worker: someone the person reached wants a demo or answered the playbook’s questions: they go in Contacts, and a lead goes in the main pipeline’s first stage, marked with the network and group they came from and assigned to whoever reached them. Once a profile; their open lead is used when they have one.',
  risk: 1,
  input: LeadOpenInput,
  output: LeadOpenOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.lead.opened'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const skip = (skipped: LeadSkip, leadId: string | null = null) => ({
      leadId,
      opened: false,
      skipped,
    });
    const [profile] = await ctx.tx
      .select()
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)))
      .for('update');
    if (!profile) return skip('gone');
    if (profile.leadAt) return skip('had_one', profile.leadId);
    // Whoever reached them still does outreach here: a teammate who left opens nothing.
    const [member] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select true as ok from app.workspace_access
          where workspace_id = ${ws} and user_id = ${input.userId}
            and 'outreach.use' = any (permissions)`,
    );
    if (!member) return skip('gone');
    const hasVideo = (await playbooksInUse(ctx, profile.platform)).some(
      (p) => !!p.details.videoLink,
    );
    const [standing] = await rows<{ open: boolean; wants: boolean; group_name: string | null }>(
      ctx.tx,
      sql`select (${contactable('p')} and ${pitchable('p')} and not ${isClient('p')}) as open,
            ${wantsTheOffer(input.userId, 'p', hasVideo)} as wants,
            coalesce(g.name, (select g2.name from addon_outreach.group_people gp
              join addon_outreach.groups g2 on g2.id = gp.group_id
              where gp.profile_id = p.id order by gp.seen_at limit 1)) as group_name
          from addon_outreach.profiles p
          left join addon_outreach.groups g on g.id = p.group_id
          where p.id = ${profile.id}`,
    );
    // Never contact, Don't pitch, a partner or a client gets no lead from here.
    if (!standing?.open) return skip('not_open');
    if (!standing.wants) return skip('not_yet');
    if (!(await mainPipelineReady(ctx))) return skip('no_pipeline');

    // Their customer was deleted: a lead doesn't bring them back.
    if (profile.personId && !(await livePerson(ctx, profile.personId))) return skip('gone');
    // Booked through the demo link, they're a customer already: the booking's, when the profile has none.
    const [booked] = profile.personId
      ? []
      : await ctx.tx
          .select({ personId: demos.personId })
          .from(demos)
          .innerJoin(people, eq(people.id, demos.personId))
          .where(
            and(
              eq(demos.profileId, profile.id),
              eq(demos.userId, input.userId),
              eq(demos.how, 'link'),
              isNull(demos.undoneAt),
              eq(people.workspaceId, ws),
              isNull(people.binItemId),
              isNull(people.erasedAt),
            ),
          )
          .orderBy(desc(demos.at))
          .limit(1);
    const saved = await saveProfile(ctx, {
      platform: profile.platform,
      profile: { id: profile.platformId, username: profile.username, url: profile.url },
      name: profile.name,
      ...(booked?.personId ? { personId: booked.personId } : {}),
    });
    const [open] = await ctx.tx
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.workspaceId, ws),
          eq(leads.personId, saved.personId),
          eq(leads.status, 'open'),
          isNull(leads.archivedAt),
        ),
      )
      .orderBy(asc(leads.createdAt))
      .limit(1);
    const leadId =
      open?.id ??
      (
        await executeCommandWithin(ctx, leadCreate, {
          workspaceId: ws,
          title: leadTitleOf(saved.personName, profile.platform),
          personId: saved.personId,
          source: leadSourceOf(profile.platform, standing.group_name),
          assigneeUserId: input.userId,
        })
      ).output.leadId;
    // After the demo, the person says won or lost: a done visit never wins it on its own (decision 106).
    await executeCommandWithin(ctx, leadWaitForOutcome, { workspaceId: ws, leadId });
    await ctx.tx
      .update(profiles)
      .set({ leadId, leadAt: at, updatedAt: at })
      .where(eq(profiles.id, profile.id));
    // Marked with where they came from, on a lead it found too.
    await addonTimelineLine(ctx, outreachAddon, {
      personId: saved.personId,
      leadId,
      words: `${open ? 'noted on their lead' : 'put them in your pipeline'}: they want a demo, from ${PLATFORMS[profile.platform]}`,
      ...(standing.group_name ? { body: `Found in ${standing.group_name}` } : {}),
    });
    await ctx.emit({
      type: 'outreach.lead.opened',
      entityType: 'outreach_profile',
      entityId: profile.id,
      payload: { leadId, userId: input.userId, opened: !open },
    });
    return { leadId, opened: !open, skipped: null };
  },
});

/** A lead's pipeline's stages, as Automations' roles read them. */
async function stagesOf(ctx: Ctx, pipelineId: string) {
  return (
    await ctx.tx
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        kind: pipelineStages.kind,
        position: pipelineStages.position,
      })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
  ).map((s) => ({ ...s, position: Number(s.position) }));
}

export const demoHeld = defineAddonCommand(outreachAddon, {
  name: 'outreach.demo.held',
  description:
    'Worker: a demo booked through a person’s demo link was done and they came. Their lead in the pipeline moves on past the stage for a visit booked, and waits for the person to mark it won or lost.',
  risk: 1,
  input: DemoHeldInput,
  output: DemoHeldOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    // Each lead opened for someone who came to it: a lead still open, in a pipeline still there.
    const held = await rows<{ lead_id: string; pipeline_id: string; stage_id: string }>(
      ctx.tx,
      sql`select distinct l.id as lead_id, l.pipeline_id, l.stage_id
          from addon_outreach.demos d
          join addon_outreach.profiles p on p.id = d.profile_id
          join app.leads l on l.id = p.lead_id and l.status = 'open' and l.archived_at is null
          join app.appointment_attendees aa on aa.appointment_id = d.appointment_id
            and aa.person_id = d.person_id and aa.status = 'attended'
          where d.workspace_id = ${ws} and d.appointment_id = ${input.appointmentId}
            and d.how = 'link' and d.undone_at is null`,
    );
    if (!held.length) return { moved: [] };
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    const roles = automationSettingsOf(w?.settings as Record<string, unknown> | null).pipeline
      .roles;
    const moved: { leadId: string; stageId: string }[] = [];
    for (const h of held) {
      const to = stageAfterDemo(await stagesOf(ctx, h.pipeline_id), roles, h.stage_id);
      if (!to) continue;
      await executeCommandWithin(ctx, leadMoveStage, {
        workspaceId: ws,
        leadId: h.lead_id,
        stageId: to.id,
        because: 'The demo is done',
      });
      moved.push({ leadId: h.lead_id, stageId: to.id });
    }
    return { moved };
  },
});

export const demoOutcome = defineAddonCommand(outreachAddon, {
  name: 'outreach.demo.outcome',
  description:
    'After someone’s demo, mark their lead in the pipeline won or lost. Lost marks them not a fit too, with why.',
  risk: 1,
  input: DemoOutcomeInput,
  output: DemoOutcomeOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_demo_outcome',
    keywords: ['demo went well', 'won the deal', 'lost the deal', 'how did the demo go'],
  },
  scope: inWorkspace,
  emits: ['outreach.demo.decided'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [profile] = await ctx.tx
      .select({ id: profiles.id, name: profiles.name, leadId: profiles.leadId })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)));
    if (!profile) throw HfosError.notFound('That person isn’t kept here anymore. Reload the page.');
    const [lead] = profile.leadId
      ? await ctx.tx
          .select({
            id: leads.id,
            pipelineId: leads.pipelineId,
            status: leads.status,
            archivedAt: leads.archivedAt,
          })
          .from(leads)
          .where(and(eq(leads.workspaceId, ws), eq(leads.id, profile.leadId)))
      : [];
    if (!lead || lead.archivedAt)
      throw HfosError.rule(
        'outreach_no_lead',
        409,
        `${profile.name} has no lead in your pipeline from Social Outreach. Open their customer page to see their deals.`,
      );
    if (lead.status !== 'open')
      throw HfosError.rule(
        'outreach_lead_decided',
        409,
        `${profile.name}’s lead is already ${lead.status}. To change it, open the lead from their customer page.`,
      );
    const stage = (await stagesOf(ctx, lead.pipelineId))
      .filter((s) => s.kind === input.outcome)
      .sort((a, b) => a.position - b.position)[0];
    if (!stage)
      throw HfosError.rule(
        'outreach_no_outcome_stage',
        409,
        `Your pipeline has no ${input.outcome === 'won' ? 'Won' : 'Lost'} stage. Add one in Settings → Pipelines, then try again.`,
      );
    const why = input.why ?? DEMO_LOST_WHY;
    await executeCommandWithin(ctx, leadMoveStage, {
      workspaceId: ws,
      leadId: lead.id,
      stageId: stage.id,
      ...(input.outcome === 'lost' ? { lostReason: why } : {}),
    });
    // Lost after the demo: not a fit for the person's outreach either, in their words.
    if (input.outcome === 'lost')
      await keepMarks(ctx, me, profile.id, {
        mark: 'lost',
        markedBy: 'person',
        why,
        markedAt: at,
      });
    await ctx.emit({
      type: 'outreach.demo.decided',
      entityType: 'outreach_profile',
      entityId: profile.id,
      payload: { leadId: lead.id, outcome: input.outcome },
    });
    return { profileId: profile.id, leadId: lead.id, outcome: input.outcome };
  },
});

export const leadCommands = [leadOpen, demoHeld, demoOutcome] as const;
