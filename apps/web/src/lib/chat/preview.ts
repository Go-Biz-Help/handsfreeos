'use client';
/**
 * The chat window's transport on the preview page (/chat-preview/<key>): the widget exactly as visitors see it,
 * but its test chats go to the AI teammate's test console (POST /v1/ai-team/test, as the signed-in manager)
 * instead of the public chat routes. It creates nothing and sends nothing: a change the teammate would make comes
 * back as a "would" event. The console's adapter (lib/ai-team/test-stream.ts) loads only here, so visitors never
 * download the sign-in client.
 */
import { ApiError } from '../api/errors';
import type { TestEvent } from '../ai-team/test-stream';

export interface PreviewTurn {
  readonly from: 'customer' | 'teammate';
  readonly text: string;
}

/** The console takes the chat so far, oldest first, ending with the customer's new message (at most 40). */
const MAX_TURNS = 40;

export async function previewReply(
  workspaceId: string,
  turns: readonly PreviewTurn[],
  onEvent: (event: TestEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { streamTest } = await import('../ai-team/test-stream');
  await streamTest(
    {
      workspaceId,
      personId: null,
      channel: 'chat',
      at: null,
      config: null,
      messages: turns.slice(-MAX_TURNS),
    },
    onEvent,
    signal,
  );
}

/** The worker doesn't have the test console yet: it arrives with the teammate's runtime. */
export const testConsoleMissing = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 404;
