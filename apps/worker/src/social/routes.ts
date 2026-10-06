/**
 * What Meta calls on the worker (20261025000200):
 *
 * - **`/webhooks/meta`**: every message, receipt, edit and ad referral for the Pages and Instagram accounts that are
 *   connected here. GET is Meta's check when the webhook is set up; POST is checked against the app's secret over
 *   the exact bytes, cut into one stored delivery per event (each kept once however often Meta retries), and
 *   answered at once: Meta stops sending to a webhook that's slow.
 * - **`/meta/deauthorize`** and **`/meta/data-deletion`**: somebody removed the app on Facebook, or asked for what we
 *   know about them to be deleted. Every sign-in of theirs stops; for deletion, who they were goes too.
 *
 * With the stand-in, the Facebook sign-in page is this server's own, and `/test/meta/webhook` signs and delivers an
 * event the way Meta would, for local demos and the browser specs.
 */
import { randomBytes } from 'node:crypto';
import { executeCommand, metaConnectionDisconnect } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { escapeHtml } from '../emails/templates';
import { header, recordDelivery, type HttpDeps } from '../http/common';
import { deadEnd, shell } from '../http/oauth';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta } from '../services';
import { META_DELIVERY_KIND, readSignedRequest, splitWebhook, verifyMetaSignature } from './events';

/** Meta batches up to a thousand events; a megabyte and a half is past any honest batch. */
const WEBHOOK_MAX_BYTES = 1_500_000;

export async function registerMetaRoutes(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  const meta = deps.social;

  await app.register(async (hooks) => {
    // The raw body is what Meta signs: JSON stays the exact string that arrived.
    hooks.removeContentTypeParser(['application/json']);
    hooks.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: WEBHOOK_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );

    // Meta's check when the webhook is set up: the verify token we gave it, and its challenge back as it came.
    hooks.get('/webhooks/meta', async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const token = q['hub.verify_token'];
      if (
        q['hub.mode'] === 'subscribe' &&
        meta.verifyToken &&
        token &&
        sameText(token, meta.verifyToken) &&
        q['hub.challenge']
      )
        return reply.type('text/plain; charset=utf-8').send(q['hub.challenge'].slice(0, 200));
      deps.log.warn('refused a Meta webhook check with the wrong verify token');
      return reply.code(403).type('text/plain').send('Forbidden');
    });

    hooks.post('/webhooks/meta', { bodyLimit: WEBHOOK_MAX_BYTES }, async (req, reply) => {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      if (
        !meta.appSecret ||
        !verifyMetaSignature(rawBody, header(req, 'x-hub-signature-256'), meta.appSecret)
      ) {
        deps.log.warn('rejected an unsigned or mis-signed Meta webhook');
        return reply.code(403).type('text/plain').send('Invalid signature');
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return reply.code(400).type('text/plain').send('Not JSON');
      }
      await storeEvents(deps, body, `${deps.publicUrl}${req.url}`);
      return reply.code(200).type('text/plain').send('EVENT_RECEIVED');
    });
  });

  /** Removing the app on Facebook: every sign-in of theirs stops, here and in every other business. */
  app.post('/meta/deauthorize', async (req, reply) => {
    const who = signedRequest(deps, req);
    if (!who) return reply.code(400).send({ ok: false });
    await stopSignIns(deps, who.userId, false);
    return reply.send({ ok: true });
  });

  /**
   * Asking Facebook to have their data deleted: the same, and who they were goes with their tokens. Facebook wants
   * a page that says what happened, and a code for it.
   */
  app.post('/meta/data-deletion', async (req, reply) => {
    const who = signedRequest(deps, req);
    if (!who) return reply.code(400).send({ error: 'invalid signed_request' });
    await stopSignIns(deps, who.userId, true);
    const code = randomBytes(8).toString('hex');
    deps.log.info({ code }, 'Facebook asked for a sign-in’s data to be deleted; done');
    return reply.send({
      url: `${deps.publicUrl}/meta/data-deletion/${code}`,
      confirmation_code: code,
    });
  });

  app.get('/meta/data-deletion/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    if (!/^[0-9a-f]{16}$/.test(code))
      return deadEnd(reply, 404, 'Nothing to show', 'That confirmation code isn’t one of ours.');
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        shell(
          'Your data was deleted',
          `<h1 style="font-size: 18px; margin: 0 0 8px;">Your data was deleted</h1>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 10px;">Confirmation code ${escapeHtml(code)}.</p>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0;">HandsFreeOS no longer holds your Facebook sign-in, your name or your Facebook id, and your Pages stopped answering their messages here. Messages customers sent a business stay with that business, as its own records.</p>`,
        ),
      );
  });

  if (meta.fake) registerFakeMetaRoutes(app, deps);
}

