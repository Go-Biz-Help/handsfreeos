/**
 * The AI teammate's add-on tools (round seven, step 5; Chris 2026-10-05: answer from their deal, ask before acting).
 *
 * - A look-up runs the add-on's portal query as the customer in this run's conversation: the kernel reads it as
 *   `portal_actor`, and the database finds the customer from the run, only while it's answering. What it finds goes
 *   with the knowledge the reply's safety check reads, so the numbers in it may be said back.
 * - An ask changes nothing: once the record it names is checked to be the customer's and its input to be one the
 *   command takes, it's held, and the finish makes an approval for someone who works that record (run.ts).
 */
import { createHash } from 'node:crypto';
import {
  ASK_MESSAGE_KEY,
  ASK_SUMMARY_KEY,
  executeQuery,
  HfosError,
  type CustomerActor,
  type QueryDef,
  type TeammateAddonTool,
} from '@hfos/core/server';
import { asCustomerTeammate, rows, sql } from '@hfos/db/client';
import { toolErrorContent } from '../ai/tool-loop';
import type { ExecutorDeps, FoundItem } from './tools';

/** The most of a look-up's answer kept for the reply's safety check. */
const FOUND_MAX = 8_000;
/** The most asks one run makes: each is a person's time. */
export const ASKS_MAX = 3;

/** What the teammate asks a person on the customer's team to do (an `ask` draft at the finish). */
export interface AddonAsk {
  readonly addonId: string;
  readonly addonName: string;
  readonly operation: string;
  readonly tool: string;
  /** The operation's input without the business's ids. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly recordId: string;
  readonly summary: string;
  /** Sent to the customer once a person OKs it; null sends nothing. */
  readonly message: string | null;
}

export interface AddonOutcome {
  readonly status: 'done' | 'held' | 'refused' | 'failed';
  readonly content: unknown;
  readonly found?: FoundItem;
  readonly ask?: AddonAsk;
  readonly command?: string | null;
  readonly error?: string | null;
}

const refused = (error: string, extra: Record<string, unknown> = {}): AddonOutcome => ({
  status: 'refused',
  content: { error, ...extra },
  error,
});

/** The operation's input: the model's arguments, then the business's ids on top. */
function operationInput(
  tool: TeammateAddonTool,
  args: Readonly<Record<string, unknown>>,
  d: ExecutorDeps,
): Record<string, unknown> {
  return {
    ...args,
    workspaceId: d.scope.workspaceId,
    ...(tool.scope.includes('organizationId') ? { organizationId: d.scope.organizationId } : {}),
  };
}

/** Runs one of an add-on's tools for this run's customer. `args` already passed the tool's own input. */
export async function runAddonTool(
  d: ExecutorDeps,
  tool: TeammateAddonTool,
  args: Readonly<Record<string, unknown>>,
  asksSoFar: number,
): Promise<AddonOutcome> {
  const personId = d.rc.conversation.personId;
  if (!personId || d.rc.unverifiedChat)
    return refused(
      'There’s no customer on file here whose things you can see. Answer from what you know, or hand off.',
    );
  const actor: CustomerActor = {
    type: 'customer',
    workspaceId: d.scope.workspaceId,
    organizationId: d.scope.organizationId,
    personId,
    sessionId: null,
    teammateRunId: d.runId,
  };
  try {
    if (tool.use === 'lookup') {
      const input = operationInput(tool, args, d);
      const result = await executeQuery(d.db, tool.op as QueryDef, input, actor, d.meta);
      const key = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
      return {
        status: 'done',
        content: result,
        command: tool.op.name,
        found: {
          id: `addon:${tool.name}:${key}`,
          title: `${tool.addonName}: what their portal shows`,
          body: JSON.stringify(result).slice(0, FOUND_MAX),
        },
      };
    }
    if (asksSoFar >= ASKS_MAX)
      return refused(
        `You’ve asked for ${ASKS_MAX} things in this reply already. Tell them a person will follow up on the rest.`,
      );
    const {
      [ASK_SUMMARY_KEY]: summary,
      [ASK_MESSAGE_KEY]: message,
      ...opArgs
    } = args as Record<string, unknown>;
    const recordId = tool.record ? opArgs[tool.record] : null;
    if (typeof recordId !== 'string')
      return refused('Say which of theirs this is for. Look it up first.');
    // Only one of theirs: the same check their portal makes, as them.
    const [theirs] = await asCustomerTeammate(d.db, d.runId, (tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from app.custom_records where id = ${recordId}::uuid and archived_at is null`,
      ),
    );
    if (!theirs)
      return refused(
        'That isn’t one of theirs. Look up what they have first, and ask only about one of those.',
      );
    const checked = tool.op.input.safeParse(operationInput(tool, opArgs, d));
    if (!checked.success)
      return refused('Invalid input', {
        issues: checked.error.issues.map(
          (i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`,
        ),
      });
    return {
      status: 'held',
      command: tool.op.name,
      content: {
        held: true,
        note: 'Asked. A person on their team OKs it before it happens: tell them you’ve asked, never that it’s done.',
      },
      ask: {
        addonId: tool.addonId,
        addonName: tool.addonName,
        operation: tool.op.name,
        tool: tool.name,
        input: opArgs,
        recordId,
        summary: String(summary),
        message: typeof message === 'string' && message.trim() ? message.trim() : null,
      },
    };
  } catch (e) {
    if (e instanceof HfosError)
      return { status: 'refused', content: toolErrorContent(e), error: e.message };
    throw e;
  }
}
