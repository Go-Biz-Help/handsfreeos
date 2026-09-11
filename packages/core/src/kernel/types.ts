import type { Tx, UserClaims } from '@hfos/db/client';
import type { z } from 'zod';
import type { OrgRole, Permission, WorkspaceRole } from '../permissions';

/** Blueprint action levels: 0 read, 1 safe, 2 external, 3 sensitive, 4 admin. Used by the assistant in M4. */
export type RiskLevel = 0 | 1 | 2 | 3 | 4;
export type Channel = 'web' | 'api' | 'worker' | 'cli' | 'sms' | 'assistant' | 'test';

export interface HumanActor {
  readonly type: 'human';
  readonly userId: string;
  readonly email: string;
  readonly claims: UserClaims;
}
export type Actor = HumanActor;

export interface RequestMeta {
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly channel: Channel;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly reason?: string | null;
}

export type ScopeRef =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'organization'; readonly organizationId: string }
  | { readonly kind: 'account' }
  | { readonly kind: 'none' };

export interface ResolvedScope {
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly workspaceRole: WorkspaceRole | null;
  readonly orgRole: OrgRole | null;
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
}

export interface QueryContext {
  readonly tx: Tx;
  readonly actor: Actor;
  readonly scope: ResolvedScope;
  readonly meta: RequestMeta;
}

export interface CommandContext extends QueryContext {
  readonly commandName: string;
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
  readonly handler: (ctx: QueryContext, input: z.output<I>) => Promise<z.input<O>>;
}

export type Operation = CommandDef | QueryDef;
