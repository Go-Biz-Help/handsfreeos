/**
 * Who a customer is assigned to (0101): their owner, the main person on them, and a team beside the owner — one
 * teammate installing a client's automations while another runs their SEO. Being on a customer shows it to a
 * member in the inbox and in money, the same as owning it, so owners and admins decide who is on one
 * (records.assign); everyone sees who is.
 *
 * One person at a time, like tags (record.add_tag), so two people assigning the same customer at the same moment
 * both land. The owner is never also on the team: the database takes them out (0101).
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { companies, people } from '@hfos/db/schema';
import { fullName } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { hasWorkspacePermission } from '../permissions';
import { stampSql } from '../kernel/field-merge';
import { changeMoment } from '../kernel/moment';
import type { CommandContext } from '../kernel/types';
import { RecordAssignInput, RecordAssignOutput, RecordUnassignInput } from '../schemas/crm';

type Kind = 'person' | 'company';

interface Assigned {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string | null;
  readonly teamUserIds: readonly string[];
}

/** The customer, locked: two assignments at once queue behind each other rather than one undoing the other. */
async function lockCustomer(ctx: CommandContext, kind: Kind, id: string): Promise<Assigned> {
  const ws = ctx.scope.workspaceId!;
  if (kind === 'person') {
    const [p] = await ctx.tx
      .select()
      .from(people)
      .where(and(eq(people.id, id), eq(people.workspaceId, ws)))
      .for('update');
    if (!p) throw HfosError.notFound('That customer isn’t there anymore.');
    return {
      id: p.id,
      name: fullName(p.firstName, p.lastName),
      ownerUserId: p.ownerUserId,
      teamUserIds: p.teamUserIds,
    };
  }
  const [c] = await ctx.tx
    .select()
    .from(companies)
    .where(and(eq(companies.id, id), eq(companies.workspaceId, ws)))
    .for('update');
  if (!c) throw HfosError.notFound('That company isn’t there anymore.');
  return { id: c.id, name: c.name, ownerUserId: c.ownerUserId, teamUserIds: c.teamUserIds };
}

/** Names for the people on a customer, in order; somebody who has left reads "Former member". */
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

async function answer(ctx: CommandContext, a: Assigned, changed: boolean) {
  const names = await namesOf(ctx, [...(a.ownerUserId ? [a.ownerUserId] : []), ...a.teamUserIds]);
  const ref = (id: string) => ({ id, fullName: names.get(id) ?? 'Former member' });
  return {
    owner: a.ownerUserId ? ref(a.ownerUserId) : null,
    team: a.teamUserIds.map(ref),
    changed,
  };
}

/** Writes the new owner and team, stamps them for newest-wins (0055) and says so on the customer's record. */
async function save(
  ctx: CommandContext,
  kind: Kind,
  before: Assigned,
  next: { ownerUserId: string | null; teamUserIds: string[] },
): Promise<Assigned> {
  const at = changeMoment(ctx.meta);
  const columns = [
    ...(next.ownerUserId !== before.ownerUserId ? ['owner_user_id'] : []),
    'team_user_ids',
  ];
  const patch = {
    ownerUserId: next.ownerUserId,
    teamUserIds: next.teamUserIds,
    fieldTimes: stampSql(columns, at),
  };
  const [row] =
    kind === 'person'
      ? await ctx.tx
          .update(people)
          .set(patch)
          .where(eq(people.id, before.id))
          .returning({ ownerUserId: people.ownerUserId, teamUserIds: people.teamUserIds })
      : await ctx.tx
          .update(companies)
          .set(patch)
          .where(eq(companies.id, before.id))
          .returning({ ownerUserId: companies.ownerUserId, teamUserIds: companies.teamUserIds });
  if (!row) throw HfosError.forbidden();
  const after: Assigned = { ...before, ownerUserId: row.ownerUserId, teamUserIds: row.teamUserIds };
  const names = await namesOf(ctx, [
    ...new Set(
      [before.ownerUserId, after.ownerUserId, ...before.teamUserIds, ...after.teamUserIds].filter(
        (id): id is string => !!id,
      ),
    ),
  ]);
  const said = (a: Assigned) =>
    [a.ownerUserId, ...a.teamUserIds]
      .filter((id): id is string => !!id)
      .map((id) => names.get(id) ?? 'Former member')
      .join(', ') || 'Nobody';
  const fields = [
    ...(after.ownerUserId !== before.ownerUserId ? ['ownerUserId'] : []),
    ...(after.teamUserIds.join() !== before.teamUserIds.join() ? ['teamUserIds'] : []),
  ];
  await ctx.emit({
    type: kind === 'person' ? 'person.updated' : 'company.updated',
    entityType: kind,
    entityId: before.id,
    payload: { name: before.name, fields },
    before: { name: before.name, assignedTo: said(before) },
    after: { name: before.name, assignedTo: said(after) },
    broadcast: ctx.actor.type === 'human',
  });
  return after;
}

/**
 * Owners and admins change who is on a customer; the database refuses anybody else too (0101). People only: the
 * system — imports, the booking page, a workflow — is not asked, the same as the database's guard.
 */
export function requireAssigner(ctx: CommandContext): void {
  if (ctx.actor.type !== 'human') return;
  if (!hasWorkspacePermission(ctx.scope.workspaceRole ?? null, 'records.assign'))
    throw HfosError.rule(
      'customer_team_managers_only',
      403,
      'Only owners and admins change who a customer is assigned to.',
    );
}

/** The most people a customer can have besides its main one: the database's own limit (0101). */
const MAX_TEAM = 20;

/** Somebody who can open this business, the only people a customer can be assigned to. */
async function requireTeammate(ctx: CommandContext, userId: string): Promise<void> {
  const [ok] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select private.workspace_has_user(${ctx.scope.workspaceId!}::uuid, ${userId}::uuid) as ok`,
  );
  if (!ok?.ok)
    throw HfosError.validation([{ path: 'userId', message: 'Pick someone on the team.' }]);
}

export const recordAssign = defineCommand({
  name: 'record.assign',
  description:
    'Assign a customer or a company to someone on the team (owners and admins). They join its team, or become its owner when it has none; with main, they become the owner and the owner stays on it. Being on a customer shows a member that customer’s threads and bills; being on a company marks who works with it.',
  risk: 1,
  input: RecordAssignInput,
  output: RecordAssignOutput,
  permission: 'records.assign',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.updated', 'company.updated'],
  async handler(ctx, input) {
    const before = await lockCustomer(ctx, input.recordType, input.recordId);
    const { userId } = input;
    const isOwner = before.ownerUserId === userId;
    const onTeam = before.teamUserIds.includes(userId);
    let next: { ownerUserId: string | null; teamUserIds: string[] } | null = null;
    if (input.main && !isOwner) {
      await requireTeammate(ctx, userId);
      // The owner they replace stays on the customer, first in line.
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
        'customer_team_full',
        409,
        `A customer can have up to ${MAX_TEAM} people on it besides the main one. Take someone off first.`,
      );
    return answer(ctx, await save(ctx, input.recordType, before, next), true);
  },
});

export const recordUnassign = defineCommand({
  name: 'record.unassign',
  description:
    'Take someone off a customer or a company (owners and admins). Taking the owner off makes the next person on its team the owner.',
  risk: 1,
  input: RecordUnassignInput,
  output: RecordAssignOutput,
  permission: 'records.assign',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['person.updated', 'company.updated'],
  async handler(ctx, input) {
    const before = await lockCustomer(ctx, input.recordType, input.recordId);
    const { userId } = input;
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
    return answer(ctx, await save(ctx, input.recordType, before, next), true);
  },
});
