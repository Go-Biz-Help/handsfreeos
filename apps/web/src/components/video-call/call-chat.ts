'use client';

/**
 * What this call screen sends in the chat, reported to the worker so the call keeps its chat whatever its AI notes
 * (docs/video-calls.md, "The chat, kept"). It goes with the ticket the screen joined on, so the worker keeps it only
 * as this person's own. Plain text, so it goes without a preflight from any address the page is on. Nothing is read
 * back: the message is in the call already.
 */
import { publicEnv } from '@/lib/env';

export function keepCallChat(ticket: string, id: string, text: string): void {
  void fetch(`${publicEnv.workerUrl}/public/calls/chat`, {
    method: 'POST',
    body: JSON.stringify({ ticket, id, text }),
    keepalive: true,
    mode: 'no-cors',
    headers: { 'content-type': 'text/plain' },
  }).catch(() => undefined);
}
