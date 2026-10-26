/**
 * Add-ons and the AI (docs/addon-readiness-audit.md §8), server side: the Assistant's tools derived from add-on
 * operations, the one line per running add-on that tells the model what they cover, and what `find_capabilities`
 * answers.
 *
 * - **Tools come from the action layer.** An add-on command or query that declares `ai` is a tool: its name is
 *   `ai.tool`, its input is the operation's own schema without the business's ids (the executor puts those on after
 *   the model's arguments, so no argument can point a call at another business), and its autonomy is never looser
 *   than the operation's risk allows. No add-on writes glue for the AI.
 * - **Offered only while it can be used:** the add-on runs in this business and the person holds the operation's
 *   permission. The runtime still refuses any tool it didn't offer, and the kernel checks the add-on and the permission
 *   again on every call and at every Confirm, so a card confirmed after the add-on was turned off is refused.
 * - **Deterministic.** The same modules, add-ons and permissions give the same tools in the same order, so the
 *   request the provider caches stays the same from one question to the next.
 */
import { z } from 'zod';
import type { Tx } from '@hfos/db/client';
import { assistantToolByName } from '../assistant/tools';
import type { CommandDef, QueryDef } from '../kernel/types';
import type { CapabilityContext, CapabilityView } from './capabilities';
import { capabilitySets, effectiveStatus } from './capabilities';
import type { Catalog } from './graph';
import { capabilityContextOf, loadGrants, loadInstallations, loadOverrides } from './load';
import type { AddonId, AddonManifest, CapabilityId } from './manifest';
import { recommendAddons, words } from './recommend';
import { AI_TOOL_NAME, type AddonServerModule } from './server';

export type AddonToolAutonomy = 'auto' | 'confirm' | 'never';

const STRICTNESS: Readonly<Record<AddonToolAutonomy, number>> = { auto: 0, confirm: 1, never: 2 };

/**
 * The loosest an operation may be for the AI, from what it is: look-ups run on their own, and so do commands of risk 0
 * or 1 (a note, a task); risk 2 and 3 (anything that reaches customers, moves money, deletes or changes settings)
 * wait for the person's OK; risk 4 (running the business's admin) is never the AI's to do.
 */
export function autonomyFloor(op: CommandDef | QueryDef): AddonToolAutonomy {
  if (op.kind === 'query') return 'auto';
  return op.risk <= 1 ? 'auto' : op.risk <= 3 ? 'confirm' : 'never';
}

/**
 * The autonomy an operation's tool gets: its floor, or what its `ai.autonomy` asks for when that is stricter — never
 * looser. A look-up that asks to wait for an OK is never offered: a card would have nothing to show, and what it found
 * would come after the answer.
 */
export function addonToolAutonomy(op: CommandDef | QueryDef): AddonToolAutonomy {
  const floor = autonomyFloor(op);
  const asked = op.ai?.autonomy;
  const chosen = asked && STRICTNESS[asked] > STRICTNESS[floor] ? asked : floor;
  return op.kind === 'query' && chosen === 'confirm' ? 'never' : chosen;
}

/** The business's ids: never the model's to choose, always put on by the executor. */
const SCOPE_KEYS = ['workspaceId', 'organizationId'] as const;
export type ScopeKey = (typeof SCOPE_KEYS)[number];
const isScopeKey = (key: string): key is ScopeKey =>
  (SCOPE_KEYS as readonly string[]).includes(key);

/**
 * An operation's input as the model sees it: its own object without the business's ids. Null when it can't be one:
 * a tool's input is one object (Claude takes nothing else), and it names the business (the kernel checks an add-on
 * in a business, so an operation outside one can't run for an add-on at all).
 */
export function modelInput(input: z.ZodType): { input: z.ZodObject; scope: ScopeKey[] } | null {
  if (!(input instanceof z.ZodObject)) return null;
  const shape = input.shape as Record<string, z.ZodType>;
  if (!('workspaceId' in shape)) return null;
  const scope = SCOPE_KEYS.filter((k) => k in shape);
  // `.omit` keeps everything else about the object, but refuses one with refinements. The model's view can do
  // without those: the kernel parses the operation's own schema, refinements and all, before anything runs.
  if (!input._zod.def.checks?.length) {
    const mask = Object.fromEntries(scope.map((k) => [k, true] as const));
    return { input: input.omit(mask as never) as unknown as z.ZodObject, scope };
  }
  const rest = z.object(Object.fromEntries(Object.entries(shape).filter(([k]) => !isScopeKey(k))));
  const catchall = input._zod.def.catchall;
  return { input: (catchall ? rest.catchall(catchall) : rest) as z.ZodObject, scope };
}

