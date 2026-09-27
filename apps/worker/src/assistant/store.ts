import { HfosError, uuidArray } from '@hfos/core/server';
import { asWorker, rows, sql, type Db } from '@hfos/db/client';
import type { AiUsage } from '@hfos/ai';
import { aiBudget } from '../ai/budget';

/** The worker's writes for the Assistant: threads, runs, messages and tool calls, inside one workspace. */
export interface Scope {
  readonly workspaceId: string;
  readonly organizationId: string;
}

export interface StartedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly correlationId: string;
}

const title = (question: string) => {
  const t = question.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
};

/** Opens (or continues) a thread, starts a run and saves the question. One run per person at a time. */
export async function startRun(
  db: Db,
  scope: Scope,
  input: {
    readonly userId: string;
    readonly threadId?: string;
    readonly question: string;
    readonly context: Record<string, unknown>;
    readonly model: string;
    readonly correlationId: string;
  },
): Promise<StartedRun> {
  return asWorker(db, scope, async (tx) => {
    // A run a crash left behind would block the person forever.
    await tx.execute(sql`update app.assistant_runs set status = 'failed', error = 'Interrupted', ended_at = now()
      where user_id = ${input.userId} and status = 'running' and started_at < now() - interval '5 minutes'`);
    let threadId: string | undefined;
    if (input.threadId) {
      const [t] = await rows<{ id: string }>(
        tx,
        sql`select id from app.assistant_threads where id = ${input.threadId} and user_id = ${input.userId}
              and workspace_id = ${scope.workspaceId} and archived_at is null`,
      );
      if (!t) throw HfosError.notFound('That chat is gone. Start a new one.');
      threadId = t.id;
    } else {
      const [t] = await rows<{ id: string }>(
        tx,
        sql`insert into app.assistant_threads (workspace_id, user_id, title)
            values (${scope.workspaceId}, ${input.userId}, ${title(input.question)}) returning id`,
      );
      threadId = t!.id;
    }
    const running = await rows<{ id: string }>(
      tx,
      sql`select id from app.assistant_runs where user_id = ${input.userId} and status = 'running'`,
    );
    if (running.length)
      throw HfosError.conflict(
        'The Assistant is still answering your last question.',
        'already_running',
      );
    const [run] = await rows<{ id: string }>(
      tx,
      sql`insert into app.assistant_runs (workspace_id, user_id, thread_id, model, correlation_id)
          values (${scope.workspaceId}, ${input.userId}, ${threadId}, ${input.model}, ${input.correlationId}) returning id`,
    );
    await tx.execute(sql`insert into app.assistant_messages (workspace_id, user_id, thread_id, role, text, context, run_id)
      values (${scope.workspaceId}, ${input.userId}, ${threadId}, 'user', ${input.question},
              ${JSON.stringify(input.context)}::jsonb, ${run!.id})`);
    await tx.execute(
      sql`update app.assistant_threads set last_message_at = now() where id = ${threadId}`,
    );
    return { runId: run!.id, threadId, correlationId: input.correlationId };
  });
}

export async function finishRun(
  db: Db,
  scope: Scope,
  runId: string,
  end: {
    readonly status: 'done' | 'failed' | 'cancelled';
    readonly usage: AiUsage;
    readonly toolRounds: number;
    readonly error?: string | null;
  },
): Promise<void> {
  await asWorker(db, scope, (tx) =>
    tx.execute(sql`update app.assistant_runs set status = ${end.status}, ended_at = now(),
      input_tokens = ${end.usage.inputTokens}, output_tokens = ${end.usage.outputTokens},
      cache_read_tokens = ${end.usage.cacheReadTokens}, cache_write_tokens = ${end.usage.cacheWriteTokens},
      tool_rounds = ${end.toolRounds}, error = ${end.error ? end.error.slice(0, 2000) : null}
      where id = ${runId}`),
  );
}

/**
 * Adds one model call's tokens to a run still going, so the daily limit counts them before the run ends (the
 * business's other questions, and this one's next call, see them). finishRun then writes the run's total.
 */
export async function addRunUsage(
  db: Db,
  scope: Scope,
  runId: string,
  usage: AiUsage,
): Promise<void> {
  await asWorker(db, scope, (tx) =>
    tx.execute(sql`update app.assistant_runs set
      input_tokens = input_tokens + ${usage.inputTokens}, output_tokens = output_tokens + ${usage.outputTokens},
      cache_read_tokens = cache_read_tokens + ${usage.cacheReadTokens},
      cache_write_tokens = cache_write_tokens + ${usage.cacheWriteTokens}
      where id = ${runId}`),
  );
}

export async function saveAnswer(
  db: Db,
  scope: Scope,
  input: {
    readonly userId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly text: string;
    readonly cards: readonly unknown[];
  },
): Promise<string> {
  return asWorker(db, scope, async (tx) => {
    const [m] = await rows<{ id: string }>(
      tx,
      sql`insert into app.assistant_messages (workspace_id, user_id, thread_id, role, text, cards, run_id)
          values (${scope.workspaceId}, ${input.userId}, ${input.threadId}, 'assistant', ${input.text.slice(0, 20000)},
                  ${JSON.stringify(input.cards)}::jsonb, ${input.runId}) returning id`,
    );
    await tx.execute(
      sql`update app.assistant_threads set last_message_at = now() where id = ${input.threadId}`,
    );
    return m!.id;
  });
}

