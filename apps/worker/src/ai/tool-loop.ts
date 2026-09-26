/**
 * The tool loop the Assistant and the AI teammate share (plan M7, "Worker runtime" step 4). It asks the model,
 * runs the tools it calls, hands their results back, and repeats until the model answers, a tool ends the turn,
 * the round cap or the budget is reached, Stop is pressed, or something fails.
 *
 * - It knows nothing about who is asking or where a run is kept. The caller runs each tool (`execute`), shows
 *   the text as it streams (`onText`), records each turn's tokens (`onTurnUsage`) and says whether another
 *   model call fits the budget (`checkBudget`).
 * - A round's calls run one at a time, in the model's order, and all of them run even when one ends the turn.
 *   `execute` handles its own tools' errors: it answers `isError` (in words from `toolErrorContent`) and the
 *   model reads why. Anything `execute` throws ends the loop.
 * - The loop never retries; the provider does (the Anthropic SDK retries 408, 409, 429 and 5xx). A provider
 *   error ends the loop as `aborted` when Stop was pressed, otherwise as `error`, marked `retryable` when the
 *   provider was busy, so "try again in a minute" is the right thing to say.
 * - Stop reaches the model through `signal`; tools already running finish their round first.
 */
import {
  addUsage,
  AiProviderError,
  emptyUsage,
  type AiContent,
  type AiMessage,
  type AiProvider,
  type AiStopReason,
  type AiToolCall,
  type AiToolDefinition,
  type AiUsage,
} from '@hfos/ai';
import { HfosError } from '@hfos/core/server';

/** Why the loop ended. A tool that ends the turn (`stop`) ends it as `end_turn`, like the model's own answer. */
export type ToolLoopStop = 'end_turn' | 'max_rounds' | 'budget' | 'aborted' | 'error';

/** What one tool call gives back. */
export interface ToolLoopAnswer {
  /** What the model reads, sent as JSON: compact, with anything a customer wrote quoted as data. */
  readonly content: unknown;
  readonly isError?: boolean;
  /** Ends the loop once the round's other calls have run (the teammate's reply and hand-off tools). */
  readonly stop?: boolean;
}

/** A tool call the loop ran. */
export interface ToolLoopCall extends AiToolCall {
  /** The round it ran in, counting from 1. */
  readonly round: number;
  /** The JSON the model read back. */
  readonly content: string;
  readonly isError: boolean;
  readonly stop: boolean;
}

export interface ToolLoopInput {
  readonly provider: AiProvider;
  /** Fixed instructions (cached by the provider). */
  readonly system: string;
  /** What changes per question: the time, the page, the business brief. */
  readonly context?: string;
  /** The conversation so far, ending with the person's turn. It isn't changed; the result has the new turns. */
  readonly messages: readonly AiMessage[];
  readonly tools: readonly AiToolDefinition[];
  /** Rounds of tool calls it runs. When the model asks for more, it stops (`max_rounds`) without running them. */
  readonly maxRounds: number;
  /** Per model call. */
  readonly maxTokens: number;
  /** Runs one tool call. */
  readonly execute: (call: AiToolCall) => Promise<ToolLoopAnswer>;
  /** Each piece of the model's text as it arrives, from every turn. */
  readonly onText?: (delta: string) => void;
  /** Each model turn's tokens, as soon as the turn ends and before its tools run (awaited). */
  readonly onTurnUsage?: (usage: AiUsage) => void | Promise<void>;
  /** Before every model call, given the tokens the loop has used so far: false ends it (`budget`). */
  readonly checkBudget?: (used: AiUsage) => boolean | Promise<boolean>;
  readonly signal?: AbortSignal;
}

