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
import type { AppPlace } from '../assistant/places-map';
import { logSystemActivity } from '../crm/activities';
import type { AddonLineTone } from '../crm/timeline-words';
import { defineCommand, defineQuery } from '../kernel/define';
import type { AddonRef, CommandContext, CommandDef, OfflineClass, QueryDef } from '../kernel/types';
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

/**
 * The shapes of an add-on's settings, checked on every save: the business's (`app.addon_installations.settings`) and
 * each person's own (`app.addon_user_settings`).
 */
export interface AddonSettingsShapes {
  readonly workspace?: z.ZodType;
  readonly user?: z.ZodType;
}

/**
 * An add-on's server half: its manifest, the operations that are its business logic, and what of the add-on only a
 * server reads. The manifest is in every signed-in page (the catalogue), so anything written from the add-on's own
 * words or rules goes here and not there: the speed audit (Nov 2026) found the settings' shapes and the Assistant's
 * places bringing 168 KB of every add-on's words to pages that never read them.
 */
export interface AddonServerModule {
  readonly manifest: AddonManifest;
  readonly commands?: readonly CommandDef[];
  readonly queries?: readonly QueryDef[];
  /** The shapes of its settings. Its manifest's `settings` says the rest: version, permission, switches. */
  readonly settings?: AddonSettingsShapes;
  /**
   * What the Assistant is told of its pages, where it runs and to people who may open it, beside the manifest's one
   * line (`ai.directory`): each page the way there from the side menu in the screens' own words, paths under its own
   * (`/a/<id>`), so the Assistant names them and knows the one a question is asked from; and the words it shares
   * with core's pages, said outright.
   */
  readonly ai?: {
    readonly places?: readonly AppPlace[];
    readonly lookAlikes?: readonly string[];
  };
  /**
   * A person's operations the Assistant never runs, by name, and why: what the add-on's browser extension sends in,
   * a code that never goes through the AI, deleting for good. Every other operation a person runs declares `ai`
   * (the owner's rule, 2026-10-26 and 2026-10-27; `addonAssistantIssues` holds every add-on to it).
   */
  readonly notForTheAssistant?: Readonly<Record<string, string>>;
}

/** The shapes of one add-on's settings, from its server half; none when it has none, or no code yet. */
export const addonSettingsShapes = (
  modules: readonly Pick<AddonServerModule, 'manifest' | 'settings'>[],
  addonId: string,
): AddonSettingsShapes => modules.find((m) => m.manifest.id === addonId)?.settings ?? {};

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
  for (const { manifest: m, commands = [], queries = [], settings, ai } of modules) {
    const own = new Set(m.permissions.map((p) => p.key));
    if (settings && !m.settings)
      issues.push(`${m.id} has settings' shapes, and its manifest declares no settings`);
    if (ai && !m.ai)
      issues.push(`${m.id} tells the AI its pages, and its manifest has no line for the AI`);
    const shape = (settings?.workspace as { shape?: Record<string, unknown> } | undefined)?.shape;
    for (const k of m.offline?.settings ?? [])
      if (!shape || !(k in shape))
        issues.push(`${m.id}: offline setting "${k}" isn't one of its settings`);
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
      issues.push(...customerOperationIssues(op, `${m.id}.portal.`));
      issues.push(...publicOperationIssues(op, `${m.id}.public.`));
    }
    for (const page of m.ui?.portal ?? []) {
      const q = queries.find((op) => op.name === page.query);
      if (!q?.actors?.includes('customer'))
        issues.push(
          `portal page "${page.path}" shows ${page.query}, which isn't one of its customer queries`,
        );
    }
    for (const page of m.ui?.public ?? []) {
      const q = queries.find((op) => op.name === page.query);
      if (!q?.actors?.includes('public'))
        issues.push(
          `public page "${page.path}" shows ${page.query}, which isn't one of its public queries`,
        );
    }
  }
  return issues;
}

