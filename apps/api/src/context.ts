import { randomUUID } from 'node:crypto';
import { readAppRequest, type RequestMeta } from '@hfos/core/server';
import type { FastifyRequest } from 'fastify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a caller-supplied correlation id only when it is a UUID; otherwise mints one. */
export function correlationIdFor(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && UUID.test(value) ? value.toLowerCase() : randomUUID();
}

/**
 * Where a request came from and what it says about itself. The phone app (`x-hfos-client: mobile`) also sends its
 * command's id and the moments it was done, sent and confirmed, read here onto the server's clock; everything
 * else is the web.
 */
export function requestMeta(req: FastifyRequest): RequestMeta {
  const reason = req.headers['x-hfos-reason'];
  const app = readAppRequest(req.headers, new Date());
  return {
    correlationId: req.id,
    causationId: null,
    channel: 'web',
    ip: req.ip,
    userAgent:
      typeof req.headers['user-agent'] === 'string'
        ? req.headers['user-agent'].slice(0, 512)
        : null,
    reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
    ...(app ?? {}),
  };
}
