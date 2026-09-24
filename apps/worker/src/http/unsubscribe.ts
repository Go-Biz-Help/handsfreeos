/**
 * Unsubscribing from a business's campaign email (email campaigns), the two ways a campaign email offers it:
 *
 * - `GET /public/unsubscribe/:token` is what the `/u/<token>` page shows: whose email it is and to which address
 *   (masked). It changes nothing — mail scanners open links.
 * - `POST /public/unsubscribe/:token` does it: the page's button, and a mail app's own "Unsubscribe" button,
 *   which posts `List-Unsubscribe=One-Click` here from the `List-Unsubscribe` header (RFC 8058). Doing it twice
 *   is fine.
 *
 * It stops campaign email only: visit confirmations, receipts and one-to-one replies still reach them.
 */
import rateLimit from '@fastify/rate-limit';
import { emailUnsubscribeRecord, executeCommand, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { maskAddress, resolveUnsubscribeToken, type UnsubscribeTarget } from '../email/unsubscribe';
import { systemActor, workerMeta } from '../services';
import type { HttpDeps } from './common';

const notFound = () =>
  HfosError.notFound(
    'This link doesn’t work any more. Reply to the email and ask to be taken off.',
  );

export async function registerUnsubscribeRoutes(app: FastifyInstance, deps: HttpDeps) {
  const target = async (token: string): Promise<UnsubscribeTarget & { address: string }> => {
    const t = await resolveUnsubscribeToken(deps.httpDb, deps.unsubscribeLinks, token);
    if (!t?.address) throw notFound();
    return { ...t, address: t.address };
  };

  await app.register(async (pub) => {
    await pub.register(rateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new HfosError(
          'rule_violation',
          429,
          'That’s a lot of tries from here. Wait a minute and try again.',
          undefined,
          'rate_limited',
        ),
    });
    // Never cached, and the token never leaves in a Referer header.
    pub.addHook('onSend', async (_req, reply) => {
      void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    });

    pub.get<{ Params: { token: string } }>(
      '/public/unsubscribe/:token',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req) => {
        const t = await target(req.params.token);
        const [done] = await asWorker(deps.httpDb, t.scope, (tx) =>
          rows(
            tx,
            sql`select 1 from app.email_unsubscribes
                where workspace_id = ${t.scope.workspaceId} and address = ${t.address}`,
          ),
        );
        return {
          business: t.businessName,
          address: maskAddress(t.address),
          unsubscribed: !!done,
        };
      },
    );

    pub.post<{ Params: { token: string } }>(
      '/public/unsubscribe/:token',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req) => {
        const t = await target(req.params.token);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const oneClick = body['List-Unsubscribe'] === 'One-Click';
        await executeCommand(
          deps.httpDb,
          emailUnsubscribeRecord,
          {
            workspaceId: t.scope.workspaceId,
            address: t.address,
            campaignId: t.campaignId,
            source: oneClick ? 'one_click' : 'link',
          },
          systemActor(t.scope),
          workerMeta(null, null),
        );
        return { business: t.businessName, address: maskAddress(t.address), unsubscribed: true };
      },
    );
  });
}
