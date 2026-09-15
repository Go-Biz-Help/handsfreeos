import type { FastifyReply } from 'fastify';

export interface EventStream<E> {
  /**
   * Sends one event as a `data:` line of JSON; nothing once the client has gone. With an `id`, the event is
   * numbered, so a client that reconnects can say where it got to (the `Last-Event-ID` header).
   */
  send(event: E, opts?: { readonly id?: string }): void;
  /** Stops the pings and closes the response. */
  end(): void;
  /** Runs once when the stream closes, whether the client went away or `end()` was called. */
  onClose(listener: () => void): void;
  /** The client has gone, or `end()` was called. */
  readonly closed: boolean;
}

/**
 * A server-sent event stream on a hijacked reply, keeping the headers plugins already set (CORS included). The
 * Assistant streams its answers this way, and the website chat's live replies use it too.
 */
export function openStream<E>(reply: FastifyReply): EventStream<E> {
  const headers = {
    ...reply.getHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  };
  reply.hijack();
  reply.raw.writeHead(200, headers as Record<string, string>);
  let open = true;
  const listeners: (() => void)[] = [];
  // Proxies close quiet connections; a comment line every 15 seconds keeps this one up.
  const beat = setInterval(() => {
    if (open) reply.raw.write(': ping\n\n');
  }, 15_000);
  const closed = () => {
    if (!open) return;
    open = false;
    clearInterval(beat);
    for (const listener of listeners.splice(0)) listener();
  };
  reply.raw.on('close', closed);
  return {
    send(event: E, opts = {}) {
      if (!open) return;
      // An id is one line: anything that could end it early is dropped.
      const id = opts.id?.replace(/[\r\n\0]/g, '');
      reply.raw.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      clearInterval(beat);
      if (open) reply.raw.end();
      closed();
    },
    onClose(listener: () => void) {
      if (open) listeners.push(listener);
      else listener();
    },
    get closed() {
      return !open;
    },
  };
}
