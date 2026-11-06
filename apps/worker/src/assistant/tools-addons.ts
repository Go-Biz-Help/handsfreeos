/**
 * Add-ons in the Assistant (docs/addon-readiness-audit.md §8): the one executor every add-on tool runs through, and
 * `find_capabilities`.
 *
 * An add-on's tools are its own operations (packages/core/src/addons/ai.ts), so nothing here is written per tool. A
 * look-up runs through the kernel as the person; a change whose risk lets it run on its own does too, marked as done
 * through the Assistant; anything else waits on a card built from what it would be given, and runs through the
 * kernel only once the person confirms, with the arguments the card was drawn from. The business's ids always go on
 * after the model's arguments. The kernel checks that the add-on is on and that the person holds the permission on
 * every call, so a card confirmed after the add-on was turned off is refused — and says so in plain words.
 *
 * An add-on's worker actions (the buttons that need the worker: the AI writing a draft, a page at a connected service)
 * are tools the same way, from their `ai`: offered while the add-on runs and the person holds the permission, and run
 * through the same door as the route the screens call (addons/actions.ts), which checks both again.
 */
import { z } from 'zod';
import {
  ADDON_SERVER_MODULES,
  addonOperationInput,
  AI_TOOL_NAME,
  allAddonAiTools,
  assistantToolByName,
  executeCommand,
  executeQuery,
  findCapabilities,
  HfosError,
  loadCapabilityContext,
  rehearseCommand,
  type AddonAiTool,
  type AddonManifest,
  type Catalog,
  type RequestMeta,
} from '@hfos/core/server';
import { asUser, type Db } from '@hfos/db/client';
import { runAddonAction } from '../addons/actions';
import type { AddonWorkerAction, AddonWorkerModule } from '../addons/types';
import { workerMeta, type WorkerServices } from '../services';
import { keptAnswer } from './committed';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { query } from './tools-read';
import { settingsCard } from './tools-settings-calendar';

type Args = Record<string, unknown>;
type Field = { label: string; value: string };

export const addonStepLabels: Record<string, string> = {
  find_capabilities: 'Checking what you can do here',
};

/** What the panel says while an add-on's tool runs. */
export function addonToolStep(tool: AddonAiTool): string {
  if (tool.op.kind === 'query') return `Looking in ${tool.addonName}`;
  return tool.autonomy === 'auto' ? `Working in ${tool.addonName}` : 'Preparing it for your OK';
}

const meta = (ctx: ToolContext): RequestMeta => ({
  correlationId: ctx.correlationId,
  channel: 'assistant',
});

/** The most of an add-on's answer, in characters of JSON, the model reads whole. */
export const MOST = 16_000;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const sizeOf = (v: unknown) => JSON.stringify(v ?? null).length;

/**
 * An answer too long to read whole, made to fit: every part of it that isn't a list kept whole (the counts, the page
 * it is and how many pages there are, why nothing more is on it), and each list cut to the first of its rows that fit,
 * the room shared evenly, a short list kept whole. Null when the rest alone doesn't fit, or it isn't one object.
 */
export function fittedAnswer(
  data: unknown,
  most = MOST,
): { data: Record<string, unknown>; dropped: Record<string, number> } | null {
  if (!isPlainObject(data)) return null;
  const lists = Object.entries(data).filter(
    (e): e is [string, unknown[]] => Array.isArray(e[1]) && e[1].length > 0,
  );
  if (!lists.length) return null;
  const rest = Object.fromEntries(Object.entries(data).filter(([, v]) => !Array.isArray(v)));
  // Room for the rest, the lists' own brackets and keys, and the `dropped` the answer adds.
  let room = most - sizeOf(rest) - lists.reduce((n, [k]) => n + k.length + 8, 0) - 200;
  if (room <= 0) return null;
  const kept = new Map<string, unknown[]>();
  const dropped: Record<string, number> = {};
  // The smallest lists first, so one that fits in its share gives what it leaves to the others.
  const bySize = [...lists].sort((a, b) => sizeOf(a[1]) - sizeOf(b[1]));
  bySize.forEach(([key, rows], i) => {
    const share = Math.floor(room / (bySize.length - i));
    const shown: unknown[] = [];
    let used = 0;
    for (const row of rows) {
      const size = sizeOf(row) + 1;
      if (used + size > share) break;
      shown.push(row);
      used += size;
    }
    room -= used;
    kept.set(key, shown);
    if (shown.length < rows.length) dropped[key] = rows.length - shown.length;
  });
  return {
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, kept.has(k) ? kept.get(k) : v]),
    ),
    dropped,
  };
}

