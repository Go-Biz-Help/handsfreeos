/**
 * Who is on a record kept to its people (Real Estate, step 4): its main person and everyone else on it, the only
 * people besides whoever sees every record of its kind who know it's there. Its main person puts people on it and
 * takes them off; owners and admins (records.assign) do too, and alone choose its main person. The database holds
 * everyone to the same rule (`private.guard_record_team`), and refuses anybody who doesn't work in the business.
 *
 * One person at a time, like a customer's (record.assign), so two changes at the same moment both land.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { customRecords } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { RecordAssignOutput } from '../schemas/crm';
import { CustomRecordAssignInput, CustomRecordUnassignInput } from '../schemas/relationship';

interface OnIt {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string | null;
  readonly teamUserIds: readonly string[];
}

const MAX_TEAM = 20;

/** The record, locked, and only one kept to its people: everyone already sees any other. */
async function lockPrivate(ctx: CommandContext, id: string): Promise<OnIt> {
  const [r] = await ctx.tx
    .select()
    .from(customRecords)
    .where(and(eq(customRecords.id, id), eq(customRecords.workspaceId, ctx.scope.workspaceId!)))
    .for('update');
  if (!r)
    throw HfosError.notFound(
      'That record isn’t there anymore, or you’re not on it. Refresh and try again.',
    );
  if (!r.keptToTeam)
    throw HfosError.rule(
      'record_not_private',
      400,
      `Everyone in this business already sees ${r.name}, so nobody needs to be put on it.`,
    );
  return { id: r.id, name: r.name, ownerUserId: r.ownerUserId, teamUserIds: r.teamUserIds };
}

/** Its main person, or an owner or admin; the system acting for an add-on too. */
function requireChooser(ctx: CommandContext, before: OnIt, main: boolean): void {
  if (ctx.actor.type !== 'human') return;
  if (scopeCan(ctx.scope, 'records.assign')) return;
  if (!main && before.ownerUserId === ctx.actor.userId) return;
  throw HfosError.rule(
    'record_team_not_yours',
    403,
    main
      ? `Only an owner or admin chooses the main person on ${before.name}. Ask one of them.`
      : `Only the main person on ${before.name}, or an owner or admin, changes who’s on it. Ask them to add or remove people.`,
  );
}

async function namesOf(ctx: CommandContext, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const list = await rows<{ id: string; name: string }>(
    ctx.tx,
    sql`select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name
        from app.users u
        where u.id = any(array[${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )}])`,
  );
  return new Map(list.map((u) => [u.id, u.name]));
}

async function answer(ctx: CommandContext, a: OnIt, changed: boolean) {
  const names = await namesOf(ctx, [...(a.ownerUserId ? [a.ownerUserId] : []), ...a.teamUserIds]);
  const ref = (id: string) => ({ id, fullName: names.get(id) ?? 'Former member' });
  return {
    owner: a.ownerUserId ? ref(a.ownerUserId) : null,
    team: a.teamUserIds.map(ref),
    changed,
  };
}

