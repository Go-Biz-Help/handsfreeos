/**
 * Crews (docs/contractor.md, "Crews and work orders"; the owner's decision 7, 2026-11-10): named groups of people on
 * the business's team and subcontractors. Putting a crew on a visit books everyone in it (./work-orders.ts). A
 * subcontractor is a contact: they don't sign in, they're texted the job's details, and the office marks their work.
 * For a subcontracting company, it's the person the business deals with there, and Contacts says which company.
 *
 * A crew that's no longer used is archived, never deleted, so the visits it worked still say its name.
 */
import { and, eq, isNotNull, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { contractorAddon } from '../manifest';
import {
  CrewArchiveInput,
  CrewArchiveOutput,
  CrewListInput,
  CrewListOutput,
  CrewSaveInput,
  CrewSaveOutput,
  LIMITS,
} from '../schemas';
import { crewMembers, crews } from '../tables';
import { CONTRACTOR_WORDS as W, REFUSALS } from '../words';
import { inWorkspace, requireCanWork, subOut, subsOf, type Ctx } from './common';

const settingsPath = 'a/contractor/settings';

export interface CrewRow {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

/** Loads a crew of this business, locked for the change when asked; refused as gone when it isn't here. */
export async function loadCrew(
  ctx: Ctx,
  crewId: string,
  opts: { readonly lock?: boolean } = {},
): Promise<CrewRow> {
  const q = ctx.tx
    .select({ id: crews.id, name: crews.name, archivedAt: crews.archivedAt })
    .from(crews)
    .where(and(eq(crews.id, crewId), eq(crews.workspaceId, ctx.scope.workspaceId!)));
  const [c] = opts.lock ? await q.for('update') : await q;
  if (!c) throw HfosError.notFound(REFUSALS.crewGone);
  return { id: c.id, name: c.name, archived: c.archivedAt !== null };
}

/** Who's in a crew: its people on the team and its subcontractors, as ids. */
export async function crewMemberIds(
  ctx: Ctx,
  crewId: string,
): Promise<{ userIds: string[]; personIds: string[] }> {
  const list = await ctx.tx
    .select({ userId: crewMembers.userId, personId: crewMembers.personId })
    .from(crewMembers)
    .where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.workspaceId, ctx.scope.workspaceId!)))
    .orderBy(crewMembers.createdAt, crewMembers.id);
  return {
    userIds: list.map((m) => m.userId).filter((u): u is string => !!u),
    personIds: list.map((m) => m.personId).filter((p): p is string => !!p),
  };
}

/** Refuses a name another of the business's crews (not archived) already has. */
async function requireNameFree(ctx: CommandContext, name: string, exceptId: string | null) {
  const [taken] = await rows<{ id: string }>(
    ctx.tx,
    sql`select id from addon_contractor.crews
        where workspace_id = ${ctx.scope.workspaceId!} and archived_at is null
          and lower(btrim(name)) = lower(btrim(${name})) and id is distinct from ${exceptId}::uuid
        limit 1`,
  );
  if (taken) throw HfosError.rule('contractor_crew_name_taken', 409, REFUSALS.crewNameTaken(name));
}