/**
 * What a customer may run (Real Estate round two): only operations named for the portal (`portal.*` for core's,
 * `<id>.portal.*` for an add-on's), for nobody else, asking no permission (a customer holds none), never offered to the
 * AI, and never a change above risk 2. And nothing named for the portal is for anyone else.
 */
export function customerOperationIssues(op: CommandDef | QueryDef, prefix: string): string[] {
  const forCustomer = op.actors?.includes('customer') ?? false;
  const named = op.name.startsWith(prefix);
  if (!forCustomer && !named) return [];
  const issues: string[] = [];
  if (!named) issues.push(`${op.name} is for customers, so it must be named "${prefix}…"`);
  if (!forCustomer) issues.push(`${op.name} is named for the portal, so it's for customers`);
  if ((op.actors ?? ['human']).some((a) => a !== 'customer'))
    issues.push(`${op.name} is for customers alone`);
  if (op.permission) issues.push(`${op.name} is for customers, who hold no permissions`);
  if (op.ai) issues.push(`${op.name} is for customers, so it isn't offered to the AI`);
  if (op.kind === 'command' && op.risk > 2)
    issues.push(`${op.name} is for customers, so its risk is 2 at most`);
  return issues;
}

/**
 * What a visitor to a public page may run (Real Estate round three): only an add-on's operations named for its public
 * pages (`<id>.public.*`), for nobody else, asking no permission (a visitor holds none), never offered to the AI, and
 * never a change above risk 2, a form's answers' own (it can make a customer and a lead, and nothing more). And
 * nothing named for the public pages is for anyone else.
 */
export function publicOperationIssues(op: CommandDef | QueryDef, prefix: string): string[] {
  const forPublic = op.actors?.includes('public') ?? false;
  const named = op.name.startsWith(prefix);
  if (!forPublic && !named) return [];
  const issues: string[] = [];
  if (!named) issues.push(`${op.name} is for public pages, so it must be named "${prefix}…"`);
  if (!forPublic) issues.push(`${op.name} is named for public pages, so it's for visitors`);
  if ((op.actors ?? ['human']).some((a) => a !== 'public'))
    issues.push(`${op.name} is for visitors alone`);
  if (op.permission) issues.push(`${op.name} is for visitors, who hold no permissions`);
  if (op.ai) issues.push(`${op.name} is for visitors, so it isn't offered to the AI`);
  if (op.kind === 'command' && op.risk > 2)
    issues.push(`${op.name} is for visitors, so its risk is 2 at most`);
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

/** A line an add-on writes on a timeline: a record's (a deal), a customer's, a company's or a lead's. */
export interface AddonTimelineLine {
  readonly customRecordId?: string | null;
  readonly personId?: string | null;
  readonly companyId?: string | null;
  readonly leadId?: string | null;
  /** What was done, as it reads after who did it: "confirmed the inspection deadline". */
  readonly words: string;
  /** Anything more, in the quiet well under it. */
  readonly body?: string | null;
  readonly tone?: AddonLineTone;
  /** The event it mirrors. */
  readonly eventId?: string | null;
}

/**
 * Writes an add-on's own line on a timeline (Real Estate step 6), inside its command: the person who did it (or the
 * add-on itself, for its worker) and the add-on's words. A line on a private record is sealed with it (step 4), and
 * the add-on's name stays on the line after its data is deleted.
 */
export async function addonTimelineLine(
  ctx: CommandContext,
  addon: AddonManifest,
  line: AddonTimelineLine,
): Promise<string> {
  const words = line.words.replace(/\s+/g, ' ').trim();
  if (!words || words.length > 300)
    throw new Error(`${addon.id}: a timeline line says 1 to 300 characters`);
  return logSystemActivity(ctx, {
    subtype: 'addon_line',
    customRecordId: line.customRecordId ?? null,
    personId: line.personId ?? null,
    companyId: line.companyId ?? null,
    leadId: line.leadId ?? null,
    body: line.body?.trim() || null,
    eventId: line.eventId ?? null,
    meta: {
      addon: { id: addon.id, name: addon.name },
      words,
      ...(line.tone ? { tone: line.tone } : {}),
    },
  });
}
