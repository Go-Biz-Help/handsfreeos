import { randomUUID } from 'node:crypto';
import { asUser, asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
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
import { isMachine } from './actor';
import { translateDbError } from './pg-errors';
import { redact } from './redact';
import type {
  Actor,
  ActorKind,
  CommandDef,
  EmitInput,
  MachineActor,
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

/**
 * A machine actor (the system, a workflow) may only address its own tenant; anything else does not exist
 * for it.
 */
function resolveMachineScope(actor: MachineActor, ref: ScopeRef): ResolvedScope {
  switch (ref.kind) {
    case 'workspace':
      if (ref.workspaceId !== actor.workspaceId) throw HfosError.notFound('Workspace not found.');
      return {
        workspaceId: actor.workspaceId,
        organizationId: actor.organizationId,
        workspaceRole: null,
        orgRole: null,
      };
    case 'organization':
      if (ref.organizationId !== actor.organizationId)
        throw HfosError.notFound('Organization not found.');
      return {
        workspaceId: null,
        organizationId: actor.organizationId,
        workspaceRole: null,
        orgRole: null,
      };
    default:
      return {
        workspaceId: actor.workspaceId,
        organizationId: actor.organizationId,
        workspaceRole: null,
        orgRole: null,
      };
  }
}

function assertPermission(scope: ResolvedScope, permission: Permission): void {
  const ok = isOrgPermission(permission)
    ? hasOrgPermission(scope.orgRole, permission)
    : hasWorkspacePermission(scope.workspaceRole, permission);
  if (!ok) throw HfosError.forbidden();
}

/** Commands and queries are for people unless they opt in to the system or to workflows (`actors`). */
function assertActorAllowed(
  op: { readonly name: string; readonly actors?: readonly ActorKind[] },
  actor: Actor,
): void {
  if (!(op.actors ?? ['human']).includes(actor.type))
    throw HfosError.forbidden(`${op.name} cannot be run by a ${actor.type} actor.`);
}

function actorRoleLabel(scope: ResolvedScope): string | null {
  return scope.workspaceRole ?? (scope.orgRole ? `org_${scope.orgRole}` : null);
}

interface RecordedActor {
  readonly actorType: ActorKind;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  /** What the kernel adds to every event payload for this actor. */
  readonly payload: Record<string, unknown>;
}

/**
 * How an actor appears on its event and audit rows. A workflow is recorded as itself (actor_id is the
 * workflow), and its events name the run that caused them (`_workflow`), which the engine's loop guards read.
 */
function recordedActor(actor: Actor, scope: ResolvedScope): RecordedActor {
  switch (actor.type) {
    case 'human':
      return {
        actorType: 'human',
        actorId: actor.userId,
        actorRole: actorRoleLabel(scope),
        payload: {},
      };
    case 'system':
      return {
        actorType: 'system',
        actorId: null,
        actorRole: 'system',
        payload: actor.onBehalfOf ? { onBehalfOf: actor.onBehalfOf } : {},
      };
    case 'workflow':
      return {
        actorType: 'workflow',
        actorId: actor.workflowId,
        actorRole: 'workflow',
        payload: {
          _workflow: {
            runId: actor.runId,
            workflowId: actor.workflowId,
            versionId: actor.versionId,
            depth: actor.depth,
            originRunId: actor.originRunId,
          },
        },
      };
  }
}

async function recordEvent(
  tx: Tx,
  commandName: string,
  actor: Actor,
  scope: ResolvedScope,
  meta: RequestMeta,
  e: EmitInput,
): Promise<string> {
  const eventId = randomUUID();
  const organizationId = e.organizationId !== undefined ? e.organizationId : scope.organizationId;
  const workspaceId = e.workspaceId !== undefined ? e.workspaceId : scope.workspaceId;
  const entityId = e.entityId ?? null;
  const who = recordedActor(actor, scope);
  const payload = redact({
    ...(e.payload ?? {}),
    ...who.payload,
    ...(e.broadcast === false ? { _broadcast: false } : {}),
  });
  await tx.insert(events).values({
    id: eventId,
    organizationId,
    workspaceId,
    eventType: e.type,
    actorType: who.actorType,
    actorId: who.actorId,
    entityType: e.entityType,
    entityId,
    payload,
    correlationId: meta.correlationId,
    causationId: meta.causationId ?? null,
  });
  await tx.insert(outbox).values({ eventId, organizationId, workspaceId, eventType: e.type });
  await tx.insert(auditLogs).values({
    eventId,
    organizationId,
    workspaceId,
    actorType: who.actorType,
    actorId: who.actorId,
    actorRole: who.actorRole,
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

/** The handler, its declared events (event + outbox + audit rows, all in `tx`) and the validated output. */
async function runCommand<I extends z.ZodType, O extends z.ZodType>(
  tx: Tx,
  cmd: CommandDef<I, O>,
  input: z.output<I>,
  actor: Actor,
  scope: ResolvedScope,
  meta: RequestMeta,
): Promise<ExecuteResult<z.output<O>>> {
  const eventIds: string[] = [];
  const emit = async (e: EmitInput): Promise<string> => {
    if (!cmd.emits.includes(e.type))
      throw new Error(`${cmd.name} emitted undeclared event ${e.type}`);
    const id = await recordEvent(tx, cmd.name, actor, scope, meta, e);
    eventIds.push(id);
    return id;
  };
  const result = await cmd.handler({ tx, actor, scope, meta, commandName: cmd.name, emit }, input);
  return { output: cmd.output.parse(result) as z.output<O>, eventIds };
}

/**
 * The pipeline every actor shares: validate → one transaction, as the user (RLS on) or, for the system and
 * workflows, as the service actor bound to their workspace → resolve scope → permission (people only) →
 * handler → event + outbox + audit rows in the same transaction → validated output.
 */
export async function executeCommand<I extends z.ZodType, O extends z.ZodType>(
  db: Db,
  cmd: CommandDef<I, O>,
  rawInput: unknown,
  actor: Actor,
  meta: RequestMeta,
): Promise<ExecuteResult<z.output<O>>> {
  assertActorAllowed(cmd, actor);
  const input = parseInput(cmd.input, rawInput);
  const scopeRef = cmd.scope(input);
  try {
    if (isMachine(actor)) {
      // Root within its tenant (no permission check), bound by the service_actor policies.
      const scope = resolveMachineScope(actor, scopeRef);
      return await asWorker(
        db,
        { workspaceId: actor.workspaceId, organizationId: actor.organizationId },
        (tx) => runCommand(tx, cmd, input, actor, scope, meta),
      );
    }
    return await asUser(db, actor.claims, async (tx) => {
      const scope = await resolveScope(tx, scopeRef);
      if (cmd.permission) assertPermission(scope, cmd.permission);
      return runCommand(tx, cmd, input, actor, scope, meta);
    });
  } catch (e) {
    throw translateDbError(e);
  }
}

/** executeCommandIn's caller must hold exactly the actor's tenant, as the service actor, and nothing more. */
async function assertWorkerTx(tx: Tx, actor: MachineActor): Promise<void> {
  const [row] = await rows<{ role: string; workspace_id: string | null; org_id: string | null }>(
    tx,
    sql`select current_user::text as role,
          nullif(current_setting('app.system_scope.workspace_id', true), '') as workspace_id,
          nullif(current_setting('app.system_scope.organization_id', true), '') as org_id`,
  );
  if (
    row?.role !== 'service_actor' ||
    row.workspace_id !== actor.workspaceId ||
    row.org_id !== actor.organizationId
  )
    throw new Error(
      `executeCommandIn needs a transaction opened with asWorker for workspace ${actor.workspaceId}`,
    );
}

/**
 * Runs a command for the system or a workflow inside a transaction the caller already opened with `asWorker`
 * for the actor's workspace, so the command's writes, events, outbox and audit rows commit with the caller's
 * own: a workflow step and the action it takes are one unit, and roll back together. The command runs in a
 * savepoint, so a refusal or a database error undoes only the command's writes and leaves the caller's
 * transaction usable (to record the failure). Otherwise the same rules as executeCommand: allowed actors,
 * validation, no permission check, declared events only. People always use executeCommand.
 */
export async function executeCommandIn<I extends z.ZodType, O extends z.ZodType>(
  tx: Tx,
  cmd: CommandDef<I, O>,
  rawInput: unknown,
  actor: MachineActor,
  meta: RequestMeta,
): Promise<ExecuteResult<z.output<O>>> {
  if ((actor as Actor).type === 'human')
    throw HfosError.forbidden(
      'Only the system and workflows run commands in their own transaction.',
    );
  assertActorAllowed(cmd, actor);
  const input = parseInput(cmd.input, rawInput);
  const scope = resolveMachineScope(actor, cmd.scope(input));
  await assertWorkerTx(tx, actor);
  try {
    return await tx.transaction((savepoint) =>
      runCommand(savepoint, cmd, input, actor, scope, meta),
    );
  } catch (e) {
    throw translateDbError(e);
  }
}

export async function executeQuery<I extends z.ZodType, O extends z.ZodType>(
  db: Db,
  query: QueryDef<I, O>,
  rawInput: unknown,
  actor: Actor,
  meta: RequestMeta,
): Promise<z.output<O>> {
  assertActorAllowed(query, actor);
  const input = parseInput(query.input, rawInput);
  const scopeRef = query.scope(input);
  const run = async (tx: Tx, scope: ResolvedScope): Promise<z.output<O>> => {
    const result = await query.handler({ tx, actor, scope, meta }, input);
    return query.output.parse(result) as z.output<O>;
  };
  try {
    if (isMachine(actor)) {
      // Root within its tenant (no permission check), bound by the service_actor policies.
      const scope = resolveMachineScope(actor, scopeRef);
      return await asWorker(
        db,
        { workspaceId: actor.workspaceId, organizationId: actor.organizationId },
        (tx) => run(tx, scope),
      );
    }
    return await asUser(db, actor.claims, async (tx) => {
      const scope = await resolveScope(tx, scopeRef);
      if (query.permission) assertPermission(scope, query.permission);
      return run(tx, scope);
    });
  } catch (e) {
    throw translateDbError(e);
  }
}