/** An add-on operation offered to the Assistant as a tool. */
export interface AddonAiTool {
  /** `<add-on id>_<verb>_<noun>`: the operation's `ai.tool`. */
  readonly name: string;
  /** The operation's `ai.description`, else its own description. */
  readonly description: string;
  /** The operation's input without the business's ids, which the executor injects. */
  readonly input: z.ZodObject;
  readonly autonomy: 'auto' | 'confirm';
  /** The operation's permission; null (look-ups only): anyone who works in the business. */
  readonly permission: string | null;
  readonly addonId: AddonId;
  readonly addonName: string;
  /** More words tool search should match it on. */
  readonly keywords: readonly string[];
  /** The operation the executor runs through the kernel. */
  readonly op: CommandDef | QueryDef;
  /** The business ids the operation's input takes, which the executor puts on after the model's arguments. */
  readonly scope: readonly ScopeKey[];
}

/** Whether an offered tool is an add-on's (it runs through the generic executor) rather than one of core's. */
export const isAddonAiTool = (tool: object): tool is AddonAiTool =>
  'addonId' in tool && 'op' in tool;

/** One operation as a tool, or null when it isn't offered to the AI at all. */
function deriveTool(m: AddonManifest, op: CommandDef | QueryDef): AddonAiTool | null {
  const ai = op.ai;
  // Unstamped, the kernel wouldn't know whose it is, and would run it while its add-on is off.
  if (!ai || op.addon?.id !== m.id) return null;
  if (!AI_TOOL_NAME.test(ai.tool) || !ai.tool.startsWith(`${m.id}_`)) return null;
  const autonomy = addonToolAutonomy(op);
  if (autonomy === 'never') return null;
  // A command without a permission is for HandsFreeOS's own work, never something a person asks for.
  if (op.permission === null && op.kind !== 'query') return null;
  const view = modelInput(op.input);
  if (!view) return null;
  return {
    name: ai.tool,
    description: ai.description ?? op.description,
    input: view.input,
    autonomy,
    permission: op.permission,
    addonId: m.id,
    addonName: m.name,
    keywords: ai.keywords ?? [],
    op,
    scope: view.scope,
  };
}

interface Derived {
  readonly list: readonly AddonAiTool[];
  readonly byName: ReadonlyMap<string, AddonAiTool>;
}
const derived = new WeakMap<readonly AddonServerModule[], Derived>();

function derive(modules: readonly AddonServerModule[]): Derived {
  const known = derived.get(modules);
  if (known) return known;
  // Core's own tools keep their names: an add-on's tool can never stand in for one.
  const taken = new Set<string>(assistantToolByName.keys());
  const list: AddonAiTool[] = [];
  for (const { manifest, commands = [], queries = [] } of modules)
    for (const op of [...queries, ...commands]) {
      const tool = deriveTool(manifest, op);
      if (!tool || taken.has(tool.name)) continue;
      taken.add(tool.name);
      list.push(tool);
    }
  const made: Derived = { list, byName: new Map(list.map((t) => [t.name, t])) };
  derived.set(modules, made);
  return made;
}

/**
 * Every tool the add-on modules could offer anyone, in the modules' order (each module's look-ups, then its
 * commands, as it lists them). Worked out once per list of modules, so the tools are the same objects every time.
 */
export const allAddonAiTools = (modules: readonly AddonServerModule[]): readonly AddonAiTool[] =>
  derive(modules).list;

/**
 * An add-on tool by name, whether or not it could be offered now: what a waiting card is confirmed with. Nothing is
 * checked here — the kernel checks the add-on and the permission when it runs.
 */
export const addonAiToolByName = (
  modules: readonly AddonServerModule[],
  name: string,
): AddonAiTool | undefined => derive(modules).byName.get(name);

/**
 * The add-on tools to offer this person now: those of add-ons running in the business (`active`, as
 * `private.active_addons` gives them) whose permission the person holds. Look-ups without a permission go to anyone
 * who works there. Always in the modules' order, whatever order `active` comes in.
 */
export function addonAiTools(
  modules: readonly AddonServerModule[],
  opts: { readonly active: readonly string[]; readonly permissions: readonly string[] },
): AddonAiTool[] {
  if (opts.active.length === 0) return [];
  const running = new Set(opts.active);
  const held = new Set(opts.permissions);
  return derive(modules).list.filter(
    (t) => running.has(t.addonId) && (t.permission === null || held.has(t.permission)),
  );
}

/**
 * What the model reads about an add-on tool: its description, the add-on it belongs to, and its extra words, so tool
 * search finds it by what people call things there.
 */
