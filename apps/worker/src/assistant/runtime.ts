import { randomUUID } from 'node:crypto';
import {
  AiProviderError,
  emptyUsage,
  totalTokens,
  type AiFirstBlock,
  type AiMessage,
  type AiProvider,
  type AiToolCall,
  type AiToolDefinition,
  type AiUsage,
} from '@hfos/ai';
import {
  addonToolArguments,
  addonToolDescription,
  isAddonAiTool,
  toolInputSchema,
  type AddonAiTool,
  type AssistantCard,
  type AssistantEvent,
  type AssistantTool,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, type Db } from '@hfos/db/client';
import type { Logger } from 'pino';
import { recordAiUsage } from '../ai/budget';
import { runToolLoop, toolErrorContent, type ToolLoopAnswer } from '../ai/tool-loop';
import {
  alwaysLoaded,
  lastingText,
  SYSTEM,
  TOOL_SEARCH_NOTE,
  turnText,
  type PromptContext,
} from './prompt';
import * as store from './store';
import {
  addonActionStep,
  addonStepLabels,
  addonToolStep,
  isAddonActionTool,
  type AddonActionTool,
} from './tools-addons';
import { billingStepLabels } from './tools-billing';
import { contentStepLabels } from './tools-content';
import { extraStepLabels } from './tools-extra';
import { inboxCrmStepLabels } from './tools-inbox-crm';
import { schedulingStepLabels } from './tools-scheduling';
import { setupStepLabels } from './tools-setup';

/** One question never runs more tool rounds than this; the answer says it stopped short. */
const MAX_ROUNDS = 8;
/**
 * Per model call. The Assistant's model thinks before every answer and the thinking counts toward this, so it
 * is sized for that as well as a short reply and a round of tool calls.
 */
const MAX_TOKENS = 16_000;

const BUDGET_REACHED = 'That’s today’s Assistant limit for this business. It resets at midnight.';

/**
 * How hard it thinks once a question turns into a change (it starts at ASSISTANT_EFFORT): reading the setup before
 * changing it, or fixing a change the checks refused. A big step up from `low` is what moves the model.
 */
const CAREFUL_EFFORT = 'high';
/** The look-up the instructions say to make before any change to the setup, saying when it's for one. */
const readsToChange = (tool: OfferedTool, args: Record<string, unknown>) =>
  tool.name === 'get_settings' && args['toChange'] === true;
/** What the panel shows while it thinks harder, so a longer wait says why. */
const CAREFUL_STEP = {
  id: 'careful',
  label: 'Taking a little longer to get this right',
} as const;

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

/**
 * A tool the Assistant may be offered: one of core's, or one an add-on's operation declares (derived in
 * packages/core/src/addons/ai.ts and run through the one executor in tools-addons.ts).
 */
export type OfferedTool = AssistantTool | AddonAiTool | AddonActionTool;

/** An add-on's tool, an operation's or a worker action's: found by search, its arguments passed on as written. */
const isAddonTool = (tool: OfferedTool): tool is AddonAiTool | AddonActionTool =>
  isAddonAiTool(tool) || isAddonActionTool(tool);

export interface CommittedAction {
  readonly outcome: string;
  readonly href: string | null;
  readonly command: string;
}