/** Somebody who works in this business: the only people a record can be kept to. */
async function requireTeammate(ctx: CommandContext, userId: string): Promise<void> {
  const [ok] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.works_in(${userId}::uuid, ${ctx.scope.workspaceId!}::uuid) as ok`,
  );
  if (!ok?.ok)
    throw HfosError.validation([
      {
        path: 'userId',
        message: 'That person isn’t on this business’s team. Pick someone who is.',
      },
    ]);
}

/** Writes who is on it, says so on its timeline, and records the change. */
async function save(
  ctx: CommandContext,
  before: OnIt,
  next: { ownerUserId: string | null; teamUserIds: string[] },
): Promise<OnIt> {
  const [row] = await ctx.tx
    .update(customRecords)
    .set({ ownerUserId: next.ownerUserId, teamUserIds: next.teamUserIds })
    .where(eq(customRecords.id, before.id))
    .returning({ ownerUserId: customRecords.ownerUserId, teamUserIds: customRecords.teamUserIds });
  if (!row) throw HfosError.forbidden();
  const after: OnIt = { ...before, ownerUserId: row.ownerUserId, teamUserIds: row.teamUserIds };
  const was = [before.ownerUserId, ...before.teamUserIds].filter((i): i is string => !!i);
  const now = [after.ownerUserId, ...after.teamUserIds].filter((i): i is string => !!i);
  const names = await namesOf(ctx, [...new Set([...was, ...now])]);
  const name = (id: string) => names.get(id) ?? 'Former member';
  const added = now.filter((i) => !was.includes(i)).map(name);
  const removed = was.filter((i) => !now.includes(i)).map(name);
  const main =
    after.ownerUserId !== before.ownerUserId && after.ownerUserId ? name(after.ownerUserId) : null;
  const said = (a: OnIt) =>
    [a.ownerUserId, ...a.teamUserIds]
      .filter((i): i is string => !!i)
      .map(name)
      .join(', ') || 'Nobody';
  const eventId = await ctx.emit({
    type: 'custom_record.team_changed',
    entityType: 'custom_record',
    entityId: before.id,
    payload: {
      name: before.name,
      ownerUserId: after.ownerUserId,
      teamUserIds: after.teamUserIds,
      added: now.filter((i) => !was.includes(i)),
      removed: was.filter((i) => !now.includes(i)),
    },
    before: { name: before.name, assignedTo: said(before) },
    after: { name: before.name, assignedTo: said(after) },
  });
  await logSystemActivity(ctx, {
    subtype: 'team_changed',
    customRecordId: before.id,
    meta: { added, removed, main },
    eventId,
  });
  return after;
}

export const customRecordAssign = defineCommand({
  name: 'custom_record.assign',
  description:
    'Put someone on a record kept to its people (a deal): they see it and everything about it. With main, they become its main person (owners and admins only); the one they replace stays on it.',
  risk: 2,
  input: CustomRecordAssignInput,
  output: RecordAssignOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['custom_record.team_changed'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const before = await lockPrivate(ctx, input.customRecordId);
    requireChooser(ctx, before, input.main);
    const { userId } = input;
    const isOwner = before.ownerUserId === userId;
    const onTeam = before.teamUserIds.includes(userId);
    let next: { ownerUserId: string | null; teamUserIds: string[] } | null = null;
    if (input.main && !isOwner) {
      await requireTeammate(ctx, userId);
      next = {
        ownerUserId: userId,
        teamUserIds: [
          ...(before.ownerUserId ? [before.ownerUserId] : []),
          ...before.teamUserIds.filter((id) => id !== userId),
        ],
      };
    } else if (!input.main && !isOwner && !onTeam) {
      await requireTeammate(ctx, userId);
      next = before.ownerUserId
        ? { ownerUserId: before.ownerUserId, teamUserIds: [...before.teamUserIds, userId] }
        : { ownerUserId: userId, teamUserIds: [...before.teamUserIds] };
    }
    if (!next) return answer(ctx, before, false);
    if (next.teamUserIds.length > MAX_TEAM)
      throw HfosError.rule(
        'record_team_full',
        409,
        `${before.name} already has ${MAX_TEAM} people on it besides the main one, which is the most it can have. Take someone off first.`,
      );
    return answer(ctx, await save(ctx, before, next), true);
  },
});

export const customRecordUnassign = defineCommand({
  name: 'custom_record.unassign',
  description:
    'Take someone off a record kept to its people. Its main person can only be taken off by an owner or admin, and the next person on it becomes the main one.',
  risk: 2,
  input: CustomRecordUnassignInput,
  output: RecordAssignOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['custom_record.team_changed'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const before = await lockPrivate(ctx, input.customRecordId);
    const { userId } = input;
    requireChooser(ctx, before, before.ownerUserId === userId);
    let next: { ownerUserId: string | null; teamUserIds: string[] } | null = null;
    if (before.ownerUserId === userId) {
      const [first = null, ...rest] = before.teamUserIds;
      next = { ownerUserId: first, teamUserIds: rest };
    } else if (before.teamUserIds.includes(userId)) {
      next = {
        ownerUserId: before.ownerUserId,
        teamUserIds: before.teamUserIds.filter((id) => id !== userId),
      };
    }
    if (!next) return answer(ctx, before, false);
    return answer(ctx, await save(ctx, before, next), true);
  },
});

export const customRecordTeamCommands = [customRecordAssign, customRecordUnassign];
