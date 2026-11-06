/**
 * The screens' own queries as the Assistant's look-ups (packages/core/src/assistant/screen-reads.ts): each runs as
 * the person, through the kernel, with the business's ids put on after the model's arguments, and answers with what
 * the screen would show, cut short when it is too long to read.
 */
import {
  addonToolArguments,
  executeQuery,
  registry,
  screenReadTools,
  videoCallGet,
  type Permission,
  type ScreenReadTool,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { ToolContext, ToolOutcome } from './runtime';

/** The most of an answer, in characters of JSON, the model reads whole. */
const MOST = 16_000;

let derived: ScreenReadTool[] | null = null;
/** Every one, from the registry, made once. */
export const allScreenReadTools = (): readonly ScreenReadTool[] =>
  (derived ??= screenReadTools(registry));

/** The ones a person may use: those their permissions allow, as the screens are. */
export const screenReadToolsFor = (can: (permission: Permission) => boolean): ScreenReadTool[] =>
  allScreenReadTools().filter((t) => can(t.permission));

/**
 * A video call's answer, with the address the team joins it at: the screen's Join opens it. The customer's own link
 * is kept only as a hash, so it never can be.
 */
function withJoin(data: unknown, webUrl: string): unknown {
  const call = (data as { call?: { id?: unknown } | null } | null)?.call;
  if (!webUrl || !call || typeof call.id !== 'string') return data;
  return { ...(data as object), join: `${webUrl}/call/${call.id}` };
}

export async function runScreenRead(
  db: Db,
  tool: ScreenReadTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
  /** The web app's address, for the join address a video call's answer adds. */
  webUrl = '',
): Promise<ToolOutcome> {
  const input = {
    ...addonToolArguments(tool, args),
    ...(tool.scope.includes('workspaceId') ? { workspaceId: ctx.workspaceId } : {}),
    ...(tool.scope.includes('organizationId') ? { organizationId: ctx.organizationId } : {}),
  };
  const got = await executeQuery(db, tool.query, input, ctx.actor, {
    correlationId: ctx.correlationId,
    channel: 'assistant',
  });
  const data = tool.query.name === videoCallGet.name ? withJoin(got, webUrl) : got;
  const json = JSON.stringify(data ?? null);
  return {
    result:
      json.length <= MOST
        ? { data }
        : {
            data: `${json.slice(0, MOST)}…`,
            cutShort: true,
            note: 'That was too long to read whole: ask it for less (a smaller page, a narrower search).',
          },
  };
}

/** What the panel says while one runs. */
export const screenReadStep = (tool: ScreenReadTool) =>
  `Looking at ${tool.query.name.split('.')[0]!.replace(/_/g, ' ')}`;
