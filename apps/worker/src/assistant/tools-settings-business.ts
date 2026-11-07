/**
 * The business itself, set up by asking (M12, step three): the workspace, its pipelines, the team, tags and what
 * the AI knows about the business. Same shape as the calendar ones — the command behind each settings screen, run
 * as the person, only after Confirm.
 *
 * Two of these reach past the business: inviting someone sends them an email, and removing a teammate takes their
 * way in. Both say so on the card before anyone agrees.
 */

import {
  addressLines,
  BusinessAddress,
  HfosError,
  industryFromText,
  missingPermissionMessage,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  timeZoneForAddress,
  usTimeZoneLabel,
  type IndustryOption,
  type Permission,
  type WorkspaceRole,
} from '@hfos/core';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { command, query, rehearse } from './tools-read';
import { hoursLine, settingsCard, type SettingsConfirmTool } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };
type Hours = { day: number; start: string; end: string }[];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : undefined);
const defined = (o: Args) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const action = (args: Args) => String(args['action'] ?? '');

interface WorkspaceGet {
  workspace: {
    id: string;
    name: string;
    timezone: string;
    industry: string | null;
    settings: Record<string, unknown>;
    role: WorkspaceRole;
    permissions: string[];
  };
}
interface Member {
  userId: string;
  fullName: string;
  email: string;
  role: WorkspaceRole;
}
interface Stage {
  id: string;
  name: string;
  kind: string;
  leadCount: number;
}
interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
}

const workspaceOf = (db: Db, ctx: ToolContext) => query<WorkspaceGet>(db, ctx, 'workspace.get');
const pipelinesOf = (db: Db, ctx: ToolContext) =>
  query<{ pipelines: Pipeline[] }>(db, ctx, 'pipeline.list').catch(() => ({
    pipelines: [] as Pipeline[],
  }));
const membersOf = (db: Db, ctx: ToolContext) =>
  query<{ members: Member[] }>(db, ctx, 'workspace.members').catch(() => ({
    members: [] as Member[],
  }));

/** The kind of business the model named ("plumber", "HVAC", "pet_grooming"), or a refusal it can pass on. */
function industryOf(named: string | undefined): IndustryOption | undefined {
  if (!named) return undefined;
  const found = industryFromText(named);
  if (!found)
    throw HfosError.rule(
      'industry_unknown',
      400,
      `“${named}” isn’t on the list of kinds of business. Pick the nearest one, or Other, under Industry in Settings → Workspace.`,
    );
  return found;
}

const stageIn = (pipelines: Pipeline[], stageId: unknown) => {
  for (const p of pipelines) {
    const stage = p.stages.find((s) => s.id === stageId);
    if (stage) return { pipeline: p, stage };
  }
  return null;
};

const leadsWord = (n: number) => (n === 1 ? 'a lead' : `${n} leads`);

/** Every pipeline keeps one stage of each kind, so its only one of a kind can't go or become another. */
const lastOfKind = ({ pipeline, stage }: { pipeline: Pipeline; stage: Stage }) =>
  HfosError.rule(
    'last_stage_of_kind',
    409,
    `${stage.name} is the only ${stage.kind} stage in ${pipeline.name}, and every pipeline keeps at least one open, one won and one lost stage. Add another ${stage.kind} stage first.`,
  );

/** The stage a change names, refused before a card when it isn't there. */
function theStage(pipelines: Pipeline[], stageId: unknown) {
  const found = stageIn(pipelines, stageId);
  if (!found)
    throw HfosError.notFound(
      'No stage has that id, or it was deleted. Stage ids are in get_settings (area pipelines).',
    );
  return found;
}

/**
 * Where a deleted stage's leads go, as Delete stage picks: another stage of the same kind in its pipeline, the one
 * asked for or else the first. Null when there's none, which the command refuses only while leads are in it.
 */
function leadsGoTo(found: { pipeline: Pipeline; stage: Stage }, asked: unknown) {
  const others = found.pipeline.stages.filter(
    (s) => s.id !== found.stage.id && s.kind === found.stage.kind,
  );
  if (asked === undefined) return others[0] ?? null;
  const to = others.find((s) => s.id === asked);
  if (!to)
    throw HfosError.validation(
      [{ path: 'moveLeadsToStageId', message: `Pick another ${found.stage.kind} stage.` }],
      `The leads in ${found.stage.name} can only go to another ${found.stage.kind} stage in ${found.pipeline.name}${
        others.length ? `: ${others.map((s) => s.name).join(', ')}` : ', and it has none yet'
      }.`,
    );
  return to;
}