async function requireRoomForACrew(ctx: CommandContext) {
  const [{ n } = { n: 0 }] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_contractor.crews
        where workspace_id = ${ctx.scope.workspaceId!} and archived_at is null`,
  );
  if (n >= LIMITS.crews)
    throw HfosError.rule('contractor_too_many_crews', 409, REFUSALS.tooManyCrews(LIMITS.crews));
}

const unique = (ids: readonly string[]) => [...new Set(ids)];

export const crewSave = defineAddonCommand(contractorAddon, {
  name: 'contractor.crew.save',
  description:
    'Make a crew, or change one: its name, the people on the business’s team in it, and its subcontractors (contacts who don’t sign in).',
  risk: 1,
  input: CrewSaveInput,
  output: CrewSaveOutput,
  permission: 'contractor.manage',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_save_crew',
    description:
      'Make a crew (name it) or change one (crewId): its name, the team members in it (userIds: the whole list) and its subcontractors (subPersonIds: contacts, the whole list). Left out, each stays as it is. Putting a crew on a visit books everyone in it.',
    keywords: ['crew', 'crews', 'subcontractor', 'subs'],
    outcome: (output) => ({
      words: W.crews.saved(String((output as { name?: unknown }).name ?? 'The crew')),
      path: settingsPath,
    }),
  },
  emits: ['contractor.crew.saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const me = userIdOf(ctx.actor);
    let crewId = input.crewId ?? null;
    let name: string;
    if (!crewId) {
      if (!input.name)
        throw HfosError.rule('contractor_crew_name_needed', 400, REFUSALS.crewNameNeeded);
      await requireRoomForACrew(ctx);
      await requireNameFree(ctx, input.name, null);
      const [made] = await ctx.tx
        .insert(crews)
        .values({ workspaceId: ws, name: input.name, createdBy: me })
        .returning({ id: crews.id });
      crewId = made!.id;
      name = input.name;
    } else {
      const crew = await loadCrew(ctx, crewId, { lock: true });
      if (crew.archived) throw HfosError.notFound(REFUSALS.crewGone);
      name = input.name ?? crew.name;
      if (name !== crew.name) {
        await requireNameFree(ctx, name, crew.id);
        await ctx.tx
          .update(crews)
          .set({ name, updatedAt: new Date() })
          .where(eq(crews.id, crew.id));
      }
    }
    if (input.userIds) {
      const userIds = unique(input.userIds);
      for (const userId of userIds) await requireCanWork(ctx, userId);
      await ctx.tx
        .delete(crewMembers)
        .where(and(eq(crewMembers.crewId, crewId), isNotNull(crewMembers.userId)));
      if (userIds.length)
        await ctx.tx
          .insert(crewMembers)
          .values(userIds.map((userId) => ({ workspaceId: ws, crewId, userId, addedBy: me })));
    }
    if (input.subPersonIds) {
      const personIds = unique(input.subPersonIds);
      const found = await subsOf(ctx, personIds);
      if (personIds.some((p) => !found.has(p))) throw HfosError.notFound(REFUSALS.subGone);
      await ctx.tx
        .delete(crewMembers)
        .where(and(eq(crewMembers.crewId, crewId), isNotNull(crewMembers.personId)));
      if (personIds.length)
        await ctx.tx
          .insert(crewMembers)
          .values(
            personIds.map((personId) => ({ workspaceId: ws, crewId, personId, addedBy: me })),
          );
    }
    const members = await crewMemberIds(ctx, crewId);
    await ctx.emit({
      type: 'contractor.crew.saved',
      entityType: 'contractor_crew',
      entityId: crewId,
      payload: {
        crewId,
        created: !input.crewId,
        people: members.userIds.length,
        subs: members.personIds.length,
      },
      after: { name, people: members.userIds.length, subcontractors: members.personIds.length },
    });
    return { crewId, name, created: !input.crewId };
  },
});

export const crewArchive = defineAddonCommand(contractorAddon, {
  name: 'contractor.crew.archive',
  description:
    'Archive a crew that’s no longer used, or bring one back. Visits it worked keep its name.',
  risk: 1,
  input: CrewArchiveInput,
  output: CrewArchiveOutput,
  permission: 'contractor.manage',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_archive_crew',
    description:
      'Archive a crew (archived: true, the default) or bring it back (archived: false). Visits it worked keep its name. Asks the person first.',
    autonomy: 'confirm',
    what: (input) =>
      (input as { archived?: boolean }).archived === false
        ? 'Bring the crew back'
        : 'Archive the crew',
    outcome: (output) => ({
      words: (output as { archived?: boolean }).archived
        ? 'The crew is archived.'
        : 'The crew is back.',
      path: settingsPath,
    }),
  },
  emits: ['contractor.crew.archived'],
  async handler(ctx, input) {
    const crew = await loadCrew(ctx, input.crewId, { lock: true });
    if (crew.archived === input.archived) return { crewId: crew.id, archived: crew.archived };
    if (!input.archived) {
      await requireRoomForACrew(ctx);
      await requireNameFree(ctx, crew.name, crew.id);
    }
    await ctx.tx
      .update(crews)
      .set({ archivedAt: input.archived ? dsql`now()` : null, updatedAt: new Date() })
      .where(eq(crews.id, crew.id));
    await ctx.emit({
      type: 'contractor.crew.archived',
      entityType: 'contractor_crew',
      entityId: crew.id,
      payload: { crewId: crew.id, archived: input.archived },
      after: { name: crew.name, archived: input.archived },
    });
    return { crewId: crew.id, archived: input.archived };
  },
});

export const crewList = defineAddonQuery(contractorAddon, {
  name: 'contractor.crew.list',
  description:
    'The business’s crews, each with the people on its team and the subcontractors in it.',
  input: CrewListInput,
  output: CrewListOutput,
  permission: 'contractor.use',
  scope: inWorkspace,
  ai: {
    tool: 'contractor_list_crews',
    description:
      'The business’s crews (includeArchived for archived ones too), each with its crew id, the team members in it (with user ids) and its subcontractors (contacts, with person ids, their company and whether they can be texted).',
    keywords: ['crew', 'crews', 'subcontractors'],
  },
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const list = await ctx.tx
      .select({ id: crews.id, name: crews.name, archivedAt: crews.archivedAt })
      .from(crews)
      .where(
        and(
          eq(crews.workspaceId, ws),
          ...(input.includeArchived ? [] : [isNull(crews.archivedAt)]),
        ),
      )
      .orderBy(dsql`${crews.archivedAt} is not null`, dsql`lower(${crews.name})`);
    if (!list.length) return { crews: [] };
    const members = await rows<{
      crew_id: string;
      user_id: string | null;
      person_id: string | null;
      user_name: string | null;
    }>(
      ctx.tx,
      sql`select m.crew_id, m.user_id, m.person_id,
            coalesce(nullif(btrim(u.full_name), ''), u.email::text) as user_name
          from addon_contractor.crew_members m
          left join app.users u on u.id = m.user_id
          where m.workspace_id = ${ws}
          order by m.created_at, m.id`,
    );
    const subs = await subsOf(
      ctx,
      members.map((m) => m.person_id).filter((p): p is string => !!p),
    );
    return {
      crews: list.map((c) => {
        const mine = members.filter((m) => m.crew_id === c.id);
        return {
          id: c.id,
          name: c.name,
          archived: c.archivedAt !== null,
          people: mine
            .filter((m) => m.user_id)
            .map((m) => ({ userId: m.user_id!, name: m.user_name ?? 'Someone' })),
          subs: mine.flatMap((m) => {
            const sub = m.person_id ? subs.get(m.person_id) : undefined;
            return sub ? [subOut(sub)] : [];
          }),
        };
      }),
    };
  },
});
