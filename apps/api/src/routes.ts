import {
  executeCommand,
  executeQuery,
  HfosError,
  registry,
  SEARCH_WORDS,
  type HumanActor,
} from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requestMeta } from './context';
import { acquireSlot, SEARCH_SLOT_WAIT_MS } from './search-slots';

declare module 'fastify' {
  interface FastifyRequest {
    actor: HumanActor | null;
    /** The JSON body as sent, before the route's schema validated it (and filled in defaults). */
    sentBody: unknown;
  }
}

const RATE_LIMITED: Record<string, { max: number; timeWindow: string }> = {
  'invitation.accept': { max: 10, timeWindow: '1 minute' },
  'invitation.preview': { max: 30, timeWindow: '1 minute' },
};

/**
 * Search's own limits, a minute per person (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 6). Counted
 * after sign-in (`preHandler`), so they're keyed by who is searching rather than by an office's shared address, and
 * refused with their own rule. In memory on each machine, so the real ceiling is double; accepted.
 */
const SEARCH_LIMITS: Record<string, number> = {
  'search.everything': 90,
  'search.kind': 60,
};

const searchRateLimit = (max: number) => ({
  max,
  timeWindow: '1 minute',
  hook: 'preHandler' as const,
  keyGenerator: (req: FastifyRequest) => req.actor?.userId ?? req.ip,
  errorResponseBuilder: () => HfosError.rule('search_too_fast', 429, SEARCH_WORDS.tooFast),
});

/** A search, run inside one of this machine's search slots, or refused when none comes free in time. */
async function inSearchSlot<T>(run: () => Promise<T>): Promise<T> {
  const release = await acquireSlot(SEARCH_SLOT_WAIT_MS);
  if (!release) throw HfosError.rule('search_busy', 503, SEARCH_WORDS.busy);
  try {
    return await run();
  } finally {
    release();
  }
}

/** Mounts one POST route per registry entry. Commands and queries share the same JSON envelope. */
export function registerOperations(app: FastifyInstance, db: Db): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  for (const cmd of registry.commands) {
    // Commands only the worker or a workflow runs (the carrier's answers, inbound texts) never become routes.
    if (!(cmd.actors ?? ['human']).includes('human')) continue;
    const offline =
      cmd.offline === 'anytime'
        ? ' Can wait on a phone with no signal.'
        : cmd.offline === 'online'
          ? ''
          : ` Can wait on a phone for ${cmd.offline.freshMinutes} minutes, then asks.`;
    typed.route({
      method: 'POST',
      url: `/v1/commands/${cmd.name}`,
      schema: {
        operationId: `command_${cmd.name.replace(/\./g, '_')}`,
        summary: cmd.description,
        description: `Risk level ${cmd.risk}.${cmd.permission ? ` Requires ${cmd.permission}.` : ''} Emits ${cmd.emits.join(', ')}.${offline}`,
        tags: ['commands'],
        body: cmd.input,
        response: { 200: cmd.output },
      },
      config: RATE_LIMITED[cmd.name] ? { rateLimit: RATE_LIMITED[cmd.name] } : {},
      handler: async (req, reply) => {
        // The kernel validates the body again from what was sent, and hashes that for the command's receipt.
        const { output, eventIds } = await executeCommand(
          db,
          cmd,
          req.sentBody ?? req.body,
          req.actor!,
          requestMeta(req),
        );
        if (eventIds.length > 0) void reply.header('x-hfos-events', eventIds.join(','));
        return output;
      },
    });
  }
  for (const q of registry.queries) {
    // Nor do queries only the worker or a workflow runs.
    if (!(q.actors ?? ['human']).includes('human')) continue;
    typed.route({
      method: 'POST',
      url: `/v1/queries/${q.name}`,
      schema: {
        operationId: `query_${q.name.replace(/\./g, '_')}`,
        summary: q.description,
        description: q.permission ? `Requires ${q.permission}.` : 'Any signed-in user.',
        tags: ['queries'],
        body: q.input,
        response: { 200: q.output },
      },
      config: SEARCH_LIMITS[q.name]
        ? { rateLimit: searchRateLimit(SEARCH_LIMITS[q.name]!) }
        : RATE_LIMITED[q.name]
          ? { rateLimit: RATE_LIMITED[q.name] }
          : {},
      handler: async (req) =>
        SEARCH_LIMITS[q.name]
          ? inSearchSlot(() => executeQuery(db, q, req.body, req.actor!, requestMeta(req)))
          : executeQuery(db, q, req.body, req.actor!, requestMeta(req)),
    });
  }
}