export function addonToolDescription(
  tool: Pick<AddonAiTool, 'description' | 'addonName' | 'keywords'>,
): string {
  const said = tool.description.trim();
  const sentence = /[.!?]$/.test(said) ? said : `${said}.`;
  const also = tool.keywords.length ? ` Also: ${tool.keywords.join(', ')}.` : '';
  return `${sentence} From the ${tool.addonName} add-on.${also}`;
}

/**
 * The model's arguments as the operation takes them: only what the tool's input declares (everything, for an input
 * that keeps unknown keys), and never the business's ids.
 */
export function addonToolArguments(
  tool: Pick<AddonAiTool, 'input'>,
  raw: unknown,
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const declared = new Set(Object.keys(tool.input.shape));
  const catchall = tool.input._zod.def.catchall;
  const keepsUnknown = !!catchall && !(catchall instanceof z.ZodNever);
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([k]) => !isScopeKey(k) && (keepsUnknown || declared.has(k)),
    ),
  );
}

/**
 * The operation's input for one call: the arguments, then the business's ids on top — last, so nothing in the
 * arguments can ever choose another business the person also works in (audit AI-3).
 */
export function addonOperationInput(
  tool: AddonAiTool,
  args: Record<string, unknown>,
  ids: { readonly workspaceId: string; readonly organizationId: string },
): Record<string, unknown> {
  return {
    ...args,
    workspaceId: ids.workspaceId,
    ...(tool.scope.includes('organizationId') ? { organizationId: ids.organizationId } : {}),
  };
}

/**
 * One line per running add-on that says what its tools cover, for the model's per-business context (never the fixed
 * instructions): "Property Management (pm_…): properties, units, tenants and leases". Catalogue order; none when no
 * running add-on has a directory line.
 */
export function addonDirectory(catalog: Catalog, active: readonly string[]): string[] {
  if (active.length === 0) return [];
  const running = new Set(active);
  return catalog.flatMap((m) => {
    const line = m.ai?.directory.trim();
    return running.has(m.id) && line ? [`${m.name} (${m.id}_…): ${line}`] : [];
  });
}

/**
 * What would keep an add-on's operation from reaching the AI as it declares, for the tests to print over every
 * module (names, prefixes and stamps are `addonModuleIssues`'): a name the Assistant already uses, an input that isn't
 * one object with the business's id, a command with no permission, a look-up that asks to wait for an OK, a risk-4
 * command that could never be offered.
 */
export function addonAiIssues(modules: readonly AddonServerModule[]): string[] {
  const issues: string[] = [];
  const core = new Set<string>(assistantToolByName.keys());
  for (const { commands = [], queries = [] } of modules)
    for (const op of [...queries, ...commands]) {
      const ai = op.ai;
      if (!ai) continue;
      if (core.has(ai.tool))
        issues.push(`${op.name}'s AI tool "${ai.tool}" is the Assistant's own`);
      if (!modelInput(op.input))
        issues.push(`${op.name}'s input must be one object with a workspaceId to be an AI tool`);
      if (op.kind === 'command' && op.permission === null)
        issues.push(`${op.name} has no permission, so the AI is never offered it`);
      if (op.kind === 'query' && ai.autonomy === 'confirm')
        issues.push(
          `${op.name} is a look-up and can't wait for an OK: use 'never' to keep it from the AI`,
        );
      if (op.kind === 'command' && op.risk === 4 && ai.autonomy !== 'never')
        issues.push(`${op.name} is risk 4, which the AI is never offered: say autonomy 'never'`);
    }
  return issues;
}

// ---------- find_capabilities ----------

/** One capability as `find_capabilities` hands it to the model. */
export interface CapabilityLine {
  readonly id: CapabilityId;
  readonly label: string;
  readonly description: string;
  /** "HandsFreeOS", or the add-on's name. */
  readonly from: string;
}

/** An add-on this business could add. Only ever an `available` one (recommendAddons' rules). */
export interface AddonSuggestion {
  readonly addonId: AddonId;
  readonly name: string;
  readonly summary: string;
  /** What it would let them do. */
  readonly does: readonly string[];
  readonly available: true;
}

/** How many planned add-ons one answer lists at most. */
export const PLANNED_SHOWN = 8;

/** Something planned: a promise, never something to add. */
export interface PlannedAddon {
  readonly addonId: AddonId;
  readonly name: string;
  readonly summary: string;
  readonly does: readonly string[];
  readonly available: false;
}

