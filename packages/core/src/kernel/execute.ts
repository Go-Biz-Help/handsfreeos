import { randomUUID } from 'node:crypto';
import { asCustomer, asUser, asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import { auditLogs, events, outbox } from '@hfos/db/schema';
import type { z } from 'zod';
import { HfosError } from '../errors';
import {
  hasOrgPermission,
  hasStaffPermission,
  hasWorkspacePermission,
  isOrgPermission,
  isStaffPermission,
  missingPermissionMessage,
  type OrgRole,
  type Permission,
  type StaffRole,
  type WorkspaceRole,
} from '../permissions';
import { aiEmployeeMayRun, isMachine } from './actor';
import { assertAppRequest, assertOnTime } from './app-request';
import { shareChangeMoment } from './moment';
import { translateDbError } from './pg-errors';
import { claimReceipt, receiptClaim, recordRefusal, storeAnswer } from './receipts';
import { redact } from './redact';
import type {
  Actor,
  ActorKind,
  AddonRef,
  CommandContext,
  CommandDef,
  CustomerActor,
  EmitInput,
  HumanActor,
  MachineActor,
  PublicActor,
  QueryDef,
  RequestMeta,
  ResolvedScope,
  ScopeRef,
  WorkerActor,
} from './types';

/** A business the person can't see, or has left: the same answer as one that never existed. */
const businessNotThere = (): HfosError =>
  HfosError.notFound(
    'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
  );

/** The same for an agency (an organization with several businesses). */
const agencyNotThere = (): HfosError =>
  HfosError.notFound(
    'That agency isn’t there, or you’re no longer part of it. Pick one from your list.',
  );

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
      const [row] = await rows<{
        role: WorkspaceRole | null;
        org: string | null;
        view_as: string | null;
        permissions: string[] | null;
      }>(
        tx,
        sql`select private.my_workspace_role(${ref.workspaceId})::text as role,
                   private.workspace_organization(${ref.workspaceId}) as org,
                   (select session_id from private.my_view_as(${ref.workspaceId})) as view_as,
                   private.my_permissions(${ref.workspaceId}) as permissions`,
      );
      // A workspace the user cannot see does not exist for them (no 403 existence leak).
      if (!row?.org || (!row.role && !row.view_as)) throw businessNotThere();
      return {
        workspaceId: ref.workspaceId,
        organizationId: row.org,
        workspaceRole: row.role,
        workspacePermissions: row.role ? (row.permissions ?? []) : [],
        orgRole: null,
        // A support person looking at a business they have no standing in (M13). Their reads are the ones
        // the rules already allow a reader; every command is refused outright below. The founder working in
        // one (20261013002100) is not this: my_workspace_role gives them the owner's there while it is open.
        viewAs: !row.role && row.view_as ? { sessionId: row.view_as } : null,
      };
    }
    case 'organization': {
      const [row] = await rows<{ role: OrgRole | null }>(
        tx,
        sql`select private.org_role(${ref.organizationId}) as role`,
      );
      if (!row?.role) throw agencyNotThere();
      return {
        organizationId: ref.organizationId,
        workspaceId: null,
        workspaceRole: null,
        orgRole: row.role,
      };
    }
    case 'platform': {
      const [row] = await rows<{ role: StaffRole | null }>(
        tx,
        sql`select private.staff_role() as role`,
      );
      // The support desk does not exist for anyone who does not work here.
      if (!row?.role) throw HfosError.notFound('There’s nothing here. Head back to your business.');
      return {
        organizationId: null,
        workspaceId: null,
        workspaceRole: null,
        orgRole: null,
        staffRole: row.role,
      };
    }
    default:
      return { organizationId: null, workspaceId: null, workspaceRole: null, orgRole: null };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The view a request names (20261018000100), when it is the caller's own and for this business. */
interface NamedView {
  readonly viewId: string;
  readonly personId: string;
  readonly personEmail: string;
  readonly personName: string;
  /** Not ended, and the caller may still view as them (private.may_view_as). */
  readonly live: boolean;
}

/**
 * Asked as the caller, before anything is read: a view that isn't theirs, or is another business's, isn't one this
 * request is in, and the request is theirs as usual.
 */
