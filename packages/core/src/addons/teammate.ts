/**
 * The AI teammate and add-ons (round seven, step 5; Chris 2026-10-05: answer from their deal, ask before acting).
 * An add-on's manifest says what its teammate may do (`teammate`), and this turns that into the teammate's tools:
 *
 * - **Look-ups** are the add-on's own portal queries, run as the customer in the conversation (the worker builds a
 *   customer actor from the run, and the database finds the customer from the run): the teammate sees exactly what
 *   that client's portal shows them. They run on their own.
 * - **Asks** are the add-on's commands a person runs. The teammate never runs one: it holds an ask, which waits as an
 *   approval for someone who may see the record it names (the client's deal), and runs as them once they OK it, with
 *   their permission checked then. The model may add what to tell the customer once it's done.
 *
 * Offered only while the add-on runs and an owner turned it on in the teammate's settings. Never in a website chat
 * whose visitor hasn't proved who they are, on a call, or in a first message (the worker decides that).
 */
import { z } from 'zod';
import type { TeammateTool } from '../ai-team/tools';
import { TEAMMATE_TOOL_NAMES } from '../ai-team/tools';
import type { CommandDef, QueryDef } from '../kernel/types';
import { modelInput, type ScopeKey } from './ai';
import type { AddonId, AddonManifest } from './manifest';
import type { AddonServerModule } from './server';

/** The keys an ask's tool adds: one line for the person who OKs it, and what the customer is told once it's done. */
export const ASK_SUMMARY_KEY = 'askSummary';
export const ASK_MESSAGE_KEY = 'messageOnceDone';

/** An add-on operation offered to the AI teammate as a tool. */
export interface TeammateAddonTool extends TeammateTool<z.ZodObject> {
  readonly skill: 'addons';
  readonly addonId: AddonId;
  readonly addonName: string;
  /** A look-up it runs as the customer, or something it asks a person on their team to do. */
  readonly use: 'lookup' | 'ask';
  readonly op: CommandDef | QueryDef;
  /** An ask's input key holding the customer's record it's about; null for a look-up. */
  readonly record: string | null;
  /** The business ids the operation takes, which the worker puts on after the model's arguments. */
  readonly scope: readonly ScopeKey[];
}

/** Whether an offered tool is an add-on's (the worker runs it through the kernel) rather than one of core's. */
export const isTeammateAddonTool = (tool: TeammateTool): tool is TeammateAddonTool =>
  tool.skill === 'addons' && 'op' in tool;

const ASK_LINE =
  ' Nothing is done yet when you call this: a person on their team OKs it first. Tell them you’ve asked, never that it’s done.';

function opOf(module: AddonServerModule, name: string): CommandDef | QueryDef | undefined {
  return [...(module.queries ?? []), ...(module.commands ?? [])].find((o) => o.name === name);
}

/** One declared tool, or null when it can't be one (`addonTeammateIssues` says why). */
function deriveTool(
  m: AddonManifest,
  module: AddonServerModule,
  declared: { readonly operation: string; readonly tool: string; readonly description: string },
  use: 'lookup' | 'ask',
  record: string | null,
): TeammateAddonTool | null {
  const op = opOf(module, declared.operation);
  if (!op || op.addon?.id !== m.id) return null;
  if (use === 'lookup' && (op.kind !== 'query' || !(op.actors ?? []).includes('customer')))
    return null;
  if (
    use === 'ask' &&
    (op.kind !== 'command' ||
      !(op.actors ?? ['human']).includes('human') ||
      op.permission === null ||
      op.risk > 2)
  )
    return null;
  const view = modelInput(op.input);
  if (!view) return null;
  if (record && !(record in view.input.shape)) return null;
  const input =
    use === 'ask'
      ? view.input.extend({
          [ASK_SUMMARY_KEY]: z
            .string()
            .trim()
            .min(1)
            .max(300)
            .describe(
              'One line for the person who OKs it: what to do, for whom ("Add 412 Oak St to Dana’s homes").',
            ),
          [ASK_MESSAGE_KEY]: z
            .string()
            .trim()
            .min(1)
            .max(1000)
            .optional()
            .describe(
              'What to send them once a person OKs it and it’s done. Leave out to send nothing.',
            ),
        })
      : view.input;
  const said = declared.description.trim();
  return {
    name: declared.tool,
    description: `${/[.!?]$/.test(said) ? said : `${said}.`} From the ${m.name} add-on.${use === 'ask' ? ASK_LINE : ''}`,
    input,
    skill: 'addons',
    autonomy: use === 'ask' ? 'approval' : 'auto',
    addonId: m.id,
    addonName: m.name,
    use,
    op,
    record,
    scope: view.scope,
  };
}

const derived = new WeakMap<readonly AddonServerModule[], readonly TeammateAddonTool[]>();

