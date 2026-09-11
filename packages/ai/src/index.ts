/**
 * The swappable AI seam. HandsFreeOS decides what context a model sees, which tools it may call
 * and whether approval is needed; a provider only supplies intelligence. Real providers arrive in
 * Milestone 4 (text) and Milestone 11 (realtime voice).
 */
export interface AiMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
}

export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface AiCompletionRequest {
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly AiToolDefinition[];
  readonly maxTokens?: number;
}

export interface AiToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface AiCompletion {
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
}

export interface AiProvider {
  readonly id: string;
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}

/** Provider used until a real one is configured: answers nothing and never calls a tool. */
export class NullProvider implements AiProvider {
  readonly id = 'null';
  async complete(): Promise<AiCompletion> {
    return { text: '', toolCalls: [] };
  }
}
