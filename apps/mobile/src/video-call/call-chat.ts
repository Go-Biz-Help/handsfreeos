/**
 * What this phone sends in a call's chat, reported to the worker so the call keeps its chat whatever its AI notes
 * (docs/video-calls.md, "The chat, kept"), as on the web. It goes with the ticket the phone joined on, so the worker
 * keeps it only as this person's own. Nothing is read back: the message is in the call already.
 */
import { config } from '@/lib/config';
import { appFetch } from '@/lib/network';

export function keepCallChat(ticket: string, id: string, text: string): void {
  if (!config.workerUrl) return;
  void appFetch(`${config.workerUrl}/public/calls/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, id, text }),
  }).catch(() => undefined);
}
