import { executeCommand, executeQuery, registry, type HumanActor } from '@hfos/core/server';
import type { Db } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requestMeta } from './context';

declare module 'fastify' {
  interface FastifyRequest {
    actor: HumanActor | null;
  }
}

const RATE_LIMITED: Record<string, { max: number; timeWindow: string }> = {
  'invitation.accept': { max: 10, timeWindow: '1 minute' },
  'invitation.preview': { max: 30, timeWindow: '1 minute' },
};

/** Mounts one POST route per registry entry. Commands and queries share the same JSON envelope. */
export function registerOperations(app: FastifyInstance, db: Db): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  for (const cmd of registry.commands) {
    // Commands only the worker or a workflow runs (the carrier's answers, inbound texts) never become routes.
    if (!(cmd.actors ?? ['human']).includes('human')) continue;
    typed.route({
      method: 'POST',
      url: `/v1/commands/${cmd.name}`,
      schema: {
        operationId: `command_${cmd.name.replace(/\./g, '_')}`,
        summary: cmd.description,
        description: `Risk level ${cmd.risk}.${cmd.permission ? ` Requires ${cmd.permission}.` : ''} Emits ${cmd.emits.join(', ')}.`,
        tags: ['commands'],
        body: cmd.input,
        response: { 200: cmd.output },
      },
      config: RATE_LIMITED[cmd.name] ? { rateLimit: RATE_LIMITED[cmd.name] } : {},
      handler: async (req, reply) => {
        const { output, eventIds } = await executeCommand(
          db,
          cmd,
          req.body,
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
      config: RATE_LIMITED[q.name] ? { rateLimit: RATE_LIMITED[q.name] } : {},
      handler: async (req) => executeQuery(db, q, req.body, req.actor!, requestMeta(req)),
    });
  }
}