export interface ToolLoopResult {
  /** Every piece of text the model streamed, all turns run together (what the Assistant shows and saves). */
  readonly text: string;
  /**
   * The conversation with the loop's turns added: each round's calls and results, then the answer's text. A
   * turn the cap cut off keeps its text and drops its calls; after `error` or `aborted` it can end mid-round.
   */
  readonly messages: AiMessage[];
  /** Tokens across every turn. */
  readonly usage: AiUsage;
  /** Model turns that asked for tools, one the cap cut off included (so maxRounds + 1 at `max_rounds`). */
  readonly rounds: number;
  readonly stoppedBy: ToolLoopStop;
  /** The calls that ran, in order. */
  readonly toolCalls: readonly ToolLoopCall[];
  /** What was thrown, at `error` or `aborted`. */
  readonly error?: unknown;
  /** The provider was busy (rate limited, overloaded or unreachable), so trying again later may work. */
  readonly retryable: boolean;
  /** Why the model's last turn stopped: `refusal` when it declined, `max_tokens` when it ran out of room. */
  readonly lastStop: AiStopReason | null;
}

/** A tool's error in words the model can pass on (never a stack or SQL). */
export function toolErrorContent(e: unknown): { error: string; rule?: string } {
  if (e instanceof HfosError) return { error: e.message, ...(e.rule ? { rule: e.rule } : {}) };
  return { error: 'That didn’t work. Nothing was changed.' };
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const messages: AiMessage[] = [...input.messages];
  const toolCalls: ToolLoopCall[] = [];
  let text = '';
  let usage: AiUsage = emptyUsage;
  let rounds = 0;
  let lastStop: AiStopReason | null = null;
  const end = (stoppedBy: ToolLoopStop, error?: unknown): ToolLoopResult => ({
    text,
    messages,
    usage,
    rounds,
    stoppedBy,
    toolCalls,
    error,
    retryable: error instanceof AiProviderError && error.retryable,
    lastStop,
  });

  /** A turn the provider paused is carried on by the next response, so that one joins it: one turn, not two. */
  let paused = false;
  const said = (content: string | readonly AiContent[]) => {
    const last = messages[messages.length - 1];
    if (paused && last?.role === 'assistant' && Array.isArray(last.content)) {
      const more: readonly AiContent[] =
        typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      messages[messages.length - 1] = { role: 'assistant', content: [...last.content, ...more] };
    } else messages.push({ role: 'assistant', content });
    paused = false;
  };

  try {
    for (;;) {
      if (input.checkBudget && !(await input.checkBudget(usage))) return end('budget');
      const turn = await input.provider.stream(
        {
          system: input.system,
          ...(input.context ? { context: input.context } : {}),
          messages,
          tools: input.tools,
          maxTokens: input.maxTokens,
        },
        {
          ...(input.signal ? { signal: input.signal } : {}),
          onText: (delta) => {
            text += delta;
            input.onText?.(delta);
          },
        },
      );
      usage = addUsage(usage, turn.usage);
      lastStop = turn.stopReason;
      await input.onTurnUsage?.(turn.usage);
      // The provider paused a long turn of its own tools (a tool search): the turn goes back as it came and the
      // model carries on from there. It counts as a round, so it can't go on for ever.
      if (turn.stopReason === 'pause_turn' && turn.content?.length) {
        if (++rounds > input.maxRounds) return end('max_rounds');
        said(turn.content);
        paused = true;
        continue;
      }
      if (turn.stopReason !== 'tool_use' || turn.toolCalls.length === 0) {
        if (turn.text) said(turn.text);
        return end('end_turn');
      }
      if (++rounds > input.maxRounds) {
        if (turn.text) said(turn.text);
        return end('max_rounds');
      }
      const calls: AiContent[] = turn.toolCalls.map((c) => ({
        type: 'tool_call',
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      }));
      // The turn as the model gave it when the provider kept it, so its reasoning goes back unchanged.
      said(turn.content ?? (turn.text ? [{ type: 'text', text: turn.text }, ...calls] : calls));
      const results: AiContent[] = [];
      let stop = false;
      for (const call of turn.toolCalls) {
        const answer = await input.execute(call);
        const content = JSON.stringify(answer.content);
        const isError = !!answer.isError;
        results.push({ type: 'tool_result', callId: call.id, content, isError });
        toolCalls.push({ ...call, round: rounds, content, isError, stop: !!answer.stop });
        if (answer.stop) stop = true;
      }
      messages.push({ role: 'user', content: results });
      if (stop) return end('end_turn');
    }
  } catch (e) {
    return end(e instanceof AiProviderError && e.code === 'aborted' ? 'aborted' : 'error', e);
  }
}