/** The Assistant's hands: runs "auto" tools, drafts "confirm" tools as cards, and does them once confirmed. */
export interface ToolExecutor {
  run(tool: OfferedTool, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
  prepare(
    tool: OfferedTool,
    args: Record<string, unknown>,
    ctx: ToolContext,
    toolCallId: string,
  ): Promise<PreparedAction>;
  commit(
    tool: OfferedTool,
    args: Record<string, unknown>,
    ctx: ToolContext,
    extra: { readonly lostReason?: string; readonly toolCallId: string },
  ): Promise<CommittedAction>;
  undo(tool: OfferedTool, record: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /**
   * Whether running the tool only reads, so look-ups the model asks for together run at once. Unset, or false:
   * one at a time.
   */
  reads?(tool: OfferedTool): boolean;
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
  /**
   * The tools this person may use: core's their permissions allow, and those of the add-ons running here whose
   * permission they hold. Nothing else can be called.
   */
  readonly tools: readonly OfferedTool[];
  readonly prompt: PromptContext;
  /** When the question reached the worker (Date.now()), for the timings logged with the answer. */
  readonly receivedAt?: number;
}

/** A tool as the provider is sent it, worked out once per tool rather than on every question. */
const definitions = new WeakMap<OfferedTool, AiToolDefinition>();
function definitionOf(tool: OfferedTool): AiToolDefinition {
  let made = definitions.get(tool);
  if (!made) {
    made = {
      name: tool.name,
      description: isAddonTool(tool) ? addonToolDescription(tool) : tool.description,
      inputSchema: toolInputSchema(tool),
    };
    definitions.set(tool, made);
  }
  return made;
}

/**
 * The fixed instructions and the tools, exactly as every model call of a question sends them, and the warm-up
 * before one: the provider finds its cache only when everything before the question matches. The same tools give
 * the same request, so what a question costs to send doesn't grow with how many tools or add-ons there are: the
 * tools in view stay the same short list, and the rest wait behind tool search.
 */
export function assistantRequest(
  tools: readonly OfferedTool[],
  provider: Pick<AiProvider, 'toolSearch'>,
): { readonly system: string; readonly tools: AiToolDefinition[] } {
  // With tool search, only the tools the instructions name stay loaded; the model finds the rest when needed.
  const searching = provider.toolSearch === true;
  const loaded = alwaysLoaded(tools.filter((t) => !isAddonTool(t)).map((t) => t.name));
  return {
    system: searching ? `${SYSTEM}\n\n${TOOL_SEARCH_NOTE}` : SYSTEM,
    tools: tools.map((t) =>
      // An add-on's tools are always found through search, never loaded up front, so neither the tools in view nor
      // the prompt the provider caches grow with the add-ons a business turns on.
      isAddonTool(t) || (searching && !loaded.has(t.name))
        ? { ...definitionOf(t), deferred: true }
        : definitionOf(t),
    ),
  };
}

const STEP_LABEL: Record<string, string> = {
  search_customers: 'Searching customers',
  get_customer: 'Looking at the customer',
  list_leads: 'Looking at leads',
  get_lead: 'Looking at the lead',
  business_numbers: 'Counting',
  what_needs_attention: 'Checking the Action Center',
  list_tasks: 'Looking at tasks',
  todays_schedule: 'Looking at today',
  find_availability: 'Checking open times',
  get_conversation: 'Reading the conversation',
  list_inbox: 'Checking the inbox',
  recent_calls: 'Looking at the call log',
  list_team: 'Looking up the team',
  call_customer: 'Getting the number',
  create_task: 'Adding the task',
  update_task: 'Changing the task',
  complete_task: 'Completing the task',
  add_note: 'Adding the note',
  list_workflows: 'Looking at workflows',
  draft_workflow: 'Drafting the workflow',
  search_knowledge: 'Searching your knowledge base',
  money_owed: 'Adding up what you are owed',
  money_collected: 'Adding up what has come in',
  customer_money: 'Looking at their money',
  estimates_waiting: 'Looking at estimates out',
  get_settings: 'Looking at how this is set up',
  settings_help: 'Finding where that lives',
  manage_calendar: 'Setting up the calendar',
  manage_service: 'Setting up the service',
  manage_resource: 'Setting up the resource',
  manage_territory: 'Setting up the territory',
  update_booking_site: 'Setting up your booking page',
  update_business: 'Changing the business',
  manage_pipeline: 'Setting up the pipeline',
  manage_team: 'Setting up the team',
  manage_tag: 'Setting up the label',
  update_knowledge_profile: 'Changing what your AI knows',
  update_texting_settings: 'Changing texting and calls',
  manage_phone_number: 'Setting up your number',
  submit_carrier_registration: 'Filling in the registration',
  manage_email_settings: 'Setting up email',
  manage_website_chat: 'Setting up the website chat',
  manage_lead_intake: 'Changing how leads come in',
  update_money_settings: 'Changing how you get paid',
  manage_product: 'Setting up the item',
  manage_payment_account: 'Changing where money lands',
  update_action_center_settings: 'Changing what Home watches for',
  manage_ai_teammate: 'Setting up your AI teammate',
  update_my_account: 'Changing your account',
  update_my_hours: 'Changing your hours',
};
const MORE_STEP_LABELS: Record<string, string> = {
  ...inboxCrmStepLabels,
  ...schedulingStepLabels,
  ...billingStepLabels,
  ...contentStepLabels,
  ...setupStepLabels,
  ...extraStepLabels,
  ...addonStepLabels,
};
const stepLabel = (tool: OfferedTool) =>
  isAddonAiTool(tool)
    ? addonToolStep(tool)
    : isAddonActionTool(tool)
      ? addonActionStep(tool)
      : (STEP_LABEL[tool.name] ?? MORE_STEP_LABELS[tool.name] ?? 'Preparing it for your OK');

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
 * Answers one question on the shared tool loop (ai/tool-loop.ts): streams text and cards through `emit`,
 * runs "auto" tools as the person, leaves "confirm" tools waiting as cards, and saves the answer and the
 * run's token use.
 */
export async function ask(
  deps: RuntimeDeps,
  input: AskInput,
  send: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const clock = stopwatch(input.receivedAt);
  const emit = (event: AssistantEvent) => {
    clock.shown(event);
    send(event);
  };
  const scope = { workspaceId: input.workspaceId, organizationId: input.organizationId };
  const hasRoom = async () =>
    (await store.tokensToday(deps.db, scope, input.prompt.timezone)) < deps.dailyTokens;
  if (!(await hasRoom())) {
    emit({ type: 'error', code: 'budget_reached', message: BUDGET_REACHED });
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
  // What was offered is all that can be called: anything else the model asks for is refused below.
  const offered = new Map<string, OfferedTool>(input.tools.map((t) => [t.name, t]));
  const request = assistantRequest(input.tools, deps.provider);
  const messages = modelMessages(await store.history(deps.db, scope, run.threadId));
  const cards: AssistantCard[] = [];
  // Look-ups asked for together run at once (`reads`), but their cards still go out, and their calls are kept, in
  // the order the model asked: each call holds its place, and waits for the calls before it to show and be kept.
  const places: { cards: readonly AssistantCard[] | null }[] = [];
  let kept: Promise<void> = Promise.resolve();
  const showInOrder = () => {
    while (places[0]?.cards)
      for (const card of places.shift()!.cards!) {
        cards.push(card);
        emit({ type: 'card', card });
      }
  };
  const reads = deps.tools.reads?.bind(deps.tools);
  const together = reads
    ? (call: AiToolCall) => {
        const tool = offered.get(call.name);
        return !!tool && tool.autonomy === 'auto' && reads(tool);
      }
    : undefined;

  const execute = async (call: AiToolCall): Promise<ToolLoopAnswer> => {
    // Its place is taken before anything waits, so places follow the model's order.
    const place: { cards: readonly AssistantCard[] | null } = { cards: null };
    places.push(place);
    const before = kept;
    let keptMine = () => {};
    kept = new Promise((done) => (keptMine = done));
    const keep: typeof store.recordToolCall = async (...row) => {
      await before;
      return store.recordToolCall(...row);
    };
    const shown: AssistantCard[] = [];
    try {
      return await runCall(call, shown, keep);
    } finally {
      keptMine();
      place.cards = shown;
      showInOrder();
    }
  };

  /** One call: "auto" tools run as the person, "confirm" tools wait as cards, errors go back to the model. */
  const runCall = async (
    call: AiToolCall,
    shown: AssistantCard[],
    keep: typeof store.recordToolCall,
  ): Promise<ToolLoopAnswer> => {
    const tool = offered.get(call.name);
    if (!tool)
      return { content: { error: 'That is not something you can do here.' }, isError: true };
    const parsed = tool.input.safeParse(call.arguments);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i: { path: PropertyKey[]; message: string }) =>
          `${i.path.map(String).join('.')}: ${i.message}`,
      );
      // A change the checks refused: the next try wants more care.
      return {
        content: { error: 'Invalid input', issues },
        isError: true,
        harder: tool.autonomy === 'confirm',
      };
    }
    // An add-on's tool hands the operation the model's own arguments (only what the tool declares, never the
    // business's ids): the kernel parses them once, with the operation's schema, when it runs.
    const args = (
      isAddonTool(tool) ? addonToolArguments(tool, call.arguments) : parsed.data
    ) as Record<string, unknown>;
    emit({ type: 'step', id: call.id, label: stepLabel(tool), status: 'running' });
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
      let answer: ToolLoopAnswer;
      if (tool.autonomy === 'confirm') {
        const id = await keep(deps.db, scope, {
          ...base,
          status: 'awaiting_confirmation',
        });
        const prepared = await deps.tools.prepare(tool, args, ctx, id);
        shown.push(prepared.card);
        answer = {
          content: { status: 'waiting_for_the_person_to_confirm', ...(prepared.result as object) },
        };
      } else {
        const out = await deps.tools.run(tool, args, ctx);
        const id = await keep(deps.db, scope, {
          ...base,
          status: out.isError ? 'failed' : 'done',
          result: out.record ?? null,
          command: out.command ?? null,
        });
        for (const card of [out.card, ...(out.cards ?? [])]) {
          if (!card) continue;
          shown.push(card.type === 'done' ? { ...card, toolCallId: id } : card);
        }
        answer = {
          content: out.result,
          isError: !!out.isError,
          // It read the setup to change it: the change comes next.
          harder: readsToChange(tool, args) && !out.isError,
        };
      }
      emit({ type: 'step', id: call.id, label: stepLabel(tool), status: 'done' });
      return answer;
    } catch (e) {
      // A provider error ends the whole run (the loop stops on it).
      if (e instanceof AiProviderError) throw e;
      deps.log.warn({ err: e, tool: tool.name, runId: run.runId }, 'assistant tool failed');
      await keep(deps.db, scope, {
        ...base,
        status: 'failed',
        error: toolErrorContent(e).error,
      });
      emit({ type: 'step', id: call.id, label: stepLabel(tool), status: 'failed' });
      return { content: toolErrorContent(e), isError: true, harder: tool.autonomy === 'confirm' };
    }
  };

  // Thinking harder only where the model can, and only above what it does already.
  const careful = deps.provider.thinksHarderAt?.(CAREFUL_EFFORT) ? CAREFUL_EFFORT : undefined;
  let thoughtHarder = false;
  const thinkHarder = () => {
    thoughtHarder = true;
    emit({ type: 'step', ...CAREFUL_STEP, status: 'running' });
  };

  let text = '';
  let usage: AiUsage = emptyUsage;
  let rounds = 0;
  try {
    const loop = await runToolLoop({
      provider: deps.provider,
      system: request.system,
      lasting: lastingText(input.prompt),
      context: turnText(input.prompt),
      messages,
      tools: request.tools,
      maxRounds: MAX_ROUNDS,
      maxTokens: MAX_TOKENS,
      execute,
      ...(together ? { together } : {}),
      ...(careful ? { thinkHarder: careful, onThinkHarder: thinkHarder } : {}),
      onAsked: clock.asked,
      onStarted: clock.started,
      onText: (delta) => emit({ type: 'text', delta }),
      // Each call's tokens count toward the limit as soon as it ends, and every later call checks the limit
      // again (the first was checked above): a long question, or several people asking at once, stop there.
      onTurnUsage: (turn) => store.addRunUsage(deps.db, scope, run.runId, turn),
      checkBudget: (used) => used.inputTokens + used.outputTokens === 0 || hasRoom(),
      signal,
    });
    ({ text, usage, rounds } = loop);
    if (thoughtHarder) emit({ type: 'step', ...CAREFUL_STEP, status: 'done' });
    // Stop and provider errors end the run the way any failure below does, keeping what already streamed.
    if (loop.stoppedBy === 'aborted' || loop.stoppedBy === 'error') throw loop.error;
    if (loop.stoppedBy === 'budget') {
      const note = `${text ? '\n\n' : ''}${BUDGET_REACHED}`;
      text += note;
      emit({ type: 'text', delta: note });
    }
    if (loop.stoppedBy === 'max_rounds') {
      const note =
        '\n\nThat took more steps than I can take in one go. Ask again with a smaller piece of it.';
      text += note;
      emit({ type: 'text', delta: note });
    }
    // A decline or an answer that ran out of room ends with nothing said; the person still gets words.
    const unsaid =
      loop.lastStop === 'refusal'
        ? 'I can’t help with that one.'
        : loop.lastStop === 'max_tokens'
          ? 'That answer ran too long. Ask again with a smaller piece of it.'
          : null;
    if (unsaid && loop.stoppedBy === 'end_turn') {
      const note = text ? `\n\n${unsaid}` : unsaid;
      text += note;
      emit({ type: 'text', delta: note });
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
  } finally {
    deps.log.info(
      { runId: run.runId, rounds, thoughtHarder, ...clock.read() },
      'assistant timings',
    );
  }
}

