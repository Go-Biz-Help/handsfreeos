/**
 * The AI teammate's worker route: the builder's test console, POST /v1/ai-team/test (console.ts). It needs
 * ai_team.manage. Refusals come back as the API's JSON errors before the stream opens (403 without the
 * permission, 429 at the AI limit, 400 for unreadable settings); then server-sent events, until `done` or
 * `error`. Closing the stream stops the test.
 */
import { HfosError } from '@hfos/core/server';
import type { FastifyInstance } from 'fastify';
import { authenticate, parseBody, requirePermission, type HttpDeps } from '../http/common';
import { openStream } from '../http/sse';
import { prepareTest, runTest, TestConsoleInput, type ConsoleEvent } from './console';

export function registerTeammateRoutes(app: FastifyInstance, deps: HttpDeps): void {
  app.post('/v1/ai-team/test', async (req, reply) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(TestConsoleInput, req.body);
    await requirePermission(deps, actor.userId, input.workspaceId, 'ai_team.manage');
    const consoleDeps = { db: deps.httpDb, ai: deps.ai, webUrl: deps.webUrl, log: deps.log };
    const prepared = await prepareTest(consoleDeps, input);
    const stream = openStream<ConsoleEvent>(reply);
    const stop = new AbortController();
    stream.onClose(() => stop.abort());
    try {
      await runTest(consoleDeps, prepared, (e) => stream.send(e), stop.signal);
    } catch (e) {
      if (!(e instanceof HfosError)) deps.log.error({ err: e }, 'the AI teammate’s test stopped');
      stream.send({
        type: 'error',
        message: e instanceof HfosError ? e.message : 'The test stopped. Try again.',
      });
    } finally {
      stream.end();
    }
  });
}
