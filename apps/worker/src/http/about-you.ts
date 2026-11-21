/**
 * About you's interview (docs/outreach.md, decision 186; core's account/about-you.ts): `POST /v1/about-you/write` takes
 * the person's answers to its questions and what's in the box now, and hands back the box as the AI wrote it from
 * them, keeping what was there. Nothing is kept here: the box fills in on their screen and only Save keeps it
 * (core's `user_about.set`), so the words never pass the kernel unseen by the person.
 *
 * Signed in, and a member of the business the AI's use counts against ('about_you' usage), as anyone there may fill
 * in their own About you.
 */
import rateLimit from '@fastify/rate-limit';
import {
  ABOUT_YOU_INTERVIEW_WORDS,
  ABOUT_YOU_WRITE_SCHEMA,
  ABOUT_YOU_WRITE_SYSTEM,
  aboutYouAnswered,
  aboutYouChecked,
  aboutYouWritePrompt,
  AboutYouWriteBody,
  AboutYouWritten,
  HfosError,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../ai/ask';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';

const failed = () =>
  HfosError.rule(
    'ai_failed',
    502,
    'The AI couldn’t write it up just now. Your answers are still on the screen: try again in a minute.',
  );

function aiError(e: unknown): unknown {
  if (!(e instanceof AiAskError)) return e;
  switch (e.code) {
    case 'ai_unavailable':
      return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
    case 'budget_reached':
      return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
    case 'wallet_empty':
      return HfosError.rule('wallet_empty', 402, e.message);
    case 'provider_error':
      return e.retryable ? HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE) : failed();
    case 'bad_output':
      return failed();
  }
}

export async function registerAboutYouRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, { global: false });
    scoped.post(
      '/v1/about-you/write',
      // One write-up at the end of the questions, and a try again or two.
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req) => {
        const actor = await authenticate(deps, req);
        const body = parseBody(AboutYouWriteBody, req.body);
        await requirePermission(deps, actor.userId, body.workspaceId, 'workspace.read');
        const answers = aboutYouAnswered(body.answers);
        if (!answers.length)
          throw HfosError.rule('nothing_said', 400, ABOUT_YOU_INTERVIEW_WORDS.nothing);
        if (!deps.ai.provider)
          throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
        const [ws] = await asWorker(deps.httpDb, { workspaceId: body.workspaceId }, (tx) =>
          rows<{ organization_id: string }>(
            tx,
            sql`select organization_id from app.workspaces where id = ${body.workspaceId}`,
          ),
        );
        if (!ws) throw HfosError.notFound('That business isn’t there anymore.');
        let written: AboutYouWritten;
        try {
          ({ value: written } = await askStructured(
            { db: deps.httpDb, ai: deps.ai, log: deps.log, wallet: deps.wallet },
            { workspaceId: body.workspaceId, organizationId: ws.organization_id },
            {
              system: ABOUT_YOU_WRITE_SYSTEM,
              messages: [
                { role: 'user', content: aboutYouWritePrompt({ answers, about: body.about }) },
              ],
              schema: ABOUT_YOU_WRITE_SCHEMA,
              zod: AboutYouWritten,
              maxTokens: 1_200,
              usage: { source: 'about_you', userId: actor.userId },
            },
          ));
        } catch (e) {
          throw aiError(e);
        }
        const about = aboutYouChecked(written.about);
        if (!about) throw failed();
        return { about };
      },
    );
  });
}
