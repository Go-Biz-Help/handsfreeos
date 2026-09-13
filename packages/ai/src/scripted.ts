import {
  AiProviderError,
  type AiContent,
  type AiMessage,
  type AiProvider,
  type AiRequest,
  type AiStreamOptions,
  type AiToolCall,
  type AiTurn,
} from './types';

export interface ScriptRule {
  /** Matched against the person's latest question. */
  readonly when: RegExp;
  /** Tools to call first (the context carries ids, such as the page's record); none means answer straight away. */
  readonly calls?: (
    question: string,
    context: string,
  ) => readonly { name: string; arguments: Record<string, unknown> }[];
  /** The answer, given the question and each tool's result by tool name. */
  readonly reply: (
    question: string,
    results: Readonly<Record<string, string>>,
    context: string,
  ) => string;
}

/**
 * A stand-in model for tests and the browser suite: a question picks the first matching rule, which
 * calls its tools and then answers from their results. It streams its answer word by word.
 */
export class ScriptedProvider implements AiProvider {
  readonly id = 'scripted';
  readonly model = 'scripted';

  constructor(
    private readonly rules: readonly ScriptRule[],
    private readonly fallback = 'I can look things up, add tasks and notes, and draft texts and emails for you to OK.',
  ) {}

  async stream(request: AiRequest, options: AiStreamOptions = {}): Promise<AiTurn> {
    if (options.signal?.aborted) throw new AiProviderError('Stopped', 'aborted', false);
    const question = latestQuestion(request.messages);
    const rule = this.rules.find((r) => r.when.test(question));
    const last = request.messages[request.messages.length - 1];
    const answering =
      !!last && Array.isArray(last.content) && last.content.some((c) => c.type === 'tool_result');
    const inputTokens = Math.ceil(
      (request.system.length + JSON.stringify(request.messages).length) / 4,
    );

    const context = request.context ?? '';
    const calls = rule?.calls && !answering ? rule.calls(question, context) : [];
    if (calls.length) {
      const toolCalls: AiToolCall[] = calls.map((c, i) => ({
        id: `scripted_${request.messages.length}_${i}`,
        name: c.name,
        arguments: c.arguments,
      }));
      return { text: '', toolCalls, stopReason: 'tool_use', usage: usage(inputTokens, 20) };
    }

    const text = rule
      ? rule.reply(question, resultsByTool(request.messages), context)
      : this.fallback;
    const words = text.split(/(?<= )/);
    for (const w of words) {
      if (options.signal?.aborted) throw new AiProviderError('Stopped', 'aborted', false);
      options.onText?.(w);
    }
    return {
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: usage(inputTokens, Math.ceil(text.length / 4)),
    };
  }
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function blocks(m: AiMessage): readonly AiContent[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
}

/** The newest thing the person typed (tool results travel as user messages too, so skip those). */
function latestQuestion(messages: readonly AiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const text = blocks(m)
      .flatMap((c) => (c.type === 'text' ? [c.text] : []))
      .join(' ')
      .trim();
    if (text) return text;
  }
  return '';
}

/** Results of the tools called since the latest question, keyed by tool name. */
function resultsByTool(messages: readonly AiMessage[]): Record<string, string> {
  const names = new Map<string, string>();
  const out: Record<string, string> = {};
  for (const m of messages) {
    for (const c of blocks(m)) {
      if (c.type === 'tool_call') names.set(c.id, c.name);
      if (c.type === 'tool_result') out[names.get(c.callId) ?? c.callId] = c.content;
    }
  }
  return out;
}