/**
 * What the model reads back from an add-on: its answer, marked as the add-on's data (it can hold what customers
 * wrote), and made to fit when it is too long to read: its lists cut to their first rows, everything else whole; only
 * an answer that can't be made to fit that way is cut short as it is.
 */
export function answerFrom(tool: Pick<AddonAiTool, 'addonName'>, output: unknown): Args {
  const data = output ?? null;
  const json = JSON.stringify(data);
  if (json.length <= MOST) return { from: tool.addonName, data };
  const fitted = fittedAnswer(data);
  if (fitted)
    return {
      from: tool.addonName,
      data: fitted.data,
      cutShort: true,
      dropped: fitted.dropped,
      note: 'That was too long to read whole, so some lists show only their first rows (dropped says how many of each were left out); everything else is whole. For the rest, ask for less: one kind, another page, a smaller page or a narrower search.',
    };
  return {
    from: tool.addonName,
    data: `${json.slice(0, MOST)}…`,
    cutShort: true,
    note: 'That was too long to read whole: ask it for less (a narrower search or a smaller page).',
  };
}

/** The answer as the model reads it: reshaped by the operation's own `ai.answer` when it has one. */
const shownOf = (tool: AddonAiTool, output: unknown, input: Args): unknown =>
  tool.op.ai?.answer ? tool.op.ai.answer(output, input) : output;

/** The kernel's refusal for an add-on that is off, in words that say nothing happened and who can change that. */
function saidPlainly(tool: Pick<AddonAiTool, 'addonName'>, e: unknown): unknown {
  if (e instanceof HfosError && e.rule === 'addon_inactive')
    return new HfosError(
      e.code,
      e.status,
      `${tool.addonName} is turned off for this business, so nothing was done. An owner or admin can turn it back on in Settings → Add-ons.`,
      e.details,
      e.rule,
    );
  return e;
}

/** A look-up, or a change that may run on its own: through the kernel, as the person, now. */
export async function runAddonTool(
  db: Db,
  tool: AddonAiTool,
  args: Args,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const op = tool.op;
  const input = addonOperationInput(tool, args, ctx);
  try {
    if (op.kind === 'query')
      return {
        result: answerFrom(
          tool,
          shownOf(tool, await executeQuery(db, op, input, ctx.actor, meta(ctx)), input),
        ),
      };
    if (tool.autonomy !== 'auto') throw new Error(`${tool.name} waits for the person’s OK`);
    const done = await executeCommand(db, op, input, ctx.actor, meta(ctx));
    return {
      result: { done: true, ...answerFrom(tool, shownOf(tool, done.output, input)) },
      command: op.name,
      record: { outcome: `Done in ${tool.addonName}`, command: op.name },
    };
  } catch (e) {
    throw saidPlainly(tool, e);
  }
}