export interface ToolCallRow {
  readonly id: string;
  readonly user_id: string;
  readonly thread_id: string;
  readonly run_id: string;
  readonly provider_call_id: string | null;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly autonomy: 'auto' | 'confirm';
  readonly status: string;
  readonly result: Record<string, unknown> | null;
  readonly error: string | null;
}

export async function recordToolCall(
  db: Db,
  scope: Scope,
  input: {
    readonly userId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly providerCallId: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
    readonly autonomy: 'auto' | 'confirm';
    readonly status: string;
    readonly result?: unknown;
    readonly error?: string | null;
    readonly command?: string | null;
    readonly correlationId: string;
  },
): Promise<string> {
  const [row] = await asWorker(db, scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.assistant_tool_calls (workspace_id, user_id, thread_id, run_id, provider_call_id, tool,
            arguments, autonomy, status, result, error, command, correlation_id)
          values (${scope.workspaceId}, ${input.userId}, ${input.threadId}, ${input.runId}, ${input.providerCallId},
            ${input.tool}, ${JSON.stringify(input.arguments)}::jsonb, ${input.autonomy}, ${input.status},
            ${input.result == null ? null : JSON.stringify(input.result)}::jsonb, ${input.error ?? null},
            ${input.command ?? null}, ${input.correlationId})
          returning id`,
    ),
  );
  return row!.id;
}

export async function updateToolCall(
  db: Db,
  scope: Scope,
  id: string,
  patch: {
    readonly status: string;
    readonly result?: unknown;
    readonly error?: string | null;
    readonly confirmed?: boolean;
  },
): Promise<void> {
  await asWorker(db, scope, (tx) =>
    tx.execute(sql`update app.assistant_tool_calls set status = ${patch.status},
      result = coalesce(${patch.result == null ? null : JSON.stringify(patch.result)}::jsonb, result),
      error = ${patch.error ?? null},
      confirmed_at = case when ${!!patch.confirmed} then now() else confirmed_at end
      where id = ${id}`),
  );
}

export async function getToolCall(db: Db, scope: Scope, id: string): Promise<ToolCallRow | null> {
  const [row] = await asWorker(db, scope, (tx) =>
    rows<ToolCallRow & Record<string, unknown>>(
      tx,
      sql`select id, user_id, thread_id, run_id, provider_call_id, tool, arguments, autonomy, status, result, error
          from app.assistant_tool_calls where id = ${id} and workspace_id = ${scope.workspaceId}`,
    ),
  );
  return row ?? null;
}

/** Moves a waiting card to its answer, once: a double click or a second tab finds it already answered. */
export async function claimToolCall(
  db: Db,
  scope: Scope,
  id: string,
  to: 'confirmed' | 'cancelled',
): Promise<boolean> {
  const claimed = await asWorker(db, scope, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`update app.assistant_tool_calls set status = ${to},
            confirmed_at = case when ${to} = 'confirmed' then now() else confirmed_at end
          where id = ${id} and status = 'awaiting_confirmation' returning id`,
    ),
  );
  return claimed.length === 1;
}

/** Cards left waiting when the person asks something else lapse: nothing they didn't OK ever runs. */
export async function expireWaiting(db: Db, scope: Scope, threadId: string): Promise<void> {
  await asWorker(db, scope, (tx) =>
    tx.execute(sql`update app.assistant_tool_calls set status = 'expired'
      where thread_id = ${threadId} and status = 'awaiting_confirmation'`),
  );
}

/**
 * Every AI token the workspace used today, in its own time zone: the Assistant's runs plus workflow AI
 * steps, the AI builder and the knowledge base (app.ai_usage). One limit per workspace.
 */
export async function tokensToday(db: Db, scope: Scope, timezone: string): Promise<number> {
  return aiBudget.usedToday(db, scope, timezone);
}

export interface HistoryItem {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly actions: readonly {
    readonly tool: string;
    readonly status: string;
    readonly result: unknown;
  }[];
}

/** The thread so far for the model: what was said, plus what each answer did (compact, newest last). */
export async function history(
  db: Db,
  scope: Scope,
  threadId: string,
  limit = 20,
): Promise<HistoryItem[]> {
  return asWorker(db, scope, async (tx) => {
    const msgs = await rows<{ role: 'user' | 'assistant'; text: string; run_id: string | null }>(
      tx,
      sql`select role, text, run_id from (
            select role, text, run_id, created_at, id from app.assistant_messages
            where thread_id = ${threadId} order by created_at desc, id desc limit ${limit}
          ) m order by created_at, id`,
    );
    // Only the runs of the messages read, found by the run index (thread_id has none): a long thread's older
    // tool calls are never loaded.
    const runIds = [
      ...new Set(msgs.flatMap((m) => (m.role === 'assistant' && m.run_id ? [m.run_id] : []))),
    ];
    const calls = runIds.length
      ? await rows<{ run_id: string; tool: string; status: string; result: unknown }>(
          tx,
          sql`select run_id, tool, status, result from app.assistant_tool_calls
              where run_id = any(${uuidArray(runIds)}) and thread_id = ${threadId}
              order by run_id, created_at`,
        )
      : [];
    return msgs.map((m) => ({
      role: m.role,
      text: m.text,
      actions:
        m.role === 'assistant'
          ? calls
              .filter((c) => c.run_id === m.run_id)
              .map((c) => ({ tool: c.tool, status: c.status, result: c.result }))
          : [],
    }));
  });
}
