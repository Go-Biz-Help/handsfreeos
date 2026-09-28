/**
 * Add-ons, server side: defining an add-on's commands and queries, and composing them with core's into the one
 * registry the API mounts routes from and the worker and the AI look operations up in (docs/addon-architecture.md).
 *
 * An add-on's operations are ordinary commands and queries. `defineAddonCommand` only stamps the add-on on them,
 * which is what makes the kernel refuse them, for every kind of actor, while the add-on isn't on in the business,
 * and attribute everything they cause to it. So the UI, workflows, the Assistant, the AI teammate and other add-ons
 * all reach an add-on's business logic the one way they reach core's: through the kernel.
 */
import type { z } from 'zod';
import { defineCommand, defineQuery } from '../kernel/define';
import type { AddonRef, CommandDef, OfflineClass, QueryDef } from '../kernel/types';
import { ROLE_PERMISSIONS, type Permission } from '../permissions';
import type { AddonManifest } from './manifest';

/**
 * The permission an add-on's operation asks for: one of its own (`pm.leases.write`, declared in its manifest), or
 * one of core's. The kernel checks either the same way, against what the person may do here now.
 */
export type OperationPermission = Permission | `${string}.${string}`;

type AddonCommandInput<I extends z.ZodType, O extends z.ZodType> = Omit<
  CommandDef<I, O>,
  'kind' | 'offline' | 'addon' | 'permission'
> & { readonly offline?: OfflineClass; readonly permission: OperationPermission | null };

type AddonQueryInput<I extends z.ZodType, O extends z.ZodType> = Omit<
  QueryDef<I, O>,
  'kind' | 'addon' | 'permission'
> & { readonly permission: OperationPermission | null };

/** How the kernel and history name an add-on. */
export const addonRef = (m: AddonManifest): AddonRef => ({
  id: m.id,
  name: m.name,
  version: m.version,
});

/** A tool name the model sees: letters, digits and underscores, starting with the add-on's id. */
export const AI_TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

/** One of an add-on's commands. Its name must start with the add-on's id (`pm.lease.create`). */
export function defineAddonCommand<I extends z.ZodType, O extends z.ZodType>(
  manifest: AddonManifest,
  def: AddonCommandInput<I, O>,
): CommandDef<I, O> {
  if (!def.name.startsWith(`${manifest.id}.`))
    throw new Error(`${def.name} must start with "${manifest.id}."`);
  return defineCommand({
    ...def,
    permission: def.permission as Permission | null,
    addon: addonRef(manifest),
  });
}

/** One of an add-on's queries. Its name must start with the add-on's id (`pm.lease.list`). */
export function defineAddonQuery<I extends z.ZodType, O extends z.ZodType>(
  manifest: AddonManifest,
  def: AddonQueryInput<I, O>,
): QueryDef<I, O> {
  if (!def.name.startsWith(`${manifest.id}.`))
    throw new Error(`${def.name} must start with "${manifest.id}."`);
  return defineQuery({
    ...def,
    permission: def.permission as Permission | null,
    addon: addonRef(manifest),
  });
}

/** An add-on's server half: its manifest, and the operations that are its business logic. */
export interface AddonServerModule {
  readonly manifest: AddonManifest;
  readonly commands?: readonly CommandDef[];
  readonly queries?: readonly QueryDef[];
}

/**
 * Everything wrong with how a set of add-on modules would join core's operations: an operation that doesn't carry
 * its own add-on, a name outside its add-on's id, an AI tool name that isn't the add-on's, a name core already uses.
 */
export function addonModuleIssues(
  core: { readonly commands: readonly CommandDef[]; readonly queries: readonly QueryDef[] },
  modules: readonly AddonServerModule[],
): string[] {
  const issues: string[] = [];
  const taken = new Set([...core.commands, ...core.queries].map((op) => op.name));
  const tools = new Set<string>();
  const corePermissions = new Set<string>(ROLE_PERMISSIONS.owner);
  for (const { manifest: m, commands = [], queries = [] } of modules) {
    const own = new Set(m.permissions.map((p) => p.key));
    for (const op of [...commands, ...queries]) {
      if (op.addon?.id !== m.id) issues.push(`${op.name} isn't stamped with "${m.id}"`);
      if (!op.name.startsWith(`${m.id}.`)) issues.push(`${op.name} must start with "${m.id}."`);
      if (op.permission && !own.has(op.permission) && !corePermissions.has(op.permission))
        issues.push(`${op.name} asks for "${op.permission}", which neither it nor core declares`);
      if (taken.has(op.name)) issues.push(`${op.name} is already an operation`);
      taken.add(op.name);
      if (op.ai) {
        if (!AI_TOOL_NAME.test(op.ai.tool) || !op.ai.tool.startsWith(`${m.id}_`))
          issues.push(`${op.name}'s AI tool "${op.ai.tool}" must be "${m.id}_…" in lowercase`);
        if (tools.has(op.ai.tool)) issues.push(`AI tool "${op.ai.tool}" is declared twice`);
        tools.add(op.ai.tool);
      }
    }
  }
  return issues;
}

/**
 * Core's operations and every add-on's, as one list each. Explicit and ordered (core first, then add-ons in the
 * catalogue's order), and refused outright if any add-on's operations break a rule above.
 */
export function composeOperations(
  core: { readonly commands: readonly CommandDef[]; readonly queries: readonly QueryDef[] },
  modules: readonly AddonServerModule[],
): { readonly commands: readonly CommandDef[]; readonly queries: readonly QueryDef[] } {
  const issues = addonModuleIssues(core, modules);
  if (issues.length > 0)
    throw new Error(`Add-on operations can't be registered:\n${issues.join('\n')}`);
  return {
    commands: [...core.commands, ...modules.flatMap((m) => m.commands ?? [])],
    queries: [...core.queries, ...modules.flatMap((m) => m.queries ?? [])],
  };
}