const clip = (s: string, max = 300) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "leaseId" → "Lease id", "notify_customer" → "Notify customer". */
function labelOf(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function valueOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return clip(v.trim());
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v))
    return v.every((x) => x === null || typeof x !== 'object')
      ? clip(v.map(valueOf).filter(Boolean).join(', '))
      : `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  return clip(JSON.stringify(v));
}

/**
 * One line for a value, or a line for each part of a group of settings or details it gives ("Settings → Replies",
 * "Changes → Networks → Linkedin → Sending"), so a change to one part shows as that part, never as a block of JSON
 * cut short.
 */
function linesOf(label: string, v: unknown, depth = 0): Field[] {
  if (isPlainObject(v) && depth < 3) {
    const parts = Object.entries(v).flatMap(([k, x]) =>
      linesOf(`${label} → ${labelOf(k)}`, x, depth + 1),
    );
    if (parts.length) return parts;
  }
  return [{ label, value: valueOf(v) }];
}

/**
 * The card's lines: what it does, then what it would be given, in the input's own order, a group given in parts a line
 * for each part. A screen's command the Assistant runs as it is (tools-screen-actions.ts) draws its card the same way.
 */
export function cardFields(
  tool: Pick<AddonAiTool, 'input' | 'description'>,
  values: Args,
): Field[] {
  const given = Object.keys(tool.input.shape)
    .flatMap((key) => linesOf(labelOf(key), values[key]))
    .filter((f) => f.value);
  // The card holds ten lines: what it does, and nine for the rest.
  const rows =
    given.length > 9
      ? [...given.slice(0, 8), { label: 'And', value: `${given.length - 8} more` }]
      : given;
  return [{ label: 'What', value: clip(tool.description) }, ...rows];
}

/**
 * A change that waits for the person's OK: a card saying what it does and what it would be given. The operation's
 * own schema — refinements and all — checks the arguments first, then the operation is rehearsed through the kernel
 * and rolled back, so a card its rules would refuse now is never drawn.
 */
export async function prepareAddonTool(
  db: Db,
  tool: AddonAiTool,
  args: Args,
  ctx: ToolContext,
  toolCallId: string,
): Promise<PreparedAction> {
  if (tool.op.kind !== 'command') throw new Error(`${tool.name} is a look-up`);
  const input = addonOperationInput(tool, args, ctx);
  const checked = tool.op.input.safeParse(input);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    throw HfosError.validation(
      issues,
      issues[0]?.message ??
        `Some of that doesn’t fit what ${tool.addonName} takes. Check the details and call ${tool.name} again.`,
    );
  }
  // Tried first and rolled back whole, so a change its own rules would refuse now is said before any card: nobody
  // presses Confirm on something that can't go through.
  let rehearsed: unknown;
  try {
    rehearsed = await rehearseCommand(db, tool.op, input, ctx.actor, meta(ctx));
  } catch (e) {
    throw saidPlainly(tool, e);
  }
  // The operation's own card, from what it would do, when it has one; else a line for each part of what it's given.
  const own = tool.op.ai?.card?.(rehearsed, input) ?? null;
  const shown = tool.input.safeParse(args);
  return {
    card: settingsCard(toolCallId, tool.name, {
      title: own ? clip(own.title, 120) : `Do this in ${tool.addonName}?`,
      fields: own
        ? [{ label: 'What', value: clip(tool.description) }, ...ownLines(own.lines)]
        : cardFields(tool, shown.success ? (shown.data as Args) : args),
      confirmLabel: 'Confirm',
      ...(own?.warning ? { warnings: [{ kind: 'caution', text: clip(own.warning) }] } : {}),
    }),
    result: {
      waiting: true,
      addon: tool.addonName,
      what: tool.description,
      // What the card says it would do, so the model can say it too.
      ...(own ? { card: own.title, says: ownLines(own.lines) } : {}),
    },
  };
}

/** An operation's own card lines, each kept short, nine at most with the rest counted: the card holds ten. */
function ownLines(lines: readonly Field[]): Field[] {
  const shown = lines
    .map((l) => ({ label: clip(l.label, 60), value: clip(l.value) }))
    .filter((l) => l.value);
  return shown.length > 9
    ? [...shown.slice(0, 8), { label: 'And', value: `${shown.length - 8} more` }]
    : shown;
}

/** The person pressed Confirm: the operation runs through the kernel, which checks the add-on and the permission again. */
export async function commitAddonTool(
  db: Db,
  tool: AddonAiTool,
  args: Args,
  ctx: ToolContext,
): Promise<CommittedAction> {
  const op = tool.op;
  if (op.kind !== 'command') throw new Error(`${tool.name} is a look-up`);
  const input = addonOperationInput(tool, args, ctx);
  let output: unknown;
  try {
    ({ output } = await executeCommand(db, op, input, ctx.actor, meta(ctx)));
  } catch (e) {
    throw saidPlainly(tool, e);
  }
  // The operation's own words for what happened, as its screens' toast says it, when it has them.
  const said = op.ai?.outcome?.(output, input) ?? null;
  // What it answered stays with the tool call for the model's later questions (a listing page's link, say).
  return {
    outcome: said?.words || `Done in ${tool.addonName}`,
    href: said?.path ? `/app/w/${ctx.workspaceId}/${said.path.replace(/^\/+/, '')}` : null,
    command: op.name,
    answer: keptAnswer(shownOf(tool, output, input), op.shownOnce),
  };
}

// ---------- worker actions ----------

/** One of an add-on's worker actions offered to the Assistant as a tool (its `ai`). */
export interface AddonActionTool {
  /** `<add-on id>_<verb>_<noun>`: the action's `ai.tool`. */
  readonly name: string;
  readonly description: string;
  /** The action's own input: the business is never in it (the door puts it on). */
  readonly input: z.ZodObject;
  readonly autonomy: 'auto' | 'confirm';
  readonly permission: string;
  readonly addonId: string;
  readonly addonName: string;
  readonly keywords: readonly string[];
  /** The action's name (`<id>.…`), as the route takes it. */
  readonly actionName: string;
  readonly action: AddonWorkerAction;
  readonly manifest: AddonManifest;
}

/** Whether an offered tool is an add-on's worker action (it runs through the action door). */
export const isAddonActionTool = (tool: object): tool is AddonActionTool =>
  'actionName' in tool && 'action' in tool;

/** What the panel says while a worker action runs. */
export const addonActionStep = (tool: AddonActionTool): string =>
  tool.autonomy === 'auto' ? `Working in ${tool.addonName}` : 'Preparing it for your OK';

interface DerivedActions {
  readonly list: readonly AddonActionTool[];
  readonly byName: ReadonlyMap<string, AddonActionTool>;
  readonly issues: readonly string[];
}
const derivedActions = new WeakMap<readonly AddonWorkerModule[], DerivedActions>();

/**
 * Every worker action with `ai`, in the modules' order, worked out once per list of modules. One whose name isn't the
 * add-on's, whose input isn't one object, or whose name the Assistant or an add-on operation already uses is left out,
 * and said why (`addonActionIssues`, for the tests).
 */
function deriveActions(modules: readonly AddonWorkerModule[]): DerivedActions {
  const known = derivedActions.get(modules);
  if (known) return known;
  const taken = new Set<string>([
    ...assistantToolByName.keys(),
    ...allAddonAiTools(ADDON_SERVER_MODULES).map((t) => t.name),
  ]);
  const list: AddonActionTool[] = [];
  const issues: string[] = [];
  for (const { manifest, actions = {} } of modules)
    for (const [actionName, action] of Object.entries(actions)) {
      const ai = action.ai;
      if (!ai) continue;
      const input = action.input as z.ZodType;
      if (!AI_TOOL_NAME.test(ai.tool) || !ai.tool.startsWith(`${manifest.id}_`))
        issues.push(
          `${actionName}'s AI tool "${ai.tool}" must be ${manifest.id}_… in letters, digits and _`,
        );
      else if (taken.has(ai.tool))
        issues.push(`${actionName}'s AI tool "${ai.tool}" is already a tool's name`);
      else if (!(input instanceof z.ZodObject))
        issues.push(`${actionName}'s input must be one object to be an AI tool`);
      else {
        taken.add(ai.tool);
        list.push({
          name: ai.tool,
          description: ai.description,
          input,
          autonomy: ai.autonomy,
          permission: action.permission,
          addonId: manifest.id,
          addonName: manifest.name,
          keywords: ai.keywords ?? [],
          actionName,
          action,
          manifest,
        });
      }
    }
  const made: DerivedActions = { list, byName: new Map(list.map((t) => [t.name, t])), issues };
  derivedActions.set(modules, made);
  return made;
}

