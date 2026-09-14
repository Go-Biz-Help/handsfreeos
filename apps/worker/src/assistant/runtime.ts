import { randomUUID } from 'node:crypto';
import {
  addUsage,
  AiProviderError,
  emptyUsage,
  type AiContent,
  type AiMessage,
  type AiProvider,
  type AiUsage,
} from '@hfos/ai';
import {
  HfosError,
  toolInputSchema,
  type AssistantCard,
  type AssistantEvent,
  type AssistantTool,
  type HumanActor,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { contextText, SYSTEM, type PromptContext } from './prompt';
import * as store from './store';

/** One question never runs more tool rounds than this; the answer says it stopped short. */
const MAX_ROUNDS = 8;

export interface ToolContext {
  readonly actor: HumanActor;
  readonly workspaceId: string;
  readonly organizationId: string;
  /** Every command the run makes shares it, so the audit log and live updates tie back to the run. */
  readonly correlationId: string;
  readonly timezone: string;
}

export interface ToolOutcome {
  /** What the model reads back: compact, with anything a customer wrote wrapped as quoted data. */
  readonly result: unknown;
  readonly isError?: boolean;
  /** A card for the panel; a "done" card gets its tool call id from the runtime. */
  readonly card?: AssistantCard | null;
  /** More cards after it (a customer's next appointment, today's tasks after its appointments). */
  readonly cards?: readonly AssistantCard[];
  readonly command?: string | null;
  /** Kept with the tool call: a sentence and a link for the panel, and what Undo needs. */
  readonly record?: Record<string, unknown>;
}

export interface PreparedAction {
  readonly card: AssistantCard;
  /** What the model is told about the card it caused. */
  readonly result: unknown;
}

export interface CommittedAction {
  readonly outcome: string;
  readonly href: string | null;
  readonly command: string;
}

/** The Assistant's hands: runs "auto" tools, drafts "confirm" tools as cards, and does them once confirmed. */
export interface ToolExecutor {
  run(tool: AssistantTool, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
  prepare(
    tool: AssistantTool,
    args: Record<string, unknown>,
    ctx: ToolContext,
    toolCallId: string,
  ): Promise<PreparedAction>;
  commit(
    tool: AssistantTool,
    args: Record<string, unknown>,
    ctx: ToolContext,
    extra: { readonly lostReason?: string; readonly toolCallId: string },
  ): Promise<CommittedAction>;
  undo(tool: AssistantTool, record: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface RuntimeDeps {
  readonly db: Db;
  readonly provider: AiProvider;
  readonly tools: ToolExecutor;
  readonly dailyTokens: number;
  readonly log: Logger;
}

export interface AskInput {
  readonly actor: HumanActor;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly threadId?: string;
  readonly text: string;
  readonly page: { readonly type: string; readonly id: string } | null;
  /** The tools this person may use (their role's permissions). */
  readonly tools: readonly AssistantTool[];
  readonly prompt: PromptContext;
}

const STEP_LABEL: Record<string, string> = {
  search_customers: 'Searching customers',
  get_customer: 'Looking at the customer',
  list_leads: 'Looking at leads',
  get_lead: 'Looking at the lead',
  business_numbers: 'Counting',
  what_needs_attention: 'Checking what’s waiting',
  list_tasks: 'Looking at tasks',
  todays_schedule: 'Looking at today',
  find_availability: 'Checking open times',
  get_conversation: 'Reading the conversation',
  list_inbox: 'Checking the inbox',
  list_team: 'Looking up the team',
  call_customer: 'Getting the number',
  create_task: 'Adding the task',
  update_task: 'Changing the task',
  complete_task: 'Completing the task',
  add_note: 'Adding the note',
  list_workflows: 'Looking at workflows',
  draft_workflow: 'Drafting the workflow',
  search_knowledge: 'Searching your knowledge base',
};
const stepLabel = (tool: string) => STEP_LABEL[tool] ?? 'Preparing it for your OK';

/** An error a tool hit, in words the model can pass on (never a stack or SQL). */
function toolError(e: unknown): { error: string; rule?: string } {
  if (e instanceof HfosError) return { error: e.message, ...(e.rule ? { rule: e.rule } : {}) };
  return { error: 'That didn’t work. Nothing was changed.' };
}

/** The thread so far as model messages: what was said, and what each answer did, as short notes. */
function modelMessages(history: readonly store.HistoryItem[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const h of history) {
    if (h.role === 'user') {
      out.push({ role: 'user', content: h.text });
      continue;
    }
    const notes = h.actions.map(
      (a) => `${a.tool}: ${a.status}${a.result ? ` ${JSON.stringify(a.result)}` : ''}`,
    );
    const text = [h.text, notes.length ? `(What I did: ${notes.join('; ')})` : '']
      .filter(Boolean)
      .join('\n');
    if (text) out.push({ role: 'assistant', content: text });
  }
  // The API wants turns to alternate, starting with the person.
  return out.filter((m, i) => i === 0 || m.role !== out[i - 1]!.role || m.role === 'user');
}

/**
 * Answers one question: streams text and cards through `emit`, runs "auto" tools as the person,
 * leaves "confirm" tools waiting as cards, and saves the answer and the run's token use.
 */
export async function ask(
  deps: RuntimeDeps,
  input: AskInput,
  emit: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const scope = { workspaceId: input.workspaceId, organizationId: input.organizationId };
  if ((await store.tokensToday(deps.db, scope, input.prompt.timezone)) >= deps.dailyTokens) {
    emit({
      type: 'error',
      code: 'budget_reached',
      message: 'That’s today’s Assistant limit for this business. It resets at midnight.',
    });
    return;
  }
  if (input.threadId) await store.expireWaiting(deps.db, scope, input.threadId);
  const correlationId = randomUUID();
  const run = await store.startRun(deps.db, scope, {
    userId: input.actor.userId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    question: input.text,
    context: { page: input.page },
    model: deps.provider.model,
    correlationId,
  });
  emit({ type: 'run', runId: run.runId, threadId: run.threadId });

  const ctx: ToolContext = {
    actor: input.actor,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    correlationId,
    timezone: input.prompt.timezone,
  };
  const offered = new Map(input.tools.map((t) => [t.name, t]));
  const toolDefs = input.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toolInputSchema(t),
  }));
  const messages = modelMessages(await store.history(deps.db, scope, run.threadId));
  const cards: AssistantCard[] = [];
  let text = '';
  let usage: AiUsage = emptyUsage;
  let rounds = 0;

  try {
    for (;;) {
      const turn = await deps.provider.stream(
        {
          system: SYSTEM,
          context: contextText(input.prompt),
          messages,
          tools: toolDefs,
          maxTokens: 2048,
        },
        {
          signal,
          onText: (delta) => {
            text += delta;
            emit({ type: 'text', delta });
          },
        },
      );
      usage = addUsage(usage, turn.usage);
      if (turn.stopReason !== 'tool_use' || turn.toolCalls.length === 0) break;
      if (++rounds > MAX_ROUNDS) {
        const note =
          '\n\nThat took more steps than I can take in one go. Ask again with a smaller piece of it.';
        text += note;
        emit({ type: 'text', delta: note });
        break;
      }
      const callBlocks: AiContent[] = turn.toolCalls.map((c) => ({
        type: 'tool_call',
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));
      messages.push({
        role: 'assistant',
        content: turn.text ? [{ type: 'text', text: turn.text }, ...callBlocks] : callBlocks,
      });
      const results: AiContent[] = [];
      for (const call of turn.toolCalls) {
        const answer = (content: unknown, isError = false) =>
          results.push({
            type: 'tool_result',
            callId: call.id,
            content: JSON.stringify(content),
            isError,
          });
        const tool = offered.get(call.name);
        if (!tool) {
          answer({ error: 'That is not something you can do here.' }, true);
          continue;
        }
        const parsed = tool.input.safeParse(call.arguments);
        if (!parsed.success) {
          const issues = parsed.error.issues.map(
            (i: { path: PropertyKey[]; message: string }) =>
              `${i.path.map(String).join('.')}: ${i.message}`,
          );
          answer({ error: 'Invalid input', issues }, true);
          continue;
        }
        const args = parsed.data as Record<string, unknown>;
        emit({ type: 'step', id: call.id, label: stepLabel(tool.name), status: 'running' });
        const base = {
          userId: input.actor.userId,
          threadId: run.threadId,
          runId: run.runId,
          providerCallId: call.id,
          tool: tool.name,
          arguments: args,
          autonomy: tool.autonomy,
          correlationId,
        };
        try {
          if (tool.autonomy === 'confirm') {
            const id = await store.recordToolCall(deps.db, scope, {
              ...base,
              status: 'awaiting_confirmation',
            });
            const prepared = await deps.tools.prepare(tool, args, ctx, id);
            cards.push(prepared.card);
            emit({ type: 'card', card: prepared.card });
            answer({ status: 'waiting_for_the_person_to_confirm', ...(prepared.result as object) });
          } else {
            const out = await deps.tools.run(tool, args, ctx);
            const id = await store.recordToolCall(deps.db, scope, {
              ...base,
              status: out.isError ? 'failed' : 'done',
              result: out.record ?? null,
              command: out.command ?? null,
            });
            for (const shown of [out.card, ...(out.cards ?? [])]) {
              if (!shown) continue;
              const card = shown.type === 'done' ? { ...shown, toolCallId: id } : shown;
              cards.push(card);
              emit({ type: 'card', card });
            }
            answer(out.result, !!out.isError);
          }
          emit({ type: 'step', id: call.id, label: stepLabel(tool.name), status: 'done' });
        } catch (e) {
          if (e instanceof AiProviderError) throw e;
          deps.log.warn({ err: e, tool: tool.name, runId: run.runId }, 'assistant tool failed');
          await store.recordToolCall(deps.db, scope, {
            ...base,
            status: 'failed',
            error: toolError(e).error,
          });
          emit({ type: 'step', id: call.id, label: stepLabel(tool.name), status: 'failed' });
          answer(toolError(e), true);
        }
      }
      messages.push({ role: 'user', content: results });
    }
    const messageId = await store.saveAnswer(deps.db, scope, {
      userId: input.actor.userId,
      threadId: run.threadId,
      runId: run.runId,
      text,
      cards,
    });
    await store.finishRun(deps.db, scope, run.runId, { status: 'done', usage, toolRounds: rounds });
    emit({ type: 'done', messageId });
  } catch (e) {
    const stopped = e instanceof AiProviderError && e.code === 'aborted';
    const busy = e instanceof AiProviderError && e.retryable;
    if (!stopped) deps.log.error({ err: e, runId: run.runId }, 'assistant run failed');
    const said = stopped ? 'Stopped.' : 'Something went wrong before I finished.';
    await store.saveAnswer(deps.db, scope, {
      userId: input.actor.userId,
      threadId: run.threadId,
      runId: run.runId,
      text: text ? `${text}\n\n${said}` : said,
      cards,
    });
    await store.finishRun(deps.db, scope, run.runId, {
      status: stopped ? 'cancelled' : 'failed',
      usage,
      toolRounds: rounds,
      error: e instanceof Error ? e.message : String(e),
    });
    emit({
      type: 'error',
      code: stopped ? 'stopped' : busy ? 'busy' : 'failed',
      message: stopped
        ? 'Stopped. Anything that needs your OK did not happen.'
        : busy
          ? 'The Assistant is busy right now. Try again in a minute.'
          : 'Something went wrong. Try again.',
    });
  }
}
