/**
 * An outside safety contact's page (`/s/<token>`, round six): a person missed a check-out, their contact got a text
 * or an email with a link, and the link shows just that check-in while it's still being told about: the place, the
 * planned end, where their phone was, and how to call them. "I reached them, they’re OK" stops the alerts for
 * everyone; "I couldn’t reach them" tells the teammates who were alerted.
 *
 * - **The token is the whole permission**, and only its SHA-256 is kept (safety/ladder.ts makes one per text or
 *   email). Once someone says the person is OK, or the person checks out, the page shows that and nothing else.
 * - **Never cached**, the token never leaves in a Referer header, and both buttons are POSTs, so a mail scanner
 *   opening the link changes nothing.
 */
import rateLimit from '@fastify/rate-limit';
import {
  executeCommand,
  fmtTime,
  formatPhone,
  HfosError,
  safetyResolveByLink,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { safetyTokenHash } from '../safety/ladder';
import { systemActor, workerMeta, type TenantScope } from '../services';
import type { HttpDeps } from './common';

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

const notFound = () =>
  HfosError.notFound(
    'This link doesn’t work. Check it matches the one in the text or email, or call the person yourself.',
  );

type Link = {
  scope: TenantScope;
  checkInId: string;
  escalationId: string;
};

export async function registerSafetyRoutes(app: FastifyInstance, deps: HttpDeps) {
  const linked = async (token: string): Promise<Link> => {
    if (!TOKEN.test(token)) throw notFound();
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{
        workspace_id: string;
        organization_id: string;
        checkin_id: string;
        escalation_id: string;
      }>(tx, sql`select * from private.safety_link_lookup(${safetyTokenHash(token)})`),
    );
    if (!row) throw notFound();
    return {
      scope: { workspaceId: row.workspace_id, organizationId: row.organization_id },
      checkInId: row.checkin_id,
      escalationId: row.escalation_id,
    };
  };

  /** What the page shows: the check-in while it's open; once settled, only that it is. */
  const view = async (l: Link) =>
    asWorker(deps.httpDb, l.scope, async (tx) => {
      const [c] = await rows<{
        state: string;
        place: string;
        latitude: string | null;
        longitude: string | null;
        located_at: Date | string | null;
        started_at: Date | string;
        planned_end_at: Date | string;
        person: string;
        phone: string | null;
        business: string;
        time_zone: string;
        resolved_via: string | null;
      }>(
        tx,
        sql`select c.state, c.place, c.latitude::text, c.longitude::text, c.located_at, c.started_at,
              c.planned_end_at, c.resolved_via,
              coalesce(nullif(trim(u.full_name), ''), 'Your contact') as person,
              (select p.e164 from app.user_phones p where p.user_id = c.user_id and p.verified_at is not null
               order by p.created_at limit 1) as phone,
              w.name as business, w.timezone as time_zone
            from app.safety_checkins c
            join app.users u on u.id = c.user_id
            join app.workspaces w on w.id = c.workspace_id
            where c.id = ${l.checkInId}::uuid`,
      );
      if (!c) throw notFound();
      const first = c.person.split(/\s+/)[0] ?? c.person;
      const open = c.state === 'alerted' || c.state === 'help';
      if (!open)
        return {
          open: false as const,
          person: first,
          business: c.business,
          settled: c.state === 'out' ? ('checked_out' as const) : ('ok' as const),
        };
      const at = (v: Date | string) => fmtTime(new Date(v).getTime(), c.time_zone);
      return {
        open: true as const,
        person: c.person,
        first,
        business: c.business,
        help: c.state === 'help',
        place: c.place,
        plannedEnd: at(c.planned_end_at),
        checkedIn: at(c.started_at),
        located:
          c.latitude && c.longitude
            ? {
                latitude: Number(c.latitude),
                longitude: Number(c.longitude),
                at: c.located_at ? at(c.located_at) : null,
              }
            : null,
        phone: c.phone,
        phoneWords: c.phone ? formatPhone(c.phone) : null,
      };
    });

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
    pub.addHook('onSend', async (_req, reply) => {
      void reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    });

    pub.get<{ Params: { token: string } }>(
      '/public/safety/:token',
      { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (req) => view(await linked(req.params.token)),
    );

    for (const how of ['ok', 'unreached'] as const)
      pub.post<{ Params: { token: string } }>(
        `/public/safety/:token/${how}`,
        { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
        async (req) => {
          const l = await linked(req.params.token);
          await executeCommand(
            deps.httpDb,
            safetyResolveByLink,
            { workspaceId: l.scope.workspaceId, escalationId: l.escalationId, how },
            systemActor(l.scope),
            workerMeta(),
          );
          return view(l);
        },
      );
  });
}