export const allAddonActionTools = (modules: readonly AddonWorkerModule[]) =>
  deriveActions(modules).list;
export const addonActionIssues = (modules: readonly AddonWorkerModule[]) =>
  deriveActions(modules).issues;
/** A worker action's tool by name, whether or not it could be offered now: what a waiting card is confirmed with. */
export const addonActionToolByName = (modules: readonly AddonWorkerModule[], name: string) =>
  deriveActions(modules).byName.get(name);

/** The worker actions to offer this person now: those of add-ons running here whose permission they hold. */
export function addonActionTools(
  modules: readonly AddonWorkerModule[],
  opts: { readonly active: readonly string[]; readonly permissions: readonly string[] },
): AddonActionTool[] {
  if (opts.active.length === 0) return [];
  const running = new Set(opts.active);
  const held = new Set(opts.permissions);
  return deriveActions(modules).list.filter(
    (t) => running.has(t.addonId) && held.has(t.permission),
  );
}

/** What a worker action needs that a tool call doesn't carry: the worker's services, to run as the route does. */
export interface AddonActionDeps {
  readonly services: WorkerServices;
}

const callOf = (tool: AddonActionTool, args: Args, ctx: ToolContext) => ({
  manifest: tool.manifest,
  action: tool.action,
  workspaceId: ctx.workspaceId,
  userId: ctx.actor.userId,
  input: args,
  meta: workerMeta(ctx.correlationId),
});