// ---------- the business ----------

/** The links the business keeps by name ({{links.review}}), as the screen reads them. */
const linksOf = (settings: Record<string, unknown>): Record<string, unknown> => {
  const links = settings['links'];
  return links && typeof links === 'object' && !Array.isArray(links)
    ? (links as Record<string, unknown>)
    : {};
};

/** The street address given, as the setup's Your business keeps it; null when none was, or it doesn't read. */
function addressOf(args: Args): BusinessAddress | null {
  if (args['address'] === undefined) return null;
  const read = BusinessAddress.safeParse(args['address']);
  if (!read.success)
    throw HfosError.validation(
      read.error.issues.map((i) => ({
        path: ['address', ...i.path].join('.'),
        message: i.message,
      })),
      `That address doesn’t look right. ${read.error.issues[0]?.message ?? 'Give the street, city, 2-letter state and ZIP code.'}`,
    );
  return read.data;
}

const updateBusiness: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { workspace } = await workspaceOf(db, ctx);
    const fields: Field[] = [];
    const name = str(args['name']);
    if (name) {
      fields.push({ label: 'Name', value: name });
      if (name !== workspace.name) fields.push({ label: 'Was', value: workspace.name });
    }
    const industry = industryOf(str(args['industry']));
    if (industry) fields.push({ label: 'Industry', value: industry.label });
    for (const [key, label] of [
      ['timezone', 'Time zone'],
      ['website', 'Website'],
      ['reviewLink', 'Review link'],
    ] as const) {
      const value = str(args[key]);
      if (value) fields.push({ label, value });
      // Taken off: workflows that text it ({{business.website}}, {{links.review}}) have nothing to put in.
      else if (args[key] === null) fields.push({ label, value: 'None (taken off)' });
    }
    if (args['openHours'] !== undefined)
      fields.push({
        label: 'Open hours',
        value:
          args['openHours'] === null
            ? 'Weekdays 08:00–17:00'
            : hoursLine(args['openHours'] as Hours),
      });
    const address = addressOf(args);
    if (address)
      fields.push({ label: 'Address', value: addressLines(address).replace(/\n/g, ', ') });
    // The setup sets the time zone from the address; here it stays as it is unless it's changed too.
    const zone = address ? timeZoneForAddress(address) : null;
    const zoneNote =
      zone && !str(args['timezone']) && zone !== workspace.timezone
        ? `That address is on ${usTimeZoneLabel(zone)} time, but the business keeps ${usTimeZoneLabel(workspace.timezone)} time. Change the time zone too if it should follow.`
        : null;
    return {
      card: settingsCard(toolCallId, 'update_business', {
        title: `Change ${workspace.name}`,
        fields,
        confirmLabel: 'Save the change',
        warnings: [
          ...(str(args['timezone'])
            ? [{ kind: 'note', text: 'Times already booked stay at the same moment.' }]
            : []),
          ...(zoneNote ? [{ kind: 'note', text: zoneNote }] : []),
        ],
      }),
      result: {
        waiting: true,
        changes: fields.map((f) => f.label),
        ...(zoneNote ? { timeZone: zoneNote } : {}),
      },
    };
  },

  async commit(db, ctx, args) {
    // The other links the business keeps stay, as the screen's Save keeps them: only the review link changes.
    const review =
      args['reviewLink'] === undefined
        ? undefined
        : {
            ...linksOf((await workspaceOf(db, ctx)).workspace.settings),
            review: str(args['reviewLink']) ?? null,
          };
    const settings = defined({
      website: args['website'] === null ? null : str(args['website']),
      ...(review ? { links: review } : {}),
      ...(args['openHours'] === undefined ? {} : { openHours: args['openHours'] }),
      address: addressOf(args) ?? undefined,
    });
    await command(db, ctx, 'workspace.update', {
      ...defined({
        name: str(args['name']),
        timezone: str(args['timezone']),
        industry: industryOf(str(args['industry']))?.id,
      }),
      ...(Object.keys(settings).length ? { settings } : {}),
    });
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/settings/workspace`,
      command: 'workspace.update',
    };
  },
};

// ---------- pipelines ----------

const managePipeline: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const { pipelines } = await pipelinesOf(db, ctx);
    const pipeline = pipelines.find((p) => p.id === args['pipelineId']);
    const name = str(args['name']);
    const card = (title: string, fields: Field[], confirmLabel: string, warn?: string) =>
      settingsCard(toolCallId, 'manage_pipeline', {
        title,
        fields,
        confirmLabel,
        warnings: warn ? [{ kind: 'note', text: warn }] : [],
      });
    switch (act) {
      case 'create_pipeline':
        return {
          card: card(
            `Add the ${name} pipeline`,
            [
              { label: 'Pipeline', value: name ?? '' },
              { label: 'Stages', value: 'New, Contacted, Estimate sent, Won, Lost' },
            ],
            'Add it',
          ),
          result: { waiting: true },
        };
      case 'rename_pipeline':
        return {
          card: card(
            `Rename ${pipeline?.name ?? 'the pipeline'}`,
            [
              { label: 'Now', value: name ?? '' },
              { label: 'Was', value: pipeline?.name ?? '' },
            ],
            'Rename it',
          ),
          result: { waiting: true },
        };
      case 'archive_pipeline':
        return {
          card: card(
            `Archive ${pipeline?.name ?? 'the pipeline'}`,
            [{ label: 'Pipeline', value: pipeline?.name ?? '' }],
            'Archive it',
            'It comes off the board and nothing new can be added to it. Its won and lost leads keep their history.',
          ),
          result: { waiting: true },
        };
      case 'add_stage':
        return {
          card: card(
            `Add the ${name} stage`,
            [
              { label: 'Pipeline', value: pipeline?.name ?? '' },
              { label: 'Stage', value: name ?? '' },
              { label: 'Counts as', value: String(args['stageKind'] ?? 'open') },
            ],
            'Add it',
          ),
          result: { waiting: true },
        };
      case 'rename_stage': {
        const { stage, pipeline: p } = theStage(pipelines, args['stageId']);
        const kind = str(args['stageKind']);
        const kindChanges = !!kind && kind !== stage.kind;
        // As the screen's Edit locks Kind: a stage with leads keeps what it counts as.
        if (kindChanges && stage.leadCount > 0)
          throw HfosError.rule(
            'stage_has_leads',
            409,
            `${stage.name} has ${leadsWord(stage.leadCount)} in it, so it keeps counting as ${stage.kind}. Move the leads to another stage on the Pipeline first, then change it.`,
          );
        if (kindChanges && !p.stages.some((s) => s.id !== stage.id && s.kind === stage.kind))
          throw lastOfKind({ pipeline: p, stage });
        const renamed = !!name && name !== stage.name;
        if (!renamed && !kindChanges)
          throw HfosError.validation(
            [],
            `Nothing would change. ${stage.name} already has that name and counts as ${stage.kind}.`,
          );
        return {
          card: card(
            kindChanges ? `Change ${stage.name}` : `Rename ${stage.name}`,
            [
              { label: 'Pipeline', value: p.name },
              ...(renamed
                ? [
                    { label: 'Now', value: name! },
                    { label: 'Was', value: stage.name },
                  ]
                : [{ label: 'Stage', value: stage.name }]),
              ...(kindChanges
                ? [
                    { label: 'Counts as', value: kind },
                    { label: 'Counted as', value: stage.kind },
                  ]
                : []),
            ],
            kindChanges ? 'Save the change' : 'Rename it',
            kindChanges
              ? `It has no leads in it, so nothing there now changes. Leads moved into it from now on count as ${kind}.`
              : undefined,
          ),
          result: { waiting: true },
        };
      }
      case 'delete_stage': {
        const doomed = theStage(pipelines, args['stageId']);
        const { stage } = doomed;
        const to = leadsGoTo(doomed, args['moveLeadsToStageId']);
        if (!to) throw lastOfKind(doomed);
        return {
          card: card(
            `Delete ${stage.name}`,
            [
              { label: 'Pipeline', value: doomed.pipeline.name },
              { label: 'Stage', value: stage.name },
              ...(stage.leadCount > 0
                ? [{ label: 'Leads in it', value: String(stage.leadCount) }]
                : []),
              { label: 'Leads in it go to', value: to.name },
            ],
            'Delete it',
          ),
          result: { waiting: true, leadsGoTo: to.name },
        };
      }
      default: {
        const order = (list(args['stageIds']) ?? [])
          .map((id) => stageIn(pipelines, id)?.stage.name)
          .filter(Boolean);
        return {
          card: card(
            `Reorder ${pipeline?.name ?? 'the pipeline'}`,
            [
              { label: 'Pipeline', value: pipeline?.name ?? '' },
              { label: 'Order', value: order.join(' → ') },
            ],
            'Save the order',
          ),
          result: { waiting: true },
        };
      }
    }
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const href = `/app/w/${ctx.workspaceId}/settings/pipelines`;
    switch (act) {
      case 'create_pipeline':
        await command(db, ctx, 'pipeline.create', { name: args['name'] });
        return { outcome: `${str(args['name'])} is ready`, href, command: 'pipeline.create' };
      case 'rename_pipeline':
        await command(db, ctx, 'pipeline.update', {
          pipelineId: args['pipelineId'],
          name: args['name'],
        });
        return { outcome: 'Renamed', href, command: 'pipeline.update' };
      case 'archive_pipeline':
        await command(db, ctx, 'pipeline.archive', { pipelineId: args['pipelineId'] });
        return { outcome: 'Archived', href, command: 'pipeline.archive' };
      case 'add_stage':
        await command(db, ctx, 'stage.create', {
          pipelineId: args['pipelineId'],
          name: args['name'],
          ...defined({ kind: str(args['stageKind']), afterStageId: args['afterStageId'] }),
        });
        return { outcome: `${str(args['name'])} is added`, href, command: 'stage.create' };
      case 'rename_stage': {
        const out = await command<{ updated?: string[] }>(db, ctx, 'stage.update', {
          stageId: args['stageId'],
          ...defined({ name: str(args['name']), kind: str(args['stageKind']) }),
        });
        return {
          outcome: out.updated?.includes('kind')
            ? `Saved. It counts as ${str(args['stageKind'])} now`
            : 'Renamed',
          href,
          command: 'stage.update',
        };
      }
      case 'delete_stage': {
        // Where the card said the leads go: the stage asked for, or the first other one of its kind.
        const doomed = theStage((await pipelinesOf(db, ctx)).pipelines, args['stageId']);
        const to = leadsGoTo(doomed, args['moveLeadsToStageId']);
        const out = await command<{ movedLeads: number }>(db, ctx, 'stage.delete', {
          stageId: doomed.stage.id,
          ...(to ? { moveLeadsToStageId: to.id } : {}),
        });
        return {
          outcome: out.movedLeads
            ? `Deleted; ${out.movedLeads} lead${out.movedLeads === 1 ? '' : 's'} moved`
            : 'Deleted',
          href,
          command: 'stage.delete',
        };
      }
      default:
        await command(db, ctx, 'stage.reorder', {
          pipelineId: args['pipelineId'],
          stageIds: args['stageIds'],
        });
        return { outcome: 'Reordered', href, command: 'stage.reorder' };
    }
  },
};

// ---------- the team ----------

interface Invitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: { userId: string; fullName: string } | null;
  /** Null while the email is still going out: Members says "Sending…". */
  sentAt: string | null;
  expiresAt: string;
}

/** What each change needs, as the screen's own buttons ask it; leaving needs nothing. */
const TEAM_NEEDS: Record<string, Permission> = {
  invite: 'members.invite',
  resend_invitation: 'members.invite',
  change_role: 'members.change_role',
  remove: 'members.remove',
  cancel_invitation: 'invitations.revoke',
};

const whoOf = (m: Member) => m.fullName || m.email;
const aRole = (role: WorkspaceRole) => (role === 'member' ? 'a member' : `an ${role}`);
const dayOf = (iso: string, ctx: ToolContext) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: ctx.timezone,
  });

/** "Admin — Manages people and settings. Cannot change or remove Owners.", as Invite teammate says each role. */
const roleWords = (role: WorkspaceRole) => `${ROLE_LABELS[role]} — ${ROLE_DESCRIPTIONS[role]}`;

/**
 * What a team change is about, read the way Members shows it, and refused before a card when the person may not
 * make it, when it isn't there anymore, or when the command itself would say no (the last owner, a role above
 * theirs, an email already in), by trying it and rolling it back.
 */
async function teamPlan(db: Db, ctx: ToolContext, args: Args) {
  const me = ctx.actor.userId;
  const asked = action(args);
  // Taking yourself off is leaving, as the menu on your own row says.
  const act = asked === 'remove' && args['userId'] === me ? 'leave' : asked;
  const [{ members }, { workspace }] = await Promise.all([
    membersOf(db, ctx),
    workspaceOf(db, ctx),
  ]);
  const needs = TEAM_NEEDS[act];
  if (needs && !workspace.permissions.includes(needs))
    throw HfosError.forbidden(missingPermissionMessage(needs, workspace.role), 'team_not_yours');
  if (act === 'invite') {
    const email = str(args['email']);
    if (!email)
      throw HfosError.validation(
        [{ path: 'email', message: 'Enter their email address.' }],
        'Say the email address to invite.',
      );
    const role = (str(args['role']) ?? 'member') as WorkspaceRole;
    const input = { email, role };
    await rehearse(db, ctx, 'membership.invite', input);
    return { act, workspace, input, email, role } as const;
  }
  if (act === 'resend_invitation' || act === 'cancel_invitation') {
    const { invitations } = await query<{ invitations: Invitation[] }>(
      db,
      ctx,
      'workspace.invitations',
    );
    const invitation = invitations.find((i) => i.id === args['invitationId']);
    if (!invitation)
      throw HfosError.notFound(
        'That invitation isn’t pending anymore: it was accepted or cancelled. Refresh Members to see the ones still waiting.',
      );
    const input = { invitationId: invitation.id };
    await rehearse(
      db,
      ctx,
      act === 'resend_invitation' ? 'invitation.resend' : 'invitation.revoke',
      input,
    );
    return { act, workspace, input, invitation } as const;
  }
  if (act !== 'change_role' && act !== 'remove' && act !== 'leave')
    throw HfosError.validation(
      [{ path: 'action', message: 'Pick what to do.' }],
      'Say whether to invite, change a role, remove, leave, or resend or cancel an invitation.',
    );
  const userId = act === 'leave' ? me : str(args['userId']);
  const who = members.find((m) => m.userId === userId);
  if (!who)
    throw HfosError.notFound(
      act === 'leave'
        ? 'You’re not in this business anymore, so there’s nothing to leave.'
        : 'That person isn’t in this business anymore. They may have left or been removed. list_team has who is here now.',
    );
  if (act === 'change_role') {
    const role = str(args['role']) as WorkspaceRole | undefined;
    if (!role)
      throw HfosError.validation(
        [{ path: 'role', message: 'Pick Owner, Admin or Member.' }],
        `Say what ${whoOf(who)} should be: Owner, Admin or Member.`,
      );
    if (role === who.role)
      throw HfosError.rule(
        'nothing_changes',
        409,
        `${whoOf(who)} is already ${aRole(role)}. Nothing would change.`,
      );
    const input = { userId: who.userId, role };
    await rehearse(db, ctx, 'membership.change_role', input);
    return { act, workspace, input, who, role } as const;
  }
  const input = { userId: who.userId };
  await rehearse(db, ctx, 'membership.remove', input);
  return { act, workspace, input, who } as const;
}

const manageTeam: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const plan = await teamPlan(db, ctx, args);
    const business = plan.workspace.name;
    const card = (
      title: string,
      fields: Field[],
      confirmLabel: string,
      warnings: { kind: 'caution' | 'note'; text: string }[] = [],
    ) => ({
      card: settingsCard(toolCallId, 'manage_team', { title, fields, confirmLabel, warnings }),
      result: { waiting: true },
    });
    switch (plan.act) {
      case 'invite':
        return card(
          `Invite ${plan.email}`,
          [
            { label: 'Email', value: plan.email },
            { label: 'Role', value: roleWords(plan.role) },
            { label: 'Business', value: business },
          ],
          'Send the invitation',
          [
            {
              kind: 'note',
              text: 'They get an email from HandsFreeOS and press Accept invitation to join.',
            },
          ],
        );
      case 'resend_invitation':
      case 'cancel_invitation': {
        const i = plan.invitation;
        const fields: Field[] = [
          { label: 'Email', value: i.email },
          { label: 'Role', value: roleWords(i.role) },
          ...(i.invitedBy?.fullName ? [{ label: 'Invited by', value: i.invitedBy.fullName }] : []),
          ...(i.sentAt
            ? [
                { label: 'Sent', value: dayOf(i.sentAt, ctx) },
                { label: 'Expires', value: dayOf(i.expiresAt, ctx) },
              ]
            : [{ label: 'Sent', value: 'Sending now' }]),
        ];
        return plan.act === 'resend_invitation'
          ? card(`Send ${i.email}’s invitation again`, fields, 'Send it again', [
              { kind: 'note', text: 'They get a new email. The old link stops working.' },
            ])
          : card(`Cancel ${i.email}’s invitation`, fields, 'Cancel it', [
              {
                kind: 'caution',
                text: 'Its link stops working. Inviting them again sends a new one.',
              },
            ]);
      }
      case 'change_role':
        return card(
          `Change ${whoOf(plan.who)}’s role`,
          [
            { label: 'Teammate', value: whoOf(plan.who) },
            { label: 'Email', value: plan.who.email },
            { label: 'Now', value: roleWords(plan.role) },
            { label: 'Was', value: roleWords(plan.who.role) },
          ],
          'Save the change',
          plan.role === 'owner'
            ? [{ kind: 'caution', text: `${whoOf(plan.who)} gets full control of ${business}.` }]
            : [],
        );
      case 'leave':
        return card(
          `Leave ${business}?`,
          [
            { label: 'You', value: plan.who.email },
            { label: 'Role', value: roleWords(plan.who.role) },
          ],
          'Leave',
          [
            {
              kind: 'caution',
              text: 'You lose access immediately. An Owner can invite you back later.',
            },
          ],
        );
      default:
        return card(
          `Remove ${whoOf(plan.who)}?`,
          [
            { label: 'Teammate', value: whoOf(plan.who) },
            { label: 'Email', value: plan.who.email },
            { label: 'Role', value: roleWords(plan.who.role) },
            { label: 'Business', value: business },
          ],
          'Remove them',
          [
            {
              kind: 'caution',
              text: 'They lose access immediately. Their past activity stays in the audit log.',
            },
          ],
        );
    }
  },

  async commit(db, ctx, args) {
    const plan = await teamPlan(db, ctx, args);
    const href = `/app/w/${ctx.workspaceId}/members`;
    switch (plan.act) {
      case 'invite':
        await command(db, ctx, 'membership.invite', plan.input);
        return {
          outcome: `Invitation sent to ${plan.email}`,
          href,
          command: 'membership.invite',
        };
      case 'resend_invitation':
        await command(db, ctx, 'invitation.resend', plan.input);
        return {
          outcome: `Invitation re-sent to ${plan.invitation.email}. The old link no longer works.`,
          href,
          command: 'invitation.resend',
        };
      case 'cancel_invitation':
        await command(db, ctx, 'invitation.revoke', plan.input);
        return {
          outcome: `Cancelled ${plan.invitation.email}’s invitation`,
          href,
          command: 'invitation.revoke',
        };
      case 'change_role':
        await command(db, ctx, 'membership.change_role', plan.input);
        return {
          outcome: `${whoOf(plan.who)} is now ${aRole(plan.role)}`,
          href,
          command: 'membership.change_role',
        };
      case 'leave':
        await command(db, ctx, 'membership.remove', plan.input);
        return {
          outcome: `You left ${plan.workspace.name}`,
          href: null,
          command: 'membership.remove',
        };
      default:
        await command(db, ctx, 'membership.remove', plan.input);
        return { outcome: `Removed ${whoOf(plan.who)}`, href, command: 'membership.remove' };
    }
  },
};

// ---------- tags ----------

interface TagRow {
  id: string;
  name: string;
  color: string;
  usage: number;
}

/** "1 customer or lead", "3 customers and leads": companies count as customers here, as on the Tags page. */
const onRecords = (n: number) => (n === 1 ? '1 customer or lead' : `${n} customers and leads`);

/** The tag asked about, and the rest, read the way Settings → Tags lists them; refuses what the screen wouldn't do. */
async function tagChange(db: Db, ctx: ToolContext, args: Args) {
  const act = action(args);
  const { tags } = await query<{ tags: TagRow[] }>(db, ctx, 'tag.list');
  const name = str(args['name']);
  const color = str(args['color'])?.toLowerCase();
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const taken = (id: string | null) =>
    name ? tags.find((t) => t.id !== id && same(t.name, name)) : undefined;
  if (act === 'create') {
    if (!name)
      throw HfosError.validation(
        [{ path: 'name', message: 'Name the tag.' }],
        'Say what the new tag is called.',
      );
    const twin = taken(null);
    if (twin)
      throw HfosError.rule(
        'tag_exists',
        409,
        `There’s already a tag called ${twin.name}. Use that one, or pick another name.`,
      );
    return { act, current: null, name, color };
  }
  const tagId = str(args['tagId']);
  if (!tagId)
    throw HfosError.validation(
      [{ path: 'tagId', message: 'Pick a tag.' }],
      'Say which tag: the tags and their ids are in get_settings with area tags.',
    );
  const current = tags.find((t) => t.id === tagId);
  if (!current)
    throw HfosError.notFound(
      'No tag has that id. It may have been deleted. The tags are in get_settings with area tags.',
    );
  if (act === 'change') {
    const twin = taken(current.id);
    if (twin)
      throw HfosError.rule(
        'tag_exists',
        409,
        `There’s already a tag called ${twin.name}. Pick another name, or use that one.`,
      );
    const renamed = name !== undefined && name !== current.name;
    const recoloured = color !== undefined && color !== current.color.toLowerCase();
    if (!renamed && !recoloured)
      throw HfosError.rule(
        'nothing_to_change',
        400,
        `Nothing would change. ${current.name} already has that name and colour.`,
      );
    return {
      act,
      current,
      name: renamed ? name : undefined,
      color: recoloured ? color : undefined,
    };
  }
  return { act, current, name: undefined, color: undefined };
}

const manageTag: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const { act, current, name, color } = await tagChange(db, ctx, args);
    const label = current?.name ?? name ?? '';
    return {
      card: settingsCard(toolCallId, 'manage_tag', {
        title:
          act === 'create'
            ? `Add the ${label} tag`
            : act === 'delete'
              ? `Delete the ${label} tag`
              : `Change the ${label} tag`,
        fields: [
          { label: 'Tag', value: name ?? label },
          ...(current && name ? [{ label: 'Was', value: current.name }] : []),
          ...(color ? [{ label: 'Colour', value: color }] : []),
          ...(current && act === 'delete'
            ? [{ label: 'On', value: onRecords(current.usage) }]
            : []),
        ],
        confirmLabel:
          act === 'create' ? 'Add it' : act === 'delete' ? 'Delete it' : 'Save the change',
        warnings:
          act === 'delete' && current
            ? [
                {
                  kind: 'caution',
                  text:
                    current.usage === 1
                      ? 'It comes off the one customer or lead that has it, and can’t be brought back.'
                      : current.usage
                        ? `It comes off all ${current.usage} customers and leads that have it, and can’t be brought back.`
                        : 'Nothing has it, and it can’t be brought back.',
                },
              ]
            : [],
      }),
      result: { waiting: true, action: act },
    };
  },

  async commit(db, ctx, args) {
    // Checked again: a tag added or deleted since the card is refused the same way.
    const { act, current, name, color } = await tagChange(db, ctx, args);
    const href = `/app/w/${ctx.workspaceId}/settings/tags`;
    if (act === 'create') {
      await command(db, ctx, 'tag.create', { name, ...defined({ color }) });
      return { outcome: `${name} is added`, href, command: 'tag.create' };
    }
    if (act === 'delete') {
      const out = await command<{ removedFrom: number }>(db, ctx, 'tag.delete', {
        tagId: current!.id,
      });
      return {
        outcome: out.removedFrom
          ? `Deleted, and taken off ${onRecords(out.removedFrom)}`
          : 'Deleted',
        href,
        command: 'tag.delete',
      };
    }
    await command(db, ctx, 'tag.update', { tagId: current!.id, ...defined({ name, color }) });
    return { outcome: 'Changed', href, command: 'tag.update' };
  },
};

// ---------- what the AI knows ----------

interface Service {
  name: string;
  description: string;
  price: string | null;
}
interface Profile {
  description: string;
  services: Service[];
  serviceArea: string;
  hours: string;
  policies: string;
  tone: string;
  wordsToUse: string[];
  wordsToAvoid: string[];
  signature: string;
  allowPrices: boolean;
}

const FIELD_WORDS: Record<string, string> = {
  description: 'What you do',
  serviceArea: 'Area you cover',
  hours: 'Hours',
  policies: 'Policies',
  tone: 'How it sounds',
  signature: 'Signs off',
};

const trim = (v: string) => (v.length > 120 ? `${v.slice(0, 117)}…` : v);
/** A text field as given: empty clears it, so it isn't dropped the way `str` drops it. */
const given = (v: unknown) => (typeof v === 'string' ? v.trim() : undefined);
const wordsOf = (v: unknown) =>
  Array.isArray(v) ? (v as string[]).map((w) => w.trim()).filter(Boolean) : undefined;
const servicesOf = (v: unknown): Service[] | undefined =>
  Array.isArray(v)
    ? (v as Partial<Service>[]).map((x) => ({
        name: String(x.name ?? '').trim(),
        description: String(x.description ?? '').trim(),
        price: typeof x.price === 'string' && x.price.trim() ? x.price.trim() : null,
      }))
    : undefined;
const serviceLine = (x: Service) => [x.name, x.price, x.description].filter(Boolean).join(' · ');
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** What the person asked to change, each only when it says something new, in the screen's words. */
function profileChanges(
  profile: Profile,
  args: Args,
): { changed: Partial<Profile>; fields: Field[] } {
  const changed: Partial<Profile> = {};
  const fields: Field[] = [];
  for (const [key, label] of Object.entries(FIELD_WORDS)) {
    const next = given(args[key]);
    const was = String(profile[key as keyof Profile] ?? '');
    if (next === undefined || next === was) continue;
    (changed as Record<string, unknown>)[key] = next;
    fields.push({ label, value: next ? trim(next) : `Cleared (was “${trim(was)}”)` });
  }
  const services = servicesOf(args['services']);
  if (services && JSON.stringify(services) !== JSON.stringify(profile.services)) {
    changed.services = services;
    fields.push({
      label: 'Services',
      value: services.length ? services.map(serviceLine).join('; ') : 'None',
    });
  }
  for (const [key, label] of [
    ['wordsToUse', 'Words to use'],
    ['wordsToAvoid', 'Words to avoid'],
  ] as const) {
    const next = wordsOf(args[key]);
    if (!next || sameList(next, profile[key])) continue;
    changed[key] = next;
    fields.push({ label, value: next.length ? next.join(', ') : 'None' });
  }
  if (typeof args['allowPrices'] === 'boolean' && args['allowPrices'] !== profile.allowPrices) {
    changed.allowPrices = args['allowPrices'];
    fields.push({ label: 'May quote prices', value: args['allowPrices'] ? 'Yes' : 'No' });
  }
  return { changed, fields };
}

const profileOf = async (db: Db, ctx: ToolContext) =>
  (await query<{ profile: Profile }>(db, ctx, 'knowledge.profile')).profile;

const updateKnowledgeProfile: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const profile = await profileOf(db, ctx);
    const { changed, fields } = profileChanges(profile, args);
    if (!fields.length)
      throw HfosError.validation(
        [],
        'Nothing would change: the business profile already says that. Read it with get_settings (area knowledge), and pass only what changes.',
      );
    if (changed.services?.some((x) => !x.name))
      throw HfosError.validation(
        [{ path: 'services', message: 'Name each service.' }],
        'Name each service.',
      );
    const prices = changed.allowPrices ?? profile.allowPrices;
    const pricesGiven = changed.services?.some((x) => x.price) ?? false;
    return {
      card: settingsCard(toolCallId, 'update_knowledge_profile', {
        title: 'Change what your AI knows about the business',
        fields,
        confirmLabel: 'Save the change',
        warnings: [
          ...(changed.allowPrices === true
            ? [
                {
                  kind: 'note',
                  text: 'It will quote the prices in your knowledge base to customers.',
                },
              ]
            : []),
          ...(pricesGiven && !prices
            ? [
                {
                  kind: 'note',
                  text: 'The AI doesn’t quote these prices to customers until AI may quote prices is on (Knowledge → Overview).',
                },
              ]
            : []),
        ],
      }),
      result: { waiting: true, changes: fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    // The command takes the whole profile, so the parts nobody mentioned are read back and sent as they were.
    const profile = await profileOf(db, ctx);
    const { changed } = profileChanges(profile, args);
    await command(db, ctx, 'knowledge.profile_update', {
      profile: { ...profile, ...changed },
    });
    return {
      outcome: 'Saved',
      href: `/app/w/${ctx.workspaceId}/knowledge/profile`,
      command: 'knowledge.profile_update',
    };
  },
};

export const settingsBusinessConfirmTools: Record<string, SettingsConfirmTool> = {
  update_business: updateBusiness,
  manage_pipeline: managePipeline,
  manage_team: manageTeam,
  manage_tag: manageTag,
  update_knowledge_profile: updateKnowledgeProfile,
};
