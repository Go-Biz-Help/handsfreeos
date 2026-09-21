/**
 * Which business a host belongs to (M17).
 *
 * One route, read by the web app's proxy on every request that arrives on a name that is not ours. It runs
 * as the system actor and answers only for a domain that is actually working — verified, with a certificate
 * issued, on a booking site that is switched on — because a name still waiting on DNS must not start serving
 * a half-configured business.
 *
 * It is here rather than in the web app for the reason the form's frame rule is: the web app holds no
 * database credentials, and Next middleware cannot open a Postgres connection anyway.
 */
import rateLimit from '@fastify/rate-limit';
import { rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import type { HttpDeps } from './common';

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export async function registerSiteRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(async (pub) => {
    await pub.register(rateLimit, { global: false });
    pub.get<{ Params: { host: string } }>(
      '/public/site-for-host/:host',
      // Generous: the proxy keeps the answer for a minute, so this is one call per host per minute per
      // region, and the unknown-host answer is the one a scanner would be hammering.
      { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const host = req.params.host.toLowerCase().replace(/:\d+$/, '');
        // Not a hostname at all: answered without touching the database.
        if (!HOST.test(host) || host.length > 253) return reply.send({ site: null });
        const [found] = await rows<{ site_slug: string; workspace_id: string }>(
          deps.db,
          sql`select * from private.site_for_domain(${host})`,
        );
        // A minute at the edge, and the proxy keeps its own copy for a minute too. A domain that has just
        // started working is live within about two minutes, which is nothing next to DNS.
        void reply.header('cache-control', 'public, max-age=60, s-maxage=60');
        return reply.send(found ? { site: found.site_slug } : { site: null });
      },
    );
  });
}