export interface FoundCapabilities {
  /** What this person can do here now; with a need, the best matches first. */
  readonly current: readonly CapabilityLine[];
  /** On here, but not theirs: an owner or admin can give them access. */
  readonly restricted: readonly CapabilityLine[];
  /** Installed, but turned off: an owner or admin can turn it back on. */
  readonly turnedOff: readonly CapabilityLine[];
  /** Only for people who may add add-ons, only for a need nothing here meets: at most two, never planned. */
  readonly suggestions: readonly AddonSuggestion[];
  /** Only when asked for, and only for people who may add add-ons. */
  readonly planned?: readonly PlannedAddon[];
  /** How to speak about each set that isn't empty. */
  readonly say: Readonly<Record<string, string>>;
}

const SAY = {
  restricted: 'On here, but not for them: an owner or admin can give them access.',
  turnedOff: 'Installed here but turned off: an owner or admin can turn it back on.',
  suggestions:
    'Add-ons they could add that do what they asked. Mention one only if it answers their request, once, in a sentence, and never push it.',
  planned:
    'Planned and not available yet: say it is coming, never that they can add it. Owners and admins vote for what comes next on Add-ons, at the bottom of the side menu.',
} as const;

const line = (c: CapabilityView): CapabilityLine => ({
  id: c.id,
  label: c.label,
  description: c.description,
  from: c.providerName,
});

/** Best matches for the need first; without one, or on a tie, the order they came in. */
function byNeed<T>(items: readonly T[], need: ReadonlySet<string>, text: (t: T) => string): T[] {
  if (need.size === 0) return [...items];
  const score = (t: T) => new Set(words(text(t)).filter((w) => need.has(w))).size;
  return items
    .map((item, i) => ({ item, i, s: score(item) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

/**
 * The answer to "what can I do here?" and "can HandsFreeOS do …?", worked out in code from what the business has on
 * and what this person may use (capabilitySets), never from the prompt. Suggestions follow recommendAddons' rules
 * (available and installable here, only for a need nothing here meets, at most two) and reach only people who hold
 * `addons.manage`, since only they could act on one. Planned add-ons are listed only when asked for, only to the same
 * people, and always as not available.
 */
export function findCapabilities(
  ctx: CapabilityContext,
  input: { readonly need?: string | null; readonly includePlanned?: boolean },
): FoundCapabilities {
  const need = input.need?.trim() ?? '';
  const wanted = new Set(words(need));
  const sets = capabilitySets(ctx);
  const manages = ctx.permissions?.includes('addons.manage') ?? false;
  const text = (c: CapabilityView) => `${c.label} ${c.description} ${c.providerName}`;
  const current = byNeed(sets.current, wanted, text).map(line);
  const restricted = byNeed(sets.restricted, wanted, text).map(line);
  const turnedOff = byNeed(sets.turnedOff, wanted, text).map(line);
  const suggestions: AddonSuggestion[] =
    manages && need
      ? recommendAddons(ctx, need).map((r) => ({
          addonId: r.addonId,
          name: r.name,
          summary: r.summary,
          does: sets.installable.filter((c) => c.provider === r.addonId).map((c) => c.label),
          available: true,
        }))
      : [];
  let planned: PlannedAddon[] | undefined;
  if (manages && input.includePlanned) {
    // Straight from the catalogue: a planned add-on often declares nothing it will do yet. The best matches, and
    // only a few: there are over a hundred.
    const addons = ctx.catalog.filter((m) => effectiveStatus(m, ctx.overrides) === 'planned');
    planned = byNeed(addons, wanted, (m) =>
      [m.name, m.summary, ...m.catalog.keywords, ...m.capabilities.map((c) => c.label)].join(' '),
    )
      .slice(0, PLANNED_SHOWN)
      .map((m) => ({
        addonId: m.id,
        name: m.name,
        summary: m.summary,
        does: m.capabilities.map((c) => c.label),
        available: false,
      }));
  }
  const say: Record<string, string> = {};
  if (restricted.length) say['restricted'] = SAY.restricted;
  if (turnedOff.length) say['turnedOff'] = SAY.turnedOff;
  if (suggestions.length) say['suggestions'] = SAY.suggestions;
  if (planned?.length) say['planned'] = SAY.planned;
  return {
    current,
    restricted,
    turnedOff,
    suggestions,
    ...(planned ? { planned } : {}),
    say,
  };
}

/**
 * What `find_capabilities` is worked out from, read in the caller's transaction (as the person, so row security
 * applies): the business's add-ons in every state, HandsFreeOS's switches, and the person's permissions.
 */
export async function loadCapabilityContext(
  tx: Tx,
  catalog: Catalog,
  workspaceId: string,
  permissions: readonly string[] | null,
): Promise<CapabilityContext> {
  const [installations, overrides, grants] = await Promise.all([
    loadInstallations(tx, workspaceId),
    loadOverrides(tx),
    loadGrants(tx, workspaceId),
  ]);
  return capabilityContextOf(catalog, installations, overrides, permissions, grants);
}
