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
  timeZoneForAddress,
  usTimeZoneLabel,
  type IndustryOption,
} from '@hfos/core';
import type { Db } from '@hfos/db/client';
import type { ToolContext } from './runtime';
import { command, query } from './tools-read';
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
  };
}
interface Member {
  userId: string;
  fullName: string;
  email: string;
  role: string;
}
interface Stage {
  id: string;
  name: string;
  kind: string;
}
interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
}

const ROLE_WORDS: Record<string, string> = {
  owner: 'Owner — can do everything, including billing',
  admin: 'Admin — can change how the business is set up',
  member: 'Member — works customers, leads and the inbox',
};

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

// ---------- the business ----------

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
    const settings = defined({
      website: str(args['website']),
      ...(str(args['reviewLink']) ? { links: { review: str(args['reviewLink']) } } : {}),
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
    const found = stageIn(pipelines, args['stageId']);
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
            'The leads in it stay; nothing new can be added to it.',
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
      case 'rename_stage':
        return {
          card: card(
            `Rename ${found?.stage.name ?? 'the stage'}`,
            [
              { label: 'Pipeline', value: found?.pipeline.name ?? '' },
              { label: 'Now', value: name ?? '' },
              { label: 'Was', value: found?.stage.name ?? '' },
            ],
            'Rename it',
          ),
          result: { waiting: true },
        };
      case 'delete_stage': {
        const to = found ? stageIn(pipelines, args['moveLeadsToStageId'])?.stage : null;
        return {
          card: card(
            `Delete ${found?.stage.name ?? 'the stage'}`,
            [
              { label: 'Pipeline', value: found?.pipeline.name ?? '' },
              { label: 'Stage', value: found?.stage.name ?? '' },
              { label: 'Leads in it go to', value: to?.name ?? 'the first stage' },
            ],
            'Delete it',
          ),
          result: { waiting: true },
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
      case 'rename_stage':
        await command(db, ctx, 'stage.update', {
          stageId: args['stageId'],
          ...defined({ name: str(args['name']), kind: str(args['stageKind']) }),
        });
        return { outcome: 'Renamed', href, command: 'stage.update' };
      case 'delete_stage': {
        const out = await command<{ movedLeads: number }>(db, ctx, 'stage.delete', {
          stageId: args['stageId'],
          ...defined({ moveLeadsToStageId: args['moveLeadsToStageId'] }),
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

const manageTeam: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const act = action(args);
    const [{ members }, { workspace }] = await Promise.all([
      membersOf(db, ctx),
      workspaceOf(db, ctx),
    ]);
    const who = members.find((m) => m.userId === args['userId']);
    const role = str(args['role']);
    const card = (title: string, fields: Field[], confirmLabel: string, warn?: string) =>
      settingsCard(toolCallId, 'manage_team', {
        title,
        fields,
        confirmLabel,
        warnings: warn ? [{ kind: 'note', text: warn }] : [],
      });
    switch (act) {
      case 'invite':
        return {
          card: card(
            `Invite ${str(args['email'])}`,
            [
              { label: 'Email', value: str(args['email']) ?? '' },
              { label: 'Role', value: ROLE_WORDS[role ?? 'member'] ?? 'Member' },
              { label: 'Business', value: workspace.name },
            ],
            'Send the invitation',
            'They get an email from HandsFreeOS inviting them in.',
          ),
          result: { waiting: true },
        };
      case 'change_role':
        return {
          card: card(
            `Change what ${who?.fullName ?? 'they'} can do`,
            [
              { label: 'Teammate', value: who?.fullName || (who?.email ?? '') },
              { label: 'Now', value: ROLE_WORDS[role ?? ''] ?? '' },
              { label: 'Was', value: ROLE_WORDS[who?.role ?? ''] ?? '' },
            ],
            'Save the change',
          ),
          result: { waiting: true },
        };
      case 'remove':
        return {
          card: card(
            `Take ${who?.fullName ?? 'them'} off ${workspace.name}`,
            [
              { label: 'Teammate', value: who?.fullName || (who?.email ?? '') },
              { label: 'Was', value: ROLE_WORDS[who?.role ?? ''] ?? '' },
            ],
            'Take them off',
            'They lose their way in. What they worked on stays.',
          ),
          result: { waiting: true },
        };
      default:
        return {
          card: card(
            act === 'resend_invitation' ? 'Send the invitation again' : 'Cancel the invitation',
            [{ label: 'Business', value: workspace.name }],
            act === 'resend_invitation' ? 'Send it again' : 'Cancel it',
          ),
          result: { waiting: true },
        };
    }
  },

  async commit(db, ctx, args) {
    const act = action(args);
    const href = `/app/w/${ctx.workspaceId}/members`;
    switch (act) {
      case 'invite':
        await command(db, ctx, 'membership.invite', {
          email: args['email'],
          ...defined({ role: str(args['role']) }),
        });
        return {
          outcome: `Invitation sent to ${str(args['email'])}`,
          href,
          command: 'membership.invite',
        };
      case 'change_role':
        await command(db, ctx, 'membership.change_role', {
          userId: args['userId'],
          role: args['role'],
        });
        return { outcome: 'Changed', href, command: 'membership.change_role' };
      case 'remove':
        await command(db, ctx, 'membership.remove', { userId: args['userId'] });
        return { outcome: 'Taken off', href, command: 'membership.remove' };
      case 'resend_invitation':
        await command(db, ctx, 'invitation.resend', { invitationId: args['invitationId'] });
        return { outcome: 'Sent again', href, command: 'invitation.resend' };
      default:
        await command(db, ctx, 'invitation.revoke', { invitationId: args['invitationId'] });
        return { outcome: 'Cancelled', href, command: 'invitation.revoke' };
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

interface ProfileGet {
  profile: Record<string, unknown>;
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

const updateKnowledgeProfile: SettingsConfirmTool = {
  async prepare(db, ctx, args, toolCallId) {
    const fields: Field[] = Object.entries(FIELD_WORDS)
      .filter(([key]) => str(args[key]))
      .map(([key, label]) => ({ label, value: trim(str(args[key])!) }));
    if (typeof args['allowPrices'] === 'boolean')
      fields.push({
        label: 'May quote prices',
        value: args['allowPrices'] ? 'Yes' : 'No',
      });
    return {
      card: settingsCard(toolCallId, 'update_knowledge_profile', {
        title: 'Change what your AI knows about the business',
        fields,
        confirmLabel: 'Save the change',
        warnings:
          args['allowPrices'] === true
            ? [
                {
                  kind: 'note',
                  text: 'It will quote the prices in your knowledge base to customers.',
                },
              ]
            : [],
      }),
      result: { waiting: true, changes: fields.map((f) => f.label) },
    };
  },

  async commit(db, ctx, args) {
    // The command takes the whole profile, so the parts nobody mentioned are read back and sent as they were.
    const { profile } = await query<ProfileGet>(db, ctx, 'knowledge.profile');
    const changed = defined({
      description: str(args['description']),
      serviceArea: str(args['serviceArea']),
      hours: str(args['hours']),
      policies: str(args['policies']),
      tone: str(args['tone']),
      signature: str(args['signature']),
      allowPrices: typeof args['allowPrices'] === 'boolean' ? args['allowPrices'] : undefined,
    });
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
