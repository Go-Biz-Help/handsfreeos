import { randomUUID } from 'node:crypto';
import { asUser, rows, sql, type Db, type Tx } from '@hfos/db/client';
import { auditLogs, events, outbox } from '@hfos/db/schema';
import type { z } from 'zod';
import { HfosError } from '../errors';
import {
  hasOrgPermission,
  hasWorkspacePermission,
  isOrgPermission,
  type OrgRole,
  type Permission,
  type WorkspaceRole,
} from '../permissions';
import { translateDbError } from './pg-errors';
import { redact } from './redact';
import type {
  CommandDef,
  EmitInput,
  HumanActor,
  QueryDef,
  RequestMeta,
  ResolvedScope,
  ScopeRef,
} from './types';

function parseInput<I extends z.ZodType>(schema: I, raw: unknown): z.output<I> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw HfosError.validation(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

async function resolveScope(tx: Tx, ref: ScopeRef): Promise<ResolvedScope> {
  switch (ref.kind) {
    case 'workspace': {
      const [row] = await rows<{ role: WorkspaceRole | null; org: string | null }>(
        tx,
        sql`select private.effective_workspace_role(${ref.workspaceId})::text as role, private.workspace_organization(${ref.workspaceId}) as org`,
      );
      // A workspace the user cannot see does not exist for them (no 403 existence leak).
      if (!row?.role || !row.org) throw HfosError.notFound('Workspace not found.');
      return {
        workspaceId: ref.workspaceId,
        organizationId: row.org,
        workspaceRole: row.role,
        orgRole: null,
      };
    }
    case 'organization': {
      const [row] = await rows<{ role: OrgRole | null }>(
        tx,
        sql`select private.org_role(${ref.organizationId}) as role`,
      );
      if (!row?.role) throw HfosError.notFound('Organization not found.');
      return {
        organizationId: ref.organizationId,
        workspaceId: null,
        workspaceRole: null,
        orgRole: row.role,
      };
    }
    default:
      return { organizationId: null, workspaceId: null, workspaceRole: null, orgRole: null };
  }
}

function assertPermission(scope: ResolvedScope, permission: Permission): void {
  const ok = isOrgPermission(permission)
    ? hasOrgPermission(scope.orgRole, permission)
    : hasWorkspacePermission(scope.workspaceRole, permission);
  if (!ok) throw HfosError.forbidden();
}

function actorRoleLabel(scope: ResolvedScope): string | null {
  return scope.workspaceRole ?? (scope.orgRole ? `org_${scope.orgRole}` : null);
}

async function recordEvent(
  tx: Tx,
  commandName: string,
  actor: HumanActor,
  scope: ResolvedScope,
  meta: RequestMeta,
  e: EmitInput,
): Promise<string> {
  const eventId = randomUUID();
  const organizationId = e.organizationId !== undefined ? e.organizationId : scope.organizationId;
  const workspaceId = e.workspaceId !== undefined ? e.workspaceId : scope.workspaceId;
  const entityId = e.entityId ?? null;
  await tx.insert(events).values({
    id: eventId,
    organizationId,
    workspaceId,
    eventType: e.type,
    actorType: 'human',
    actorId: actor.userId,
    entityType: e.entityType,
    entityId,
    payload: redact(e.payload ?? {}),
    correlationId: meta.correlationId,
    causationId: meta.causationId ?? null,
  });
  await tx.insert(outbox).values({ eventId, organizationId, workspaceId, eventType: e.type });
  await tx.insert(auditLogs).values({
    eventId,
    organizationId,
    workspaceId,
    actorType: 'human',
    actorId: actor.userId,
    actorRole: actorRoleLabel(scope),
    action: commandName,
    entityType: e.entityType,
    entityId,
    before: e.before ? redact(e.before) : null,
    after: e.after ? redact(e.after) : null,
    reason: meta.reason ?? null,
    channel: meta.channel,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
    correlationId: meta.correlationId,
    causationId: meta.causationId ?? null,
  });
  return eventId;
}

export interface ExecuteResult<T> {
  readonly output: T;
  readonly eventIds: readonly string[];
}

/**
 * The pipeline every actor shares: validate → transaction as the user (RLS on) → resolve scope →
 * permission → handler → event + outbox + audit rows in the same transaction → validated output.
 */
export async function executeCommand<I extends z.ZodType, O extends z.ZodType>(
  db: Db,
  cmd: CommandDef<I, O>,
  rawInput: unknown,
  actor: HumanActor,
  meta: RequestMeta,
): Promise<ExecuteResult<z.output<O>>> {
  const input = parseInput(cmd.input, rawInput);
  const scopeRef = cmd.scope(input);
  try {
    return await asUser(db, actor.claims, async (tx) => {
      const scope = await resolveScope(tx, scopeRef);
      if (cmd.permission) assertPermission(scope, cmd.permission);
      const eventIds: string[] = [];
      const emit = async (e: EmitInput): Promise<string> => {
        if (!cmd.emits.includes(e.type))
          throw new Error(`${cmd.name} emitted undeclared event ${e.type}`);
        const id = await recordEvent(tx, cmd.name, actor, scope, meta, e);
        eventIds.push(id);
        return id;
      };
      const result = await cmd.handler(
        { tx, actor, scope, meta, commandName: cmd.name, emit },
        input,
      );
      return { output: cmd.output.parse(result) as z.output<O>, eventIds };
    });
  } catch (e) {
    throw translateDbError(e);
  }
}

export async function executeQuery<I extends z.ZodType, O extends z.ZodType>(
  db: Db,
  query: QueryDef<I, O>,
  rawInput: unknown,
  actor: HumanActor,
  meta: RequestMeta,
): Promise<z.output<O>> {
  const input = parseInput(query.input, rawInput);
  const scopeRef = query.scope(input);
  try {
    return await asUser(db, actor.claims, async (tx) => {
      const scope = await resolveScope(tx, scopeRef);
      if (query.permission) assertPermission(scope, query.permission);
      const result = await query.handler({ tx, actor, scope, meta }, input);
      return query.output.parse(result) as z.output<O>;
    });
  } catch (e) {
    throw translateDbError(e);
  }
}
