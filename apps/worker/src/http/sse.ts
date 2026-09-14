import type { FastifyReply } from 'fastify';

export interface EventStream<E> {
  /** Sends one event as a `data:` line of JSON; nothing once the client has gone. */
  send(event: E): void;
  /** Stops the pings and closes the response. */
  end(): void;
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
  reply.raw.on('close', () => {
    open = false;
  });
  // Proxies close quiet connections; a comment line every 15 seconds keeps this one up.
  const beat = setInterval(() => {
    if (open) reply.raw.write(': ping\n\n');
  }, 15_000);
  return {
    send(event: E) {
      if (open) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      clearInterval(beat);
      if (open) reply.raw.end();
    },
  };
}
