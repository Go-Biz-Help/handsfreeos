import type { Tx, UserClaims } from '@hfos/db/client';
import type { z } from 'zod';
import type { OfflineClass } from '../mobile';
import type { OrgRole, Permission, StaffRole, WorkspaceRole } from '../permissions';
import type { requestChannel } from '../schemas/audit';

export type { OfflineClass } from '../mobile';

/** Blueprint action levels: 0 read, 1 safe, 2 external, 3 sensitive, 4 admin. Used by the assistant in M4. */
export type RiskLevel = 0 | 1 | 2 | 3 | 4;
/**
 * 'web' | 'api' | 'worker' | 'cli' | 'sms' | 'assistant' | 'booking_page' | 'workflow' | 'ai_employee' |
 * 'chat_widget' | 'mobile' | 'contact_ai' | 'portal' | 'test' (one list, shared with the audit filter).
 */
export type Channel = z.infer<typeof requestChannel>;

export interface HumanActor {
  readonly type: 'human';
  readonly userId: string;
  readonly email: string;
  readonly claims: UserClaims;
}
/**
 * What part of HandsFreeOS is acting when the system works on its own (M8): the Action Center sending a
 * confirmation request or a follow-up nudge for one attention item. Recorded as `payload._attention` on every
 * event and `meta.actionCenter` on timeline entries, so the work reads as "HandsFreeOS" with the item it was for.
 */
export interface ActionCenterVia {
  readonly kind: 'action_center';
  readonly itemId: string;
  /** The item's kind (core's AttentionKind). */
  readonly itemKind: string;
}
/**
 * The AI keeping a customer's tags and details up to date (0107): after something happened with them
 * (`activity`), or on a pass over the whole list (`sweep`). Recorded as `payload._contactAi` on every event, beside
 * channel `contact_ai` and the AI's reason on the audit row, so the log reads "HandsFreeOS AI" with its why.
 */
export interface ContactAiVia {
  readonly trigger: 'activity' | 'sweep';
  /** The pass, on a sweep. */
  readonly sweepId: string | null;
}
/**
 * The add-on an operation belongs to, or that work is done for (0108), as its manifest names it. The kernel refuses
 * the operation, for every kind of actor, while the add-on isn't on in the business, and stamps it on every event and
 * audit row the work causes, so history says which add-on did what even after it is gone.
 */