function actionsReady(deps: AddonActionDeps | null): AddonActionDeps {
  if (!deps) throw new Error('This worker can’t run add-on actions for the Assistant');
  return deps;
}

/** One that may run on its own: through the action door, now, for the person. */
export async function runAddonActionTool(
  deps: AddonActionDeps | null,
  db: Db,
  tool: AddonActionTool,
  args: Args,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (tool.autonomy !== 'auto') throw new Error(`${tool.name} waits for the person’s OK`);
  try {
    const output = await runAddonAction(actionsReady(deps).services, db, callOf(tool, args, ctx));
    return {
      result: answerFrom(tool, output),
      command: tool.actionName,
      record: { outcome: `Done in ${tool.addonName}`, command: tool.actionName },
    };
  } catch (e) {
    throw saidPlainly(tool, e);
  }
}

/** One that waits for the person's OK: a card, drawn only once the action's own input takes the arguments. */
export function prepareAddonActionTool(
  tool: AddonActionTool,
  args: Args,
  toolCallId: string,
): PreparedAction {
  const checked = tool.action.input.safeParse(args);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    throw HfosError.validation(
      issues,
      issues[0]?.message ??
        `Some of that doesn’t fit what ${tool.addonName} takes. Check the details and call ${tool.name} again.`,
    );
  }
  return {
    card: settingsCard(toolCallId, tool.name, {
      title: `Do this in ${tool.addonName}?`,
      fields: cardFields(tool, args),
      confirmLabel: 'Confirm',
    }),
    result: { waiting: true, addon: tool.addonName, what: tool.description },
  };
}

/** The person pressed Confirm: through the action door, which checks the add-on and the permission again. */
export async function commitAddonActionTool(
  deps: AddonActionDeps | null,
  db: Db,
  tool: AddonActionTool,
  args: Args,
  ctx: ToolContext,
): Promise<CommittedAction> {
  let output: unknown;
  try {
    output = await runAddonAction(actionsReady(deps).services, db, callOf(tool, args, ctx));
  } catch (e) {
    throw saidPlainly(tool, e);
  }
  return {
    outcome: `Done in ${tool.addonName}`,
    href: null,
    command: tool.actionName,
    answer: keptAnswer(output),
  };
}

/** find_capabilities, over the add-on catalogue the worker ships with (tests hand it their own). */
export const capabilityTools: Record<
  string,
  (db: Db, ctx: ToolContext, args: Args, catalog: Catalog) => Promise<ToolOutcome>
> = {
  async find_capabilities(db, ctx, args, catalog) {
    // What the person may do here, as the kernel knows it; then what the business has, read as them.
    const { workspace } = await query<{ workspace: { permissions: string[] } }>(
      db,
      ctx,
      'workspace.get',
    );
    const context = await asUser(db, ctx.actor.claims, (tx) =>
      loadCapabilityContext(tx, catalog, ctx.workspaceId, workspace.permissions),
    );
    return {
      result: findCapabilities(context, {
        need: typeof args['need'] === 'string' ? args['need'] : null,
        includePlanned: args['includePlanned'] === true,
      }),
    };
  },
};
