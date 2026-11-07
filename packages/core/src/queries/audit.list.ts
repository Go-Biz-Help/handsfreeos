import { and, desc, eq, gte, inArray, like, lt, not, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { auditLogs, users, workflows } from '@hfos/db/schema';
import { AUDIT_CATEGORY_RULES, type AuditCategory } from '../audit/describe';
import { defineQuery } from '../kernel/define';
import { decodeTimeCursor, encodeCursor } from '../kernel/pagination';
import { AuditListInput, AuditListOutput } from '../schemas/audit';

/** An action matching one of Filter by activity's rules: one it names, or one starting with a prefix of it. */
const matchesRule = (rule: (typeof AUDIT_CATEGORY_RULES)[number]): SQL =>
  or(
    ...rule.prefixes.map((p) => sql`starts_with(${auditLogs.action}, ${p})`),
    ...(rule.actions?.length ? [inArray(auditLogs.action, [...rule.actions])] : []),
  )!;

/**
 * The rows of one kind of change, sorted as auditCategory sorts them: the first rule an action matches is its kind, so
 * a kind is its own rule and none of the ones before it; Other is none of them.
 */
function inCategory(category: AuditCategory): SQL {
  const at = AUDIT_CATEGORY_RULES.findIndex((r) => r.category === category);
  const before = (at < 0 ? AUDIT_CATEGORY_RULES : AUDIT_CATEGORY_RULES.slice(0, at)).map(
    matchesRule,
  );
  const earlier = before.length ? [not(or(...before)!)] : [];
  return at < 0 ? and(...earlier)! : and(matchesRule(AUDIT_CATEGORY_RULES[at]!), ...earlier)!;
}

export const auditList = defineQuery({
  name: 'audit.list',
  description: 'Who changed what in a workspace, newest first.',
  input: AuditListInput,
  output: AuditListOutput,
  permission: 'audit.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const cursor = decodeTimeCursor(input.cursor);
    const conditions = [eq(auditLogs.workspaceId, input.workspaceId)];
    // Keyed on (created_at, id) at full precision: one command's entries share its now(), and a page can end
    // among them.
    if (cursor)
      conditions.push(
        sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)`,
      );
    if (input.before) conditions.push(lt(auditLogs.createdAt, new Date(input.before)));
    if (input.since) conditions.push(gte(auditLogs.createdAt, new Date(input.since)));
    if (input.actorId) conditions.push(eq(auditLogs.actorId, input.actorId));
    if (input.action) conditions.push(like(auditLogs.action, `${input.action}%`));
    if (input.channel) conditions.push(eq(auditLogs.channel, input.channel));
    if (input.actorType) conditions.push(eq(auditLogs.actorType, input.actorType));
    if (input.category) conditions.push(inCategory(input.category));
    const target = alias(users, 'target');
    // A workflow is recorded as itself (actor_id is the workflow), so its name comes from workflows.
    const flow = alias(workflows, 'flow');
    const list = await ctx.tx
      .select({
        a: auditLogs,
        actorName: users.fullName,
        entityName: target.fullName,
        workflowName: flow.name,
        sortKey: sql<string>`to_char(${auditLogs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .leftJoin(target, eq(target.id, auditLogs.entityId))
      .leftJoin(
        flow,
        and(
          eq(auditLogs.actorType, 'workflow'),
          eq(flow.id, auditLogs.actorId),
          eq(flow.workspaceId, auditLogs.workspaceId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(input.limit + 1);
    const page = list.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      entries: page.map(({ a, actorName, entityName, workflowName }) => ({
        id: a.id,
        eventId: a.eventId,
        action: a.action,
        actor: {
          type: a.actorType,
          userId: a.actorId,
          fullName: actorName,
          role: a.actorRole,
          workflow:
            a.actorType === 'workflow' && a.actorId && workflowName !== null
              ? { id: a.actorId, name: workflowName }
              : null,
        },
        entityType: a.entityType,
        entityId: a.entityId,
        entityName:
          a.entityType === 'workspace_membership' || a.entityType === 'user'
            ? (entityName ?? null)
            : null,
        before: a.before,
        after: a.after,
        reason: a.reason,
        channel: a.channel,
        correlationId: a.correlationId,
        causationId: a.causationId,
        createdAt: a.createdAt.toISOString(),
      })),
      nextCursor:
        list.length > input.limit && last
          ? encodeCursor({ sort: last.sortKey, id: last.a.id })
          : null,
    };
  },
});