export interface AddonRef {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

/**
 * How an operation may be offered to the AI as a tool (0108). Only add-on operations carry it today; the Assistant
 * derives the tool from the operation itself (its input schema, permission and risk), so an add-on never writes
 * separate glue for the AI.
 */
export interface OperationAi {
  /** The name the model sees: `<addon>_<verb>_<noun>`, letters, digits and underscores. */
  readonly tool: string;
  /** What the model reads to decide when to use it. Defaults to the operation's description. */
  readonly description?: string;
  /**
   * Stricter than the operation's risk allows, never looser: risk 0–1 may run on their own, 2–3 wait for the
   * person's OK, 4 is never offered (packages/core/src/addons/ai.ts).
   */
  readonly autonomy?: 'auto' | 'confirm' | 'never';
  /** Extra words tool search should match on. */
  readonly keywords?: readonly string[];
}

/**
 * A non-human actor (the worker today; the assistant and AI employees later). Runs inside the worker's
 * tenant scope with the `service_actor` policies, so it is root within one workspace and nothing outside it.
 */
export interface SystemActor {
  readonly type: 'system';
  readonly workspaceId: string;
  readonly organizationId: string;
  /** The person whose request this work fulfils (for example the importer). Recorded, never impersonated. */
  readonly onBehalfOf?: string | null;
  /** The part of HandsFreeOS doing it (the Action Center), when it acts on its own. */
  readonly via?: ActionCenterVia | null;
  /** The AI keeping customers' tags and details up to date, when it's the one acting. */
  readonly contactAi?: ContactAiVia | null;
  /**
   * The add-on this work is for (0108): its jobs and event deliveries run as the system on its behalf. Refused, like
   * the add-on's own operations, while it isn't on, and stamped on everything the work does.
   */
  readonly addon?: AddonRef | null;
}
/**
 * A workflow step (M6). Runs exactly like the system (no permission check, `service_actor` bound to its
 * workspace) but is recorded as itself: actor_type 'workflow' with actor_id the workflow, channel 'workflow',
 * the run on every event (`payload._workflow`) and on timeline entries (`meta.workflow`). That keeps a
 * workflow's work apart from other system work, for the loop guards and for "Workflow: Speed to lead".
 */
export interface WorkflowActor {
  readonly type: 'workflow';
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly workflowId: string;
  /** The published version the run is on; null for a test run of the draft. */
  readonly versionId: string | null;
  readonly runId: string;
  /** The step being run (`stepId#visit`). */
  readonly stepKey: string;
  /** How deep in a chain of workflows this run is (a run started by another run's event is one deeper). */
  readonly depth: number;
  /** The first run of that chain; null when this run is the first. */
  readonly originRunId: string | null;
  readonly workflowName: string;
  /** A test run (Simulate or Send to me). */
  readonly test: boolean;
}
/** The workflow run that handed the conversation to the teammate: its loop guard, carried on the AI's events. */
export interface AiEmployeeOrigin {
  readonly runId: string;
  readonly workflowId: string;
  readonly depth: number;
  readonly originRunId: string | null;
}
/**
 * The business's AI teammate (M7), serving one customer. Runs like the system (no permission check,
 * `service_actor` bound to its workspace) but is recorded as itself: actor_type 'ai_employee' with actor_id
 * the teammate, `payload._ai` on every event, and `meta.aiTeammate` on timeline entries ("Ava (AI)"). It may
 * run only the commands in AI_EMPLOYEE_COMMANDS, and those commands keep it to its own conversation.
 */
export interface AiEmployeeActor {
  readonly type: 'ai_employee';
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly teammateId: string;
  /** The name customers see ("Ava"). */
  readonly teammateName: string;
  /** The run doing the work; null only when it was pruned before an approved draft went out. */
  readonly runId: string | null;
  /** The conversation it's answering; null for a first message to a new lead (sending it starts one). */
  readonly conversationId: string | null;
  /** The person whose OK sends this (an approved draft); null when it acts on its own. */
  readonly approvedBy: string | null;
  /** Set when a workflow step handed it the conversation, so the workflow loop guards still apply. */
  readonly origin: AiEmployeeOrigin | null;
  /** The test console: look-ups are real, and it never calls a command that changes anything. */
  readonly test: boolean;
}
/** Work nobody signed in for: root within one workspace and never a permission check (see `isMachine`). */
export type MachineActor = SystemActor | WorkflowActor | AiEmployeeActor;
/**
 * A customer signed in to their portal (Real Estate round two, core), on one device. They may run only the
 * operations that list 'customer' (named `portal.*`, or `<addon>.portal.*`), and nothing else, whatever they send.
 * Their look-ups read under row security as `portal_actor`: only themselves, and the records they're on through a
 * portal-visible relationship. Their changes run as the service actor in their business, which the operation's own
 * handler keeps to what is theirs, recorded as actor_type 'customer' with actor_id the person, on channel 'portal'.
 * Either way the database checks the device is still signed in, in the same transaction.
 */
export interface CustomerActor {
  readonly type: 'customer';
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly personId: string;
  /** The signed-in device (app.portal_sessions). */
  readonly sessionId: string;
}
/** Who runs in the worker's own transaction: machines, and a customer's changes. */
export type WorkerActor = MachineActor | CustomerActor;
export type Actor = HumanActor | MachineActor | CustomerActor;
export type ActorKind = Actor['type'];

export interface RequestMeta {
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly channel: Channel;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly reason?: string | null;
  /**
   * The app's own id for this command (M10): the phone makes it when the person acts, and a repeat of it gets
   * the first answer back. Every command from the app has one; the web's have none.
   */
  readonly commandId?: string | null;
  /**
   * When the person really did it, already on the server's clock (`onServerClock`: corrected for the phone's own
   * clock, never later than now). Every command from the app has one; for everything else it is now.
   */
  readonly occurredAt?: Date | null;
  /** When the app sent the request, by the phone's own clock, as it said. */
  readonly sentAt?: Date | null;
  /** When the person answered "Still send?" yes, on the server's clock like `occurredAt`. */
  readonly confirmedAt?: Date | null;
  /** The app build that sent it. */
  readonly appVersion?: string | null;
}

export type ScopeRef =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'organization'; readonly organizationId: string }
  /** The support desk and the admin side (M13): checked against a staff role, not against any business. */
  | { readonly kind: 'platform' }
  | { readonly kind: 'account' }
  | { readonly kind: 'none' };

