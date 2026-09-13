import { and, desc, eq, gte, like, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { auditLogs, users } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { AuditListInput, AuditListOutput } from '../schemas/audit';

export const auditList = defineQuery({
  name: 'audit.list',
  description: 'Who changed what in a workspace, newest first.',
  input: AuditListInput,
  output: AuditListOutput,
  permission: 'audit.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const conditions = [eq(auditLogs.workspaceId, input.workspaceId)];
    if (input.before) conditions.push(lt(auditLogs.createdAt, new Date(input.before)));
    if (input.since) conditions.push(gte(auditLogs.createdAt, new Date(input.since)));
    if (input.actorId) conditions.push(eq(auditLogs.actorId, input.actorId));
    if (input.action) conditions.push(like(auditLogs.action, `${input.action}%`));
    if (input.channel) conditions.push(eq(auditLogs.channel, input.channel));
    const target = alias(users, 'target');
    const list = await ctx.tx
      .select({ a: auditLogs, actorName: users.fullName, entityName: target.fullName })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .leftJoin(target, eq(target.id, auditLogs.entityId))
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(input.limit + 1);
    const page = list.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      entries: page.map(({ a, actorName, entityName }) => ({
        id: a.id,
        eventId: a.eventId,
        action: a.action,
        actor: { type: a.actorType, userId: a.actorId, fullName: actorName, role: a.actorRole },
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
      nextCursor: list.length > input.limit && last ? last.a.createdAt.toISOString() : null,
    };
  },
});