async function namedView(tx: Tx, meta: RequestMeta, ref: ScopeRef): Promise<NamedView | null> {
  if (!meta.viewAs || !UUID.test(meta.viewAs) || ref.kind !== 'workspace') return null;
  const [row] = await rows<{
    workspace_id: string;
    person_id: string;
    person_email: string;
    person_name: string | null;
    live: boolean;
  }>(
    tx,
    sql`select workspace_id, person_id, person_email, person_name, live
        from private.teammate_view(${meta.viewAs}::uuid)`,
  );
  if (!row || row.workspace_id !== ref.workspaceId) return null;
  return {
    viewId: meta.viewAs,
    personId: row.person_id,
    personEmail: row.person_email,
    personName: row.person_name?.trim() || row.person_email,
    live: row.live,
  };
}

/**
 * From here on the transaction reads as the teammate: their claims, naming who is looking, so every rule answers as it
 * would for them and private.read_through_a_view() knows someone else is (their own mail stays theirs). Only ever after
 * namedView() said, as the viewer, that the view is theirs and holds.
 */
async function readAsTeammate(tx: Tx, viewer: HumanActor, view: NamedView): Promise<HumanActor> {
  const claims = { sub: view.personId, email: view.personEmail, hfos_viewer: viewer.userId };
  const payload = JSON.stringify({ role: 'authenticated', aud: 'authenticated', ...claims });
  await tx.execute(sql`select set_config('request.jwt.claims', ${payload}, true)`);
  return { type: 'human', userId: view.personId, email: view.personEmail, claims };
}

/** A view changes nothing; one that has ended says so, so the screen can go back to being the viewer's. */
function viewRefusal(view: NamedView): HfosError {
  return view.live
    ? HfosError.forbidden(
        `You’re viewing as ${view.personName}, so nothing here can be changed. Stop viewing (at the top of the screen) to work as yourself.`,
        'teammate_view_read_only',
      )
    : HfosError.forbidden(
        `Your view as ${view.personName} has ended, so this wasn’t saved. Refresh to work as yourself.`,
        'teammate_view_ended',
      );
}

/**
 * A machine actor (the system, a workflow) may only address its own tenant; anything else does not exist
 * for it.
 */