/**
 * How long a question took, logged with each answer ("assistant timings") so the speed people see can be read
 * off the logs: from the question reaching the worker (its context is read first) to the first thing shown (a
 * step, a card or the first words), each model call's wait for its first block and what that block was (thinking
 * first is slower), and the whole answer.
 */
function stopwatch(receivedAt = Date.now()) {
  let firstShownMs: number | null = null;
  const asked = new Map<number, number>();
  const models: { waitMs: number; first: AiFirstBlock }[] = [];
  return {
    shown(event: AssistantEvent) {
      if (firstShownMs !== null) return;
      if (event.type === 'text' || event.type === 'step' || event.type === 'card')
        firstShownMs = Date.now() - receivedAt;
    },
    asked(answer: number) {
      asked.set(answer, Date.now());
    },
    started(answer: number, first: AiFirstBlock) {
      const at = asked.get(answer);
      if (at !== undefined) models.push({ waitMs: Date.now() - at, first });
    },
    read: () => ({ firstShownMs, models, totalMs: Date.now() - receivedAt }),
  };
}

export interface WarmInput {
  readonly userId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  /** Exactly the tools the person's next question will be offered. */
  readonly tools: readonly OfferedTool[];
  readonly prompt: PromptContext;
}

/**
 * While the person types: the provider reads the instructions, the tools and the business's lasting context ahead of
 * the question, so the question's first model call finds them in its cache instead of reading some 25,000 tokens
 * first. Only with room in today's limit, and its tokens count toward it (app.ai_usage, source `assistant`). False
 * when nothing was read: no room, or a provider with nothing to warm (the backup AI fills its own cache).
 */
export async function warmUp(
  deps: Pick<RuntimeDeps, 'db' | 'provider' | 'dailyTokens'>,
  input: WarmInput,
): Promise<boolean> {
  const provider = deps.provider;
  if (!provider.warm) return false;
  const scope = { workspaceId: input.workspaceId, organizationId: input.organizationId };
  if ((await store.tokensToday(deps.db, scope, input.prompt.timezone)) >= deps.dailyTokens)
    return false;
  const request = assistantRequest(input.tools, provider);
  const usage = await provider.warm({
    system: request.system,
    lasting: lastingText(input.prompt),
    tools: request.tools,
    messages: [],
  });
  if (totalTokens(usage) === 0) return false;
  await asWorker(deps.db, scope, (tx) =>
    recordAiUsage(tx, { source: 'assistant', userId: input.userId, model: provider.model, usage }),
  );
  return true;
}
