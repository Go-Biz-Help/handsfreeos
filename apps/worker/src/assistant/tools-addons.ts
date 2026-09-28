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
 */
import {
  addonOperationInput,
  executeCommand,
  executeQuery,
  findCapabilities,
  HfosError,
  loadCapabilityContext,
  type AddonAiTool,
  type Catalog,
  type RequestMeta,
} from '@hfos/core/server';
import { asUser, type Db } from '@hfos/db/client';
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
const MOST = 16_000;

/**
 * What the model reads back from an add-on: its answer, marked as the add-on's data (it can hold what customers
 * wrote), and cut short when it is too long to read.
 */
function answerFrom(tool: AddonAiTool, output: unknown): Args {
  const data = output ?? null;
  const json = JSON.stringify(data);
  if (json.length <= MOST) return { from: tool.addonName, data };
  return {
    from: tool.addonName,
    data: `${json.slice(0, MOST)}…`,
    cutShort: true,
    note: 'That was too long to read whole: ask it for less (a narrower search or a smaller page).',
  };
}

/** The kernel's refusal for an add-on that is off, in words that say nothing happened and who can change that. */
function saidPlainly(tool: AddonAiTool, e: unknown): unknown {
  if (e instanceof HfosError && e.rule === 'addon_inactive')
    return new HfosError(
      e.code,
      e.status,
      `${tool.addonName} is turned off for this business, so nothing was done. An owner or admin can turn it back on.`,
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
      return { result: answerFrom(tool, await executeQuery(db, op, input, ctx.actor, meta(ctx))) };
    if (tool.autonomy !== 'auto') throw new Error(`${tool.name} waits for the person’s OK`);
    const done = await executeCommand(db, op, input, ctx.actor, meta(ctx));
    return {
      result: { done: true, ...answerFrom(tool, done.output) },
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

/** The card's lines: what it does, then what it would be given, in the input's own order. */
function cardFields(tool: AddonAiTool, values: Args): Field[] {
  const given = Object.keys(tool.input.shape)
    .map((key) => ({ label: labelOf(key), value: valueOf(values[key]) }))
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
 * own schema — refinements and all — checks the arguments first, so a card that could only fail is never drawn.
 */
export function prepareAddonTool(
  tool: AddonAiTool,
  args: Args,
  ctx: ToolContext,
  toolCallId: string,
): PreparedAction {
  if (tool.op.kind !== 'command') throw new Error(`${tool.name} is a look-up`);
  const checked = tool.op.input.safeParse(addonOperationInput(tool, args, ctx));
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    throw HfosError.validation(issues, issues[0]?.message ?? 'Some fields need attention.');
  }
  const shown = tool.input.safeParse(args);
  return {
    card: settingsCard(toolCallId, tool.name, {
      title: `Do this in ${tool.addonName}?`,
      fields: cardFields(tool, shown.success ? (shown.data as Args) : args),
      confirmLabel: 'Confirm',
    }),
    result: { waiting: true, addon: tool.addonName, what: tool.description },
  };
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
  try {
    await executeCommand(db, op, addonOperationInput(tool, args, ctx), ctx.actor, meta(ctx));
  } catch (e) {
    throw saidPlainly(tool, e);
  }
  return { outcome: `Done in ${tool.addonName}`, href: null, command: op.name };
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