function resolveMachineScope(actor: MachineActor, ref: ScopeRef): ResolvedScope {
  switch (ref.kind) {
    // The support desk belongs to people. The worker does its support work in plain queries, not commands.
    case 'platform':
      throw HfosError.forbidden('The support desk is not open to the system.');
    case 'workspace':
      if (ref.workspaceId !== actor.workspaceId) throw businessNotThere();
      return {
        workspaceId: actor.workspaceId,
        organizationId: actor.organizationId,
        workspaceRole: null,
        orgRole: null,
      };
    case 'organization':
      if (ref.organizationId !== actor.organizationId) throw agencyNotThere();
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

/**
 * A customer acts only in the business whose portal they're signed in to, and a visitor only in the business whose
 * page they're on, each only through operations about it (scoped to its workspace); anything else does not exist for
 * them.
 */
function resolveCustomerScope(actor: CustomerActor | PublicActor, ref: ScopeRef): ResolvedScope {
  if (ref.kind !== 'workspace' || ref.workspaceId !== actor.workspaceId) throw businessNotThere();
  return {
    workspaceId: actor.workspaceId,
    organizationId: actor.organizationId,
    workspaceRole: null,
    orgRole: null,
  };
}

/** The scope a worker-run actor works in: a machine's tenant, or a customer's or a visitor's business. */
function resolveWorkerScope(actor: WorkerActor, ref: ScopeRef): ResolvedScope {
  return actor.type === 'customer' || actor.type === 'public'
    ? resolveCustomerScope(actor, ref)
    : resolveMachineScope(actor, ref);
}

const portalSignedOut = (): HfosError =>
  new HfosError(
    'unauthenticated',
    401,
    'You’ve been signed out on this device. Open the link in your email again to sign back in.',
    undefined,
    'portal_signed_out',
  );

/**
 * A customer's device must still be signed in, checked in the transaction that does the work: signed out, turned
 * off or gone idle a moment ago, and nothing runs. Under the service actor (their changes) the database is asked
 * about the session; under portal_actor (their look-ups) it works out who is asking from it.
 */
async function assertCustomerSignedIn(
  tx: Tx,
  actor: CustomerActor,
  as: 'service' | 'portal',
): Promise<void> {
  const [row] = await rows<{ person_id: string | null }>(
    tx,
    as === 'service'
      ? sql`select private.portal_session_live(${actor.sessionId}::uuid) as person_id`
      : sql`select portal.person() as person_id`,
  );
  if (!row?.person_id || row.person_id !== actor.personId) throw portalSignedOut();
}

/**
 * Whether the person in this scope may do something in the business: what the business has set for them (0106)
 * when the scope was resolved with it, else their role's defaults. Handlers ask this rather than the role.
 */
export function scopeCan(scope: ResolvedScope, permission: Permission): boolean {
  if (scope.workspacePermissions) return scope.workspacePermissions.includes(permission);
  return hasWorkspacePermission(scope.workspaceRole, permission);
}

function assertPermission(scope: ResolvedScope, permission: Permission): void {
  const ok = isStaffPermission(permission)
    ? hasStaffPermission(scope.staffRole ?? null, permission)
    : isOrgPermission(permission)
      ? hasOrgPermission(scope.orgRole, permission)
      : scopeCan(scope, permission);
  if (!ok) throw HfosError.forbidden(missingPermissionMessage(permission, scope.workspaceRole));
}

/**
 * Commands and queries are for people unless they opt in to the system, workflows or the AI teammate
 * (`actors`). The AI teammate is also held to its own allowlist (AI_EMPLOYEE_COMMANDS), whatever a
 * command's `actors` say.
 */
function assertActorAllowed(
  op: { readonly name: string; readonly actors?: readonly ActorKind[] },
  actor: Actor,
): void {
  if (
    !(op.actors ?? ['human']).includes(actor.type) ||
    (actor.type === 'ai_employee' && !aiEmployeeMayRun(op.name))
  )
    throw HfosError.forbidden(`${op.name} cannot be run by a ${actor.type} actor.`);
}

/**
 * The test console's AI teammate only looks things up: the kernel refuses it every command, whatever the
 * caller does (defence in depth; the console simulates its actions instead).
 */
function assertNotTestRun(actor: Actor): void {
  if (actor.type === 'ai_employee' && actor.test)
    throw HfosError.forbidden(
      'The AI teammate’s test console never changes anything.',
      'test_run_read_only',
    );
}

/**
 * The add-on an operation's work is for (0108): its own, else that of the add-on command it runs inside, else that of
 * the job or event delivery the system is running for an add-on. Core's operations run by core are for none.
 */
function addonOf(
  op: { readonly addon?: AddonRef },
  actor: Actor,
  within: AddonRef | null = null,
): AddonRef | null {
  return op.addon ?? within ?? (actor.type === 'system' ? (actor.addon ?? null) : null);
}

/**
 * The add-on check (0108), for every kind of actor: work for an add-on runs only while that add-on is on in the
 * business (enabled, and not switched off by HandsFreeOS). A command also holds the add-on's installation row with a
 * key-share lock until its transaction ends, so a disable (which takes the row for update) waits for the commands
 * already running and nothing starts after it. Core's own operations never pay for it: no add-on, no query.
 */
async function assertAddonRuns(
  tx: Tx,
  addon: AddonRef | null,
  workspaceId: string | null,
  lock: boolean,
): Promise<void> {
  if (!addon) return;
  if (workspaceId) {
    const [row] = await rows<{ ok: boolean }>(
      tx,
      sql`select private.addon_in_use(${workspaceId}::uuid, ${addon.id}, ${lock}) as ok`,
    );
    if (row?.ok) return;
  }
  throw HfosError.addonInactive(addon);
}

function actorRoleLabel(scope: ResolvedScope): string | null {
  if (scope.staffRole) return `staff_${scope.staffRole}`;
  return scope.workspaceRole ?? (scope.orgRole ? `org_${scope.orgRole}` : null);
}

interface RecordedActor {
  readonly actorType: Exclude<ActorKind, 'public'>;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  /** What the kernel adds to every event payload for this actor. */
  readonly payload: Record<string, unknown>;
}

/**
 * How an actor appears on its event and audit rows. A workflow is recorded as itself (actor_id is the
 * workflow), and its events name the run that caused them (`_workflow`), which the engine's loop guards read.
 * The AI teammate is recorded as itself too (actor_id is the teammate), its events name its run and whose
 * OK sent them (`_ai`), and, when a workflow handed it the conversation, that run's loop guard (`_workflow`).
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
        payload: {
          ...(actor.onBehalfOf ? { onBehalfOf: actor.onBehalfOf } : {}),
          // The Action Center acting on its own: which item the work was for.
          ...(actor.via
            ? { _attention: { itemId: actor.via.itemId, itemKind: actor.via.itemKind } }
            : {}),
          // The AI keeping tags and details up to date: what brought it on, and the pass (0107).
          ...(actor.contactAi
            ? {
                _contactAi: {
                  trigger: actor.contactAi.trigger,
                  sweepId: actor.contactAi.sweepId,
                },
              }
            : {}),
        },
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
    case 'ai_employee':
      return {
        actorType: 'ai_employee',
        actorId: actor.teammateId,
        actorRole: 'ai_employee',
        payload: {
          _ai: { teammateId: actor.teammateId, runId: actor.runId, approvedBy: actor.approvedBy },
          ...(actor.origin
            ? {
                _workflow: {
                  runId: actor.origin.runId,
                  workflowId: actor.origin.workflowId,
                  depth: actor.origin.depth,
                  originRunId: actor.origin.originRunId,
                },
              }
            : {}),
        },
      };
    // The customer in their portal: actor_id is the person; the device is on the event.
    case 'customer':
      return {
        actorType: 'customer',
        actorId: actor.personId,
        actorRole: 'customer',
        payload: { _portal: { personId: actor.personId, sessionId: actor.sessionId } },
      };
    // A visitor to a public page is nobody we know: the system, as a form's answers are, with the page they used.
    case 'public':
      return {
        actorType: 'system',
        actorId: null,
        actorRole: 'public',
        payload: { _public: { site: actor.site, visitor: actor.visitor } },
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
  addon: AddonRef | null,
): Promise<string> {
  const eventId = randomUUID();
  const organizationId = e.organizationId !== undefined ? e.organizationId : scope.organizationId;
  const workspaceId = e.workspaceId !== undefined ? e.workspaceId : scope.workspaceId;
  const entityId = e.entityId ?? null;
  const who = recordedActor(actor, scope);
  const payload = redact({
    ...(e.payload ?? {}),
    ...who.payload,
    // Which add-on did it, with its name and version then, so the line still reads once the add-on is gone (0108).
    ...(addon ? { _addon: { id: addon.id, name: addon.name, version: addon.version } } : {}),
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
    addonId: addon?.id ?? null,
    // When the person really did it (a change from the phone, corrected for its clock); otherwise now.
    ...(meta.occurredAt ? { occurredAt: meta.occurredAt } : {}),
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
    addonId: addon?.id ?? null,
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
  addon: AddonRef | null = null,
): Promise<ExecuteResult<z.output<O>>> {
  const eventIds: string[] = [];
  const emit = async (e: EmitInput): Promise<string> => {
    if (!cmd.emits.includes(e.type))
      throw new Error(`${cmd.name} emitted undeclared event ${e.type}`);
    const id = await recordEvent(tx, cmd.name, actor, scope, meta, e, addon);
    eventIds.push(id);
    return id;
  };
  const result = await cmd.handler(
    { tx, actor, scope, meta, commandName: cmd.name, emit, addon },
    input,
  );
  return { output: cmd.output.parse(result) as z.output<O>, eventIds };
}

/**
 * The pipeline every actor shares: validate → one transaction, as the user (RLS on) or, for the system and
 * workflows, as the service actor bound to their workspace → resolve scope → permission (people only) →
 * handler → event + outbox + audit rows in the same transaction → validated output.
 *
 * A person's command from the phone also carries its own id and the moment it was done (M10). Once the person is
 * known to work in the business, its receipt is claimed as the transaction's first write: a repeat gets the first
 * answer (or final refusal) back without running again, before any other check. Then the moment rules (a stale
 * customer-facing change waits for "Still send?"; an online-only one that waited is refused), then the command, with
 * the database told the change's moment for the times it stamps itself, and its answer is stored before the
 * transaction ends. A final refusal is stored afterwards on its own. The input is
 * validated first, as the API's route already did: the receipt names the business the input is for.
 */
export async function executeCommand<I extends z.ZodType, O extends z.ZodType>(
  db: Db,
  cmd: CommandDef<I, O>,
  rawInput: unknown,
  actor: Actor,
  meta: RequestMeta,
): Promise<ExecuteResult<z.output<O>>> {
  assertActorAllowed(cmd, actor);
  assertNotTestRun(actor);
  assertAppRequest(meta);
  const input = parseInput(cmd.input, rawInput);
  const scopeRef = cmd.scope(input);
  if (isMachine(actor)) {
    try {
      // Root within its tenant (no permission check), bound by the service_actor policies.
      const scope = resolveMachineScope(actor, scopeRef);
      const addon = addonOf(cmd, actor);
      return await asWorker(
        db,
        { workspaceId: actor.workspaceId, organizationId: actor.organizationId },
        async (tx) => {
          assertOnTime(cmd, meta, new Date());
          // No permission check for the system, a workflow or the AI teammate, but never an add-on that is off.
          await assertAddonRuns(tx, addon, scope.workspaceId, true);
          await shareChangeMoment(tx, meta);
          return runCommand(tx, cmd, input, actor, scope, meta, addon);
        },
      );
    } catch (e) {
      throw translateDbError(e);
    }
  }
  if (actor.type === 'customer') {
    try {
      // The service actor in their business, as booking, invoices and chat run a customer's changes: the command's
      // own handler keeps them to what is theirs. They have no permissions to check, only a session.
      const scope = resolveCustomerScope(actor, scopeRef);
      return await asWorker(
        db,
        { workspaceId: actor.workspaceId, organizationId: actor.organizationId },
        async (tx) => {
          await assertCustomerSignedIn(tx, actor, 'service');
          await assertAddonRuns(tx, cmd.addon ?? null, scope.workspaceId, true);
          return runCommand(tx, cmd, input, actor, scope, meta, cmd.addon ?? null);
        },
      );
    } catch (e) {
      throw translateDbError(e);
    }
  }
  if (actor.type === 'public') {
    try {
      // The service actor in the business whose page it is, as forms and booking pages run: the command's own
      // handler keeps a visitor to what the business has published.
      const scope = resolveCustomerScope(actor, scopeRef);
      return await asWorker(
        db,
        { workspaceId: actor.workspaceId, organizationId: actor.organizationId },
        async (tx) => {
          await assertAddonRuns(tx, cmd.addon ?? null, scope.workspaceId, true);
          return runCommand(tx, cmd, input, actor, scope, meta, cmd.addon ?? null);
        },
      );
    } catch (e) {
      throw translateDbError(e);
    }
  }
  const claim = receiptClaim(cmd, rawInput, actor, meta);
  // The business the receipt names: set once the person is found to work in it.
  let receiptWorkspace: string | null = null;
  let replayed: HfosError | null = null;
  try {
    const outcome = await asUser(db, actor.claims, async (tx) => {
      // Viewing as a teammate is for seeing only (20261018000100): nothing in that business is changed through it.
      const view = await namedView(tx, meta, scopeRef);
      if (view) throw viewRefusal(view);
      const scope = await resolveScope(tx, scopeRef);
      // Looking at a business never changes it. The role behind a look is null, so nothing would have
      // passed a permission check anyway; this says so plainly, and covers the commands that ask for none.
      if (scope.viewAs)
        throw HfosError.forbidden(
          'You are looking at this business, not working in it. Nothing here can be changed.',
          'view_as_read_only',
        );
      let receiptId: string | null = null;
      if (claim) {
        receiptWorkspace = scope.workspaceId;
        const claimed = await claimReceipt<z.output<O>>(tx, cmd, claim, scope.workspaceId);
        if (claimed.kind === 'answered') return claimed.result;
        if (claimed.kind === 'refused') return claimed.error;
        receiptId = claimed.receiptId;
      }
      assertOnTime(cmd, meta, new Date());
      // Before the permission: an add-on that is off has no permissions for anyone, and saying it's off is the
      // honest answer. After the receipt claim, so a phone's repeat of a refused command gets the same refusal.
      await assertAddonRuns(tx, cmd.addon ?? null, scope.workspaceId, true);
      if (cmd.permission) assertPermission(scope, cmd.permission);
      await shareChangeMoment(tx, meta);
      const result = await runCommand(tx, cmd, input, actor, scope, meta, cmd.addon ?? null);
      if (receiptId) await storeAnswer(tx, cmd, receiptId, result);
      return result;
    });
    if (outcome instanceof HfosError) {
      replayed = outcome;
      throw outcome;
    }
    return outcome;
  } catch (e) {
    const error = translateDbError(e);
    if (claim && error !== replayed && error instanceof HfosError && error.disposition === 'final')
      await recordRefusal(db, actor, claim, receiptWorkspace, error);
    throw error;
  }
}

/** executeCommandIn's caller must hold exactly the actor's tenant, as the service actor, and nothing more. */
async function assertWorkerTx(tx: Tx, actor: WorkerActor): Promise<void> {
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
 * Runs a command for the system, a workflow or the AI teammate inside a transaction the caller already opened
 * with `asWorker` for the actor's workspace, so the command's writes, events, outbox and audit rows commit with
 * the caller's own: a workflow step and the action it takes are one unit, and roll back together (as are an
 * approved draft's bookings and its message). The command runs in a savepoint, so a refusal or a database
 * error undoes only the command's writes and leaves the caller's transaction usable (to record the failure).
 * Otherwise the same rules as executeCommand: allowed actors, validation, no permission check, declared events
 * only. People always use executeCommand.
 */
export async function executeCommandIn<I extends z.ZodType, O extends z.ZodType>(
  tx: Tx,
  cmd: CommandDef<I, O>,
  rawInput: unknown,
  actor: MachineActor,
  meta: RequestMeta,
): Promise<ExecuteResult<z.output<O>>> {
  return runMachineCommandIn(tx, cmd, rawInput, actor, meta, null);
}

/**
 * executeCommandIn, for a command run inside another: `within` is the add-on the outer work was for. A customer's
 * command runs its inner ones here too, as the customer: each must list 'customer' itself.
 */
async function runMachineCommandIn<I extends z.ZodType, O extends z.ZodType>(
  tx: Tx,
  cmd: CommandDef<I, O>,
  rawInput: unknown,
  actor: WorkerActor,
  meta: RequestMeta,
  within: AddonRef | null,
): Promise<ExecuteResult<z.output<O>>> {
  if ((actor as Actor).type === 'human')
    throw HfosError.forbidden(
      'Only the system, workflows and the AI teammate run commands in their own transaction.',
    );
  assertActorAllowed(cmd, actor);
  assertNotTestRun(actor);
  const input = parseInput(cmd.input, rawInput);
  const scope = resolveWorkerScope(actor, cmd.scope(input));
  await assertWorkerTx(tx, actor);
  const addon = addonOf(cmd, actor, within);
  try {
    return await tx.transaction(async (savepoint) => {
      // The outer work's add-on was checked when it started; this command's own, and a job's, are checked here.
      await assertAddonRuns(
        savepoint,
        cmd.addon ?? (within ? null : addon),
        scope.workspaceId,
        true,
      );
      return runCommand(savepoint, cmd, input, actor, scope, meta, addon);
    });
  } catch (e) {
    throw translateDbError(e);
  }
}

/**
 * Runs another command from inside a command's handler, as the same actor and in the same transaction: the
 * Action Center's Assign and Let HandsFreeOS Handle carry out lead.update, conversation.assign, task.update,
 * message.send, conversation.hand_to_ai or lead.set_next_action as the person who asked. The inner command keeps
 * all its own rules (who may run it, its input, its permission for people, its declared events) and records its
 * own name on its events and audit rows. It runs in a savepoint, so a refusal undoes only its writes. A machine
 * actor goes through executeCommandIn; a person's inner command must be for the workspace they're already in,
 * and is checked against the role this transaction resolved.
 */
export async function executeCommandWithin<I extends z.ZodType, O extends z.ZodType>(
  ctx: CommandContext,
  cmd: CommandDef<I, O>,
  rawInput: unknown,
): Promise<ExecuteResult<z.output<O>>> {
  if (isMachine(ctx.actor) || ctx.actor.type === 'customer' || ctx.actor.type === 'public')
    return runMachineCommandIn(ctx.tx, cmd, rawInput, ctx.actor, ctx.meta, ctx.addon ?? null);
  assertActorAllowed(cmd, ctx.actor);
  const input = parseInput(cmd.input, rawInput);
  const ref = cmd.scope(input);
  if (ref.kind !== 'workspace' || ref.workspaceId !== ctx.scope.workspaceId)
    throw businessNotThere();
  const actor = ctx.actor;
  const addon = addonOf(cmd, actor, ctx.addon ?? null);
  try {
    return await ctx.tx.transaction(async (savepoint) => {
      await assertAddonRuns(savepoint, cmd.addon ?? null, ctx.scope.workspaceId, true);
      if (cmd.permission) assertPermission(ctx.scope, cmd.permission);
      return runCommand(savepoint, cmd, input, actor, ctx.scope, ctx.meta, addon);
    });
  } catch (e) {
    throw translateDbError(e);
  }
}

/**
 * The Assistant is the one look-up a staff member viewing a business does not get: it is the door to
 * doing things, and view-as is for seeing only. Nor does anyone viewing as a teammate: their chats are their own.
 */
const VIEW_AS_BLOCKED: ReadonlySet<string> = new Set(['assistant.use']);

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
  const run = async (tx: Tx, scope: ResolvedScope, asWho: Actor = actor): Promise<z.output<O>> => {
    const result = await query.handler({ tx, actor: asWho, scope, meta }, input);
    return query.output.parse(result) as z.output<O>;
  };
  try {
    if (isMachine(actor)) {
      // Root within its tenant (no permission check), bound by the service_actor policies.
      const scope = resolveMachineScope(actor, scopeRef);
      return await asWorker(
        db,
        { workspaceId: actor.workspaceId, organizationId: actor.organizationId },
        async (tx) => {
          await assertAddonRuns(tx, addonOf(query, actor), scope.workspaceId, false);
          return run(tx, scope);
        },
      );
    }
    if (actor.type === 'customer') {
      // Under row security as portal_actor: only what's theirs, and only while the device is signed in.
      const scope = resolveCustomerScope(actor, scopeRef);
      return await asCustomer(db, actor.sessionId, async (tx) => {
        await assertCustomerSignedIn(tx, actor, 'portal');
        if (query.addon) {
          // The portal role reaches only its own schema, so it asks there.
          const [on] = await rows<{ ok: boolean }>(
            tx,
            sql`select portal.addon_in_use(${query.addon.id}) as ok`,
          );
          if (!on?.ok) throw HfosError.addonInactive(query.addon);
        }
        return run(tx, scope);
      });
    }
    if (actor.type === 'public') {
      // As the service actor in the page's business; the query's own handler shows only what is published.
      const scope = resolveCustomerScope(actor, scopeRef);
      return await asWorker(
        db,
        { workspaceId: actor.workspaceId, organizationId: actor.organizationId },
        async (tx) => {
          await assertAddonRuns(tx, query.addon ?? null, scope.workspaceId, false);
          return run(tx, scope);
        },
      );
    }
    return await asUser(db, actor.claims, async (tx) => {
      // Through a view that holds, the look-up is the teammate's from here on: their scope, their rules. One that
      // has ended reads as the viewer again, and the screen finds out from teammate_view.current.
      const view = await namedView(tx, meta, scopeRef);
      const reader = view?.live ? await readAsTeammate(tx, actor, view) : actor;
      const resolved = await resolveScope(tx, scopeRef);
      const scope: ResolvedScope = view?.live
        ? { ...resolved, teammateView: { viewId: view.viewId, viewerId: actor.userId } }
        : resolved;
      // A turned-off add-on's data is hidden until it's back on (the owner's decision, 2026-09-28), from people
      // working in the business and from anyone looking at it.
      await assertAddonRuns(tx, query.addon ?? null, scope.workspaceId, false);
      if (scope.viewAs) {
        // Looking at a business, not working in it: no role to check a permission against, so the read
        // rules are the whole answer — except the Assistant, which is never part of looking.
        if (query.permission && VIEW_AS_BLOCKED.has(query.permission)) throw businessNotThere();
      } else if (query.permission) {
        if (scope.teammateView && VIEW_AS_BLOCKED.has(query.permission)) throw businessNotThere();
        assertPermission(scope, query.permission);
      }
      return run(tx, scope, reader);
    });
  } catch (e) {
    throw translateDbError(e);
  }
}