/** Every add-on tool the teammate could be offered, in the modules' order (each one's look-ups, then its asks). */
export function allTeammateAddonTools(
  modules: readonly AddonServerModule[],
): readonly TeammateAddonTool[] {
  const known = derived.get(modules);
  if (known) return known;
  const taken = new Set<string>(TEAMMATE_TOOL_NAMES);
  const list: TeammateAddonTool[] = [];
  for (const module of modules) {
    const t = module.manifest.teammate;
    if (!t) continue;
    const declared = [
      ...t.lookups.map((d) => ({ d, use: 'lookup' as const, record: null })),
      ...(t.asks ?? []).map((d) => ({ d, use: 'ask' as const, record: d.record })),
    ];
    for (const { d, use, record } of declared) {
      const tool = deriveTool(module.manifest, module, d, use, record);
      if (!tool || taken.has(tool.name)) continue;
      taken.add(tool.name);
      list.push(tool);
    }
  }
  derived.set(modules, list);
  return list;
}

/**
 * The add-on tools to offer the teammate now: those of add-ons running in the business (`active`) that an owner
 * turned on for it (`on`). Always in the modules' order, so the request the provider caches stays the same.
 */
export function teammateAddonTools(
  modules: readonly AddonServerModule[],
  opts: { readonly active: readonly string[]; readonly on: (addonId: string) => boolean },
): TeammateAddonTool[] {
  if (opts.active.length === 0) return [];
  const running = new Set(opts.active);
  return allTeammateAddonTools(modules).filter((t) => running.has(t.addonId) && opts.on(t.addonId));
}

/** The add-ons that offer the teammate anything: what its settings show a switch for, while each runs. */
export const teammateAddons = (modules: readonly AddonServerModule[]): readonly AddonManifest[] =>
  modules.map((m) => m.manifest).filter((m) => !!m.teammate);

/**
 * One line per add-on the teammate uses in this run, for its per-run context (never the fixed instructions):
 * "Real Estate (realestate_…): their home search, deal and showings". None when it uses none.
 */
export function teammateAddonDirectory(
  modules: readonly AddonServerModule[],
  tools: readonly TeammateAddonTool[],
): string[] {
  const using = new Set(tools.map((t) => t.addonId));
  return modules.flatMap(({ manifest: m }) =>
    m.teammate && using.has(m.id) ? [`${m.name} (${m.id}_…): ${m.teammate.directory.trim()}`] : [],
  );
}

/**
 * What would keep an add-on's teammate tools from working as declared, for the tests to print over every module: an
 * operation that isn't the add-on's, a look-up that isn't a portal query a customer runs, an ask that isn't a command
 * a person runs with a permission and risk 2 or less, a record key the input doesn't have, or a tool name the teammate
 * already uses.
 */
export function addonTeammateIssues(modules: readonly AddonServerModule[]): string[] {
  const issues: string[] = [];
  const taken = new Set<string>(TEAMMATE_TOOL_NAMES);
  for (const module of modules) {
    const t = module.manifest.teammate;
    if (!t) continue;
    const id = module.manifest.id;
    for (const d of [...t.lookups, ...(t.asks ?? [])]) {
      if (taken.has(d.tool)) issues.push(`${id}: teammate tool "${d.tool}" is already taken`);
      taken.add(d.tool);
    }
    for (const d of t.lookups) {
      const op = opOf(module, d.operation);
      if (!op)
        issues.push(
          `${id}: teammate look-up "${d.tool}" runs "${d.operation}", which it doesn't have`,
        );
      else if (op.kind !== 'query')
        issues.push(`${id}: teammate look-up "${d.tool}" must run a query`);
      else if (!(op.actors ?? []).includes('customer'))
        issues.push(
          `${id}: teammate look-up "${d.tool}" runs "${d.operation}", which a customer can't`,
        );
      else if (!modelInput(op.input))
        issues.push(`${id}: "${d.operation}"'s input must be one object with a workspaceId`);
    }
    for (const d of t.asks ?? []) {
      const op = opOf(module, d.operation);
      if (!op) {
        issues.push(`${id}: teammate ask "${d.tool}" runs "${d.operation}", which it doesn't have`);
        continue;
      }
      if (op.kind !== 'command') {
        issues.push(`${id}: teammate ask "${d.tool}" must run a command`);
        continue;
      }
      if (!(op.actors ?? ['human']).includes('human'))
        issues.push(`${id}: teammate ask "${d.tool}" runs "${d.operation}", which a person can't`);
      if (op.permission === null)
        issues.push(
          `${id}: teammate ask "${d.tool}" runs "${d.operation}", which has no permission`,
        );
      if (op.risk > 2)
        issues.push(
          `${id}: teammate ask "${d.tool}" runs "${d.operation}", risk ${op.risk}: asks are 2 or less`,
        );
      const view = modelInput(op.input);
      if (!view)
        issues.push(`${id}: "${d.operation}"'s input must be one object with a workspaceId`);
      else {
        if (!(d.record in view.input.shape))
          issues.push(
            `${id}: teammate ask "${d.tool}" names its record by "${d.record}", which its input doesn't have`,
          );
        for (const key of [ASK_SUMMARY_KEY, ASK_MESSAGE_KEY])
          if (key in view.input.shape)
            issues.push(
              `${id}: "${d.operation}"'s input has "${key}", which the teammate's asks use`,
            );
      }
    }
  }
  return issues;
}
