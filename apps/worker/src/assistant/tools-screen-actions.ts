/**
 * The screens' own commands as the Assistant's tools (packages/core/src/assistant/screen-actions.ts): each runs as
 * the person, through the kernel, with the business's ids put on after the model's arguments. A change waits on a
 * card drawn from what it would be given, after the command is tried and rolled back, so a card its rules would
 * refuse now is never drawn; on Confirm it runs with the arguments the card was drawn from.
 */
import {
  addonToolArguments,
  executeCommand,
  HfosError,
  registry,
  rehearseCommand,
  screenActionTools,
  type Permission,
  type RequestMeta,
  type ScreenActionTool,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { CommittedAction, PreparedAction, ToolContext, ToolOutcome } from './runtime';
import { cardFields } from './tools-addons';
import { settingsCard } from './tools-settings-calendar';

type Args = Record<string, unknown>;

/** The most of an answer, in characters of JSON, the model reads whole. */
const MOST = 16_000;

let derived: ScreenActionTool[] | null = null;
/** Every one, from the registry, made once. */
export const allScreenActionTools = (): readonly ScreenActionTool[] =>
  (derived ??= screenActionTools(registry));

/** The ones a person may use: those their permissions allow, as the screens are; a staff one only for staff. */
export const screenActionToolsFor = (
  can: (permission: Permission) => boolean,
): ScreenActionTool[] => allScreenActionTools().filter((t) => can(t.permission));

const meta = (ctx: ToolContext): RequestMeta => ({
  correlationId: ctx.correlationId,
  channel: 'assistant',
});

/** The command's input for one call: the arguments, then the business's ids on top (audit AI-3). */
function inputOf(tool: ScreenActionTool, args: Args, ctx: ToolContext): Args {
  return {
    ...addonToolArguments(tool, args),
    ...(tool.scope.includes('workspaceId') ? { workspaceId: ctx.workspaceId } : {}),
    ...(tool.scope.includes('organizationId') ? { organizationId: ctx.organizationId } : {}),
  };
}

/** What the model reads back: the command's answer, cut short when it is too long to read. */
function answerOf(output: unknown): Args {
  const json = JSON.stringify(output ?? null);
  return json.length <= MOST
    ? { data: output ?? null }
    : {
        data: `${json.slice(0, MOST)}…`,
        cutShort: true,
        note: 'That was too long to read whole.',
      };
}

/** A change of risk 0 (setting a note aside, marking a notification opened): through the kernel, now. */
export async function runScreenAction(
  db: Db,
  tool: ScreenActionTool,
  args: Args,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (tool.autonomy !== 'auto') throw new Error(`${tool.name} waits for the person’s OK`);
  const done = await executeCommand(
    db,
    tool.command,
    inputOf(tool, args, ctx),
    ctx.actor,
    meta(ctx),
  );
  return {
    result: { done: true, ...answerOf(done.output) },
    command: tool.command.name,
    record: { outcome: 'Done', command: tool.command.name },
  };
}

/**
 * A change that waits for the person's OK: a card saying what it does and what it would be given, with its warning
 * when it costs something or can't be taken back. The command's own schema checks the arguments first, then it is
 * tried and rolled back.
 */
export async function prepareScreenAction(
  db: Db,
  tool: ScreenActionTool,
  args: Args,
  ctx: ToolContext,
  toolCallId: string,
): Promise<PreparedAction> {
  const input = inputOf(tool, args, ctx);
  const checked = tool.command.input.safeParse(input);
  if (!checked.success) {
    const issues = checked.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    throw HfosError.validation(
      issues,
      issues[0]?.message ??
        `Some of that doesn’t fit what this takes. Check the details and call ${tool.name} again.`,
    );
  }
  await rehearseCommand(db, tool.command, input, ctx.actor, meta(ctx));
  const shown = tool.input.safeParse(args);
  return {
    card: settingsCard(toolCallId, tool.name, {
      title: 'Do this?',
      fields: cardFields(tool, shown.success ? (shown.data as Args) : args),
      confirmLabel: 'Confirm',
      warnings: tool.warning ? [{ kind: 'caution', text: tool.warning }] : [],
    }),
    result: { waiting: true, what: tool.description },
  };
}

/** The person pressed Confirm: the command runs through the kernel, which checks the permission again. */
export async function commitScreenAction(
  db: Db,
  tool: ScreenActionTool,
  args: Args,
  ctx: ToolContext,
): Promise<CommittedAction> {
  await executeCommand(db, tool.command, inputOf(tool, args, ctx), ctx.actor, meta(ctx));
  return { outcome: 'Done', href: null, command: tool.command.name };
}

/** What the panel says while one runs. */
export const screenActionStep = (tool: ScreenActionTool) =>
  tool.autonomy === 'auto' ? 'Working on it' : 'Preparing it for your OK';
