/**
 * The affiliate program's one signed-out door (20261027014000): `POST /public/affiliates/click`.
 *
 * The website calls it, from its own server, when somebody arrives on an affiliate's link (`handsfreeos.com/?ref=`)
 * for the first time on that browser: today's count for that affiliate goes up by one. It answers the same whatever
 * the code, so it says nothing about who is or isn't an affiliate; `private.affiliate_click` counts only an approved
 * one's. A count is all it can change, and nobody is paid on clicks, so it carries no token.
 *
 * Rate-limited by address like every public route here, generously: the website calls it for all its visitors from a
 * few addresses of its own.
 */
import rateLimit from '@fastify/rate-limit';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, type HttpDeps } from './common';

const ClickInput = z.strictObject({ code: z.string().trim().toLowerCase().min(1).max(64) });

export async function registerAffiliateRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });

    pub.post<{ Body: unknown }>(
      '/public/affiliates/click',
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (req) => {
        const { code } = parseBody(ClickInput, req.body ?? {});
        await asWorker(deps.httpDb, {}, (tx) =>
          rows(tx, sql`select private.affiliate_click(${code})`),
        );
        return { ok: true };
      },
    );
  });
}