/** Constant-time, so a wrong verify token says nothing about the right one. */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.equals(y);
}

function signedRequest(deps: HttpDeps, req: FastifyRequest): { userId: string } | null {
  const body = (req.body ?? {}) as { signed_request?: string };
  if (!deps.social.appSecret) return null;
  const who = readSignedRequest(body.signed_request, deps.social.appSecret);
  if (!who) deps.log.warn('refused a Facebook callback with a bad signed_request');
  return who;
}

async function stopSignIns(deps: HttpDeps, facebookUserId: string, forget: boolean): Promise<void> {
  const found = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ connection_id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select connection_id, workspace_id, organization_id
          from private.meta_connections_of(${facebookUserId}, ${forget})`,
    ),
  );
  for (const c of found) {
    const scope = { workspaceId: c.workspace_id, organizationId: c.organization_id };
    try {
      await executeCommand(
        deps.httpDb,
        metaConnectionDisconnect,
        {
          workspaceId: c.workspace_id,
          connectionId: c.connection_id,
          reason: 'revoked',
          ...(forget ? { forget: true } : {}),
        },
        systemActor(scope),
        workerMeta(),
      );
    } catch (e) {
      deps.log.warn(
        { connectionId: c.connection_id, err: errorMessage(e) },
        'could not stop a Facebook sign-in Facebook said was removed',
      );
    }
  }
}

/**
 * Each event of a webhook, stored for the processor, for a Page or account somebody here answers. One nobody
 * answers any more is taken and dropped: Meta keeps sending for a while after a Page is let go.
 */
export async function storeEvents(deps: HttpDeps, body: unknown, url: string): Promise<number> {
  const routes = new Map<
    string,
    { account_id: string; workspace_id: string; organization_id: string } | null
  >();
  let stored = 0;
  for (const e of splitWebhook(body)) {
    const key = `${e.platform}:${e.accountExternalId}`;
    if (!routes.has(key)) {
      const [route] = await asWorker(deps.httpDb, {}, (tx) =>
        rows<{ account_id: string; workspace_id: string; organization_id: string }>(
          tx,
          sql`select account_id, workspace_id, organization_id
              from private.meta_account_route(${e.platform}, ${e.accountExternalId})`,
        ),
      );
      routes.set(key, route ?? null);
    }
    const route = routes.get(key);
    if (!route) {
      deps.log.debug({ account: key }, 'a Meta event for a Page nobody here answers');
      continue;
    }
    await recordDelivery(deps, {
      provider: 'meta',
      kind: META_DELIVERY_KIND,
      dedupeKey: e.dedupeKey,
      accountRef: key,
      url,
      params: {
        platform: e.platform,
        accountId: route.account_id,
        accountExternalId: e.accountExternalId,
        standby: e.standby ? '1' : '',
        event: JSON.stringify(e.event),
      },
      workspaceId: route.workspace_id,
      organizationId: route.organization_id,
    });
    stored++;
  }
  return stored;
}

// ---------- the stand-in (development and tests only; production refuses it) ----------

function registerFakeMetaRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const fake = deps.social.fake!;
  const callback = `${deps.publicUrl}/oauth/facebook/callback`;
  const refuse = (reply: FastifyReply) =>
    deadEnd(
      reply,
      400,
      'That sign-in link doesn’t work',
      'Go back to Settings → Facebook & Instagram and try again.',
    );

  app.get('/oauth/fake/meta/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.state || q.redirect_uri !== callback) return refuse(reply);
    const hidden = (k: string, v: string) =>
      `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
    const people = fake.users();
    const option = (u: (typeof people)[number], i: number) =>
      `<label style="display: block; font-size: 14px; margin: 6px 0;"><input type="radio" name="user" value="${escapeHtml(u.id)}"${i === 0 ? ' checked' : ''}> ${escapeHtml(u.name)} <span style="color: #5b616a;">(${u.pageIds.length} Page${u.pageIds.length === 1 ? '' : 's'})</span></label>`;
    return reply
      .type('text/html; charset=utf-8')
      .send(
        shell(
          'Log in with Facebook',
          `<h1 style="font-size: 18px; margin: 0 0 8px;">Log in with Facebook</h1>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">A stand-in for Facebook’s sign-in on this development server. No real Page or Instagram account is touched.</p>` +
            `<form method="get" action="/oauth/fake/meta/approve">` +
            hidden('state', q.state) +
            hidden('redirect_uri', q.redirect_uri) +
            people.map(option).join('') +
            `<label style="display: block; font-size: 13px; margin-top: 12px;"><input type="checkbox" name="instagram" value="1" checked> Allow Instagram messages</label>` +
            `<label style="display: block; font-size: 13px; margin-top: 6px;"><input type="checkbox" name="ads" value="1" checked> Allow reading ads</label>` +
            `<label style="display: block; font-size: 13px; margin-top: 6px;"><input type="checkbox" name="messaging" value="1" checked> Allow managing messages</label>` +
            `<div style="display: flex; gap: 8px; margin-top: 18px;">` +
            `<button type="submit" name="decision" value="allow" data-testid="fake-meta-continue" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #1877f2; color: #fff; font-weight: 600;">Continue</button>` +
            `<button type="submit" name="decision" value="deny" data-testid="fake-meta-cancel" style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Cancel</button>` +
            `</div></form>`,
        ),
      );
  });

  app.get('/oauth/fake/meta/approve', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.state || q.redirect_uri !== callback) return refuse(reply);
    const target = new URL(q.redirect_uri);
    target.searchParams.set('state', q.state);
    const user = fake.users().find((u) => u.id === q.user) ?? fake.users()[0];
    if (q.decision !== 'allow' || !user) {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_reason', 'user_denied');
    } else
      target.searchParams.set(
        'code',
        fake.code({
          userId: user.id,
          scopes: [
            'pages_show_list',
            'pages_manage_metadata',
            'pages_read_engagement',
            'business_management',
            ...(q.messaging === '1' ? ['pages_messaging'] : []),
            ...(q.instagram === '1' ? ['instagram_basic', 'instagram_manage_messages'] : []),
            ...(q.ads === '1' ? ['ads_read'] : []),
          ],
        }),
      );
    return reply.redirect(target.toString(), 302);
  });

  /**
   * Somebody writes to a stand-in Page or Instagram account, or comes to it from an ad: the webhook Meta would send,
   * signed, through the same route. `{ platform, account, from, text?, adId?, ref?, adTitle? }`.
   */
  app.post('/test/meta/webhook', async (req, reply) => {
    const b = (req.body ?? {}) as {
      platform?: 'facebook' | 'instagram';
      account?: string;
      from?: string;
      text?: string;
      adId?: string;
      adTitle?: string;
      ref?: string;
    };
    if (!b.account || !b.from)
      return reply.code(400).send({ error: 'account and from are required' });
    const now = Date.now();
    const referral =
      b.adId || b.ref
        ? {
            source: b.adId ? 'ADS' : 'SHORTLINK',
            type: 'OPEN_THREAD',
            ...(b.ref ? { ref: b.ref } : {}),
            ...(b.adId
              ? { ad_id: b.adId, ads_context_data: { ad_title: b.adTitle ?? 'Spring tune-up' } }
              : {}),
          }
        : null;
    const body = {
      object: b.platform === 'instagram' ? 'instagram' : 'page',
      entry: [
        {
          id: b.account,
          time: now,
          messaging: [
            {
              sender: { id: b.from },
              recipient: { id: b.account },
              timestamp: now,
              message: {
                mid: `m_test_${randomBytes(8).toString('hex')}`,
                text: b.text ?? 'Hi! Do you have any openings this week?',
                ...(referral ? { referral } : {}),
              },
            },
          ],
        },
      ],
    };
    const stored = await storeEvents(deps, body, `${deps.publicUrl}/webhooks/meta`);
    return reply.send({ stored });
  });
}