export interface ResolvedScope {
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly workspaceRole: WorkspaceRole | null;
  /**
   * What this person may do in the business (0106): their role's permissions with the business's settings for the
   * role and for them applied, as app.workspace_access stores them. Null outside a business, and for the system.
   */
  readonly workspacePermissions?: readonly string[] | null;
  readonly orgRole: OrgRole | null;
  /** Set when the person is HandsFreeOS support staff (M13); null for everyone else. */
  readonly staffRole?: StaffRole | null;
  /**
   * Set when a staff member is looking at a business they have no standing in, under an open view-as
   * session. Look-ups only: a command never runs in one, and nothing here can write.
   */
  readonly viewAs?: { readonly sessionId: string } | null;
}

export interface EmitInput {
  readonly type: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  /** Override the scope's ids (bootstrap paths where the scope is not known up front). */
  readonly organizationId?: string | null;
  readonly workspaceId?: string | null;
  /** false keeps the event out of the live-updates broadcast (bulk work emits one progress event instead). */
  readonly broadcast?: boolean;
}

export interface QueryContext {
  readonly tx: Tx;
  readonly actor: Actor;
  readonly scope: ResolvedScope;
  readonly meta: RequestMeta;
}

export interface CommandContext extends QueryContext {
  readonly commandName: string;
  /**
   * The add-on this command's work is for, if any (0108): its own, or that of the add-on command or job it runs
   * inside. Commands it runs within carry it on, so what an add-on causes in core is attributed to it.
   */
  readonly addon?: AddonRef | null;
  /** Writes the event, outbox and audit rows now, in this transaction. Resolves to the event id. */
  emit(event: EmitInput): Promise<string>;
}

export type CommandName = `${string}.${string}`;

export interface CommandDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly kind: 'command';
  readonly name: CommandName;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly input: I;
  readonly output: O;
  readonly permission: Permission | null;
  readonly scope: (input: z.output<I>) => ScopeRef;
  readonly emits: readonly string[];
  /**
   * Who may run this command. Defaults to humans only; the worker's paths (imports, bookings) opt in to the
   * system actor, and the actions workflow steps take opt in to 'workflow'.
   */
  readonly actors?: readonly ActorKind[];
  /**
   * How long it may wait on a phone with no signal (see OfflineClass). `defineCommand` makes it `online` unless
   * the definition says otherwise, so nothing is queued by accident.
   */
  readonly offline: OfflineClass;
  /**
   * Output keys a person is shown once and that are never kept (a one-time OAuth state): a command's stored
   * answer (command receipts, which reach the person's phone) leaves them out, as it does anything that looks
   * like a credential.
   */
  readonly shownOnce?: readonly string[];
  /** The add-on it belongs to (0108), set by defineAddonCommand. Absent for core's own. */
  readonly addon?: AddonRef;
  /** How it may be offered to the AI (0108). */
  readonly ai?: OperationAi;
  readonly handler: (ctx: CommandContext, input: z.output<I>) => Promise<z.input<O>>;
}

export interface QueryDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly kind: 'query';
  readonly name: CommandName;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly permission: Permission | null;
  readonly scope: (input: z.output<I>) => ScopeRef;
  /**
   * Who may run this query. Defaults to humans only; the worker's signed-out booking routes opt in to the
   * system actor (availability), which reads as root within its tenant, like a system command.
   */
  readonly actors?: readonly ActorKind[];
  /** The add-on it belongs to (0108), set by defineAddonQuery. Absent for core's own. */
  readonly addon?: AddonRef;
  /** How it may be offered to the AI (0108). */
  readonly ai?: OperationAi;
  readonly handler: (ctx: QueryContext, input: z.output<I>) => Promise<z.input<O>>;
}

export type Operation = CommandDef | QueryDef;
