/**
 * Connecting mailboxes: the browser comes here from Settings → Email with a one-time state, goes on to
 * Microsoft's or Google's sign-in, and comes back to the callback, which seals the tokens and connects the
 * mailbox. Outlook's change notifications land here too (only as a nudge to sync). With the fake provider,
 * the sign-in page is this server's own, and tests can drop mail into a fake mailbox.
 */
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { executeCommand, mailboxActivate } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { mailboxConnections } from '@hfos/db/schema';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { escapeHtml } from '../emails/templates';
import { fakeCode } from '../mailbox/fake';
import { party, pkcePair, type MailboxProviderName } from '../mailbox/provider';
import { PROVIDER_NAME, sha256Hex, syncSoon } from '../mailbox/sync';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta, type TenantScope } from '../services';
import type { HttpDeps } from './common';

const isProvider = (p: string): p is MailboxProviderName => p === 'microsoft' || p === 'google';

type StateRow = {
  connection_id: string;
  workspace_id: string;
  organization_id: string;
  provider: MailboxProviderName;
  status: string;
  state_expires_at: Date | string | null;
};

interface GraphItem {
  subscriptionId?: string;
  clientState?: string;
  lifecycleEvent?: string;
}

const shell = (title: string, inner: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
  `<body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; background: #f7f8fa; margin: 0;">` +
  `<main style="max-width: 440px; margin: 12vh auto; background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 28px 30px;">${inner}</main></body></html>`;

/** A plain page for the rare dead ends (an expired link, a provider that isn't set up). */
function deadEnd(
  reply: FastifyReply,
  status: number,
  title: string,
  body: string,
  link?: { href: string; label: string },
) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      shell(
        title,
        `<h1 style="font-size: 18px; margin: 0 0 8px;">${escapeHtml(title)}</h1>` +
          `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0;">${escapeHtml(body)}</p>` +
          (link
            ? `<p style="margin: 20px 0 0;"><a href="${escapeHtml(link.href)}" style="color: #2d69d8; font-weight: 600; text-decoration: none;">${escapeHtml(link.label)}</a></p>`
            : ''),
      ),
    );
}

export function registerMailboxRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const { providers, fake } = deps.mailboxes;
  const callbackUrl = (p: MailboxProviderName) => `${deps.publicUrl}/oauth/${p}/callback`;
  const settingsUrl = (workspaceId: string) => `${deps.webUrl}/app/w/${workspaceId}/settings/email`;
  const scopeOf = (row: StateRow): TenantScope => ({
    workspaceId: row.workspace_id,
    organizationId: row.organization_id,
  });

  /** The mailbox waiting on this sign-in: pending, for this provider, and within its ten minutes. */
  async function waiting(provider: string, state: string | undefined): Promise<StateRow | null> {
    if (!isProvider(provider) || !state || state.length > 200) return null;
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<StateRow>(
        tx,
        sql`select connection_id, workspace_id, organization_id, provider, status, state_expires_at
            from private.mailbox_connection_by_state(${sha256Hex(state)})`,
      ),
    );
    if (!row || row.provider !== provider || row.status !== 'pending' || !row.state_expires_at)
      return null;
    return new Date(row.state_expires_at).getTime() > Date.now() ? row : null;
  }
  const expired = (reply: FastifyReply) =>
    deadEnd(
      reply,
      400,
      'This sign-in link has expired',
      'Sign-in links last ten minutes. Go back to Settings, open Email, and choose Connect again.',
    );

  app.get('/oauth/:provider/start', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { state } = req.query as { state?: string };
    const row = await waiting(provider, state);
    if (!row || !state) return expired(reply);
    const p = providers[row.provider];
    const name = PROVIDER_NAME[row.provider];
    if (!p.configured)
      return deadEnd(
        reply,
        503,
        `${name} isn’t set up yet`,
        `This server can’t connect ${name} mailboxes yet.`,
        {
          href: settingsUrl(row.workspace_id),
          label: 'Back to Settings',
        },
      );
    // PKCE: the verifier stays here, sealed; only its hash travels with the browser.
    const { verifier, challenge } = pkcePair();
    await asWorker(deps.httpDb, scopeOf(row), (tx) =>
      tx
        .update(mailboxConnections)
        .set({ pkceVerifierEnc: deps.sealer.seal(verifier) })
        .where(eq(mailboxConnections.id, row.connection_id)),
    );
    return reply
      .header('referrer-policy', 'no-referrer')
      .redirect(
        p.authorizeUrl({ state, codeChallenge: challenge, redirectUri: callbackUrl(row.provider) }),
        302,
      );
  });

  app.get('/oauth/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = req.query as { state?: string; code?: string; error?: string };
    const row = await waiting(provider, q.state);
    if (!row) return expired(reply);
    const scope = scopeOf(row);
    const back = (result: string) =>
      reply
        .header('referrer-policy', 'no-referrer')
        .redirect(`${settingsUrl(row.workspace_id)}?mailbox=${result}`, 302);
    const note = (error: string) =>
      asWorker(deps.httpDb, scope, (tx) =>
        tx
          .update(mailboxConnections)
          .set({ lastError: error.slice(0, 2000) })
          .where(eq(mailboxConnections.id, row.connection_id)),
      );
    if (q.error || !q.code) {
      await note(`The sign-in ended without access (${(q.error ?? 'no code').slice(0, 80)}).`);
      return back(q.error === 'access_denied' ? 'cancelled' : 'failed');
    }
    const [m] = await asWorker(deps.httpDb, scope, (tx) =>
      tx
        .select({ verifier: mailboxConnections.pkceVerifierEnc })
        .from(mailboxConnections)
        .where(eq(mailboxConnections.id, row.connection_id)),
    );
    if (!m?.verifier) return back('failed');
    const p = providers[row.provider];
    try {
      const tokens = await p.exchangeCode({
        code: q.code,
        codeVerifier: deps.sealer.open(m.verifier),
        redirectUri: callbackUrl(row.provider),
      });
      if (p.missingScopes(tokens.scopes).length > 0) {
        await note('Some permissions were left unticked on the sign-in screen.');
        return back('missing_permissions');
      }
      const account = await p.account(tokens.accessToken);
      await executeCommand(
        deps.httpDb,
        mailboxActivate,
        {
          workspaceId: row.workspace_id,
          connectionId: row.connection_id,
          accountEmail: account.email,
          displayName: account.displayName,
          scopes: tokens.scopes.slice(0, 50).map((s) => s.slice(0, 200)),
          tokenEnc: deps.sealer.seal(JSON.stringify(tokens)),
          tokenKeyId: deps.sealer.keyId,
          tokenExpiresAt: tokens.expiresAt,
        },
        systemActor(scope),
        workerMeta(),
      );
      return back('connected');
    } catch (e) {
      deps.log.warn(
        { connectionId: row.connection_id, err: errorMessage(e) },
        'a mailbox did not connect',
      );
      await note(errorMessage(e));
      return back('failed');
    }
  });

  // Graph checks a new subscription's URLs with an empty text/plain POST.
  if (!app.hasContentTypeParser('text/plain'))
    app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
  /** The validation handshake: echo the token back as plain text within ten seconds. */
  const handshake = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const token = (req.query as { validationToken?: string }).validationToken;
    if (token === undefined) return false;
    void reply.code(200).type('text/plain; charset=utf-8').send(token);
    return true;
  };
  /** The mailbox a notification is for, if its clientState matches the one we made (compared as hashes). */
  async function verified(item: GraphItem): Promise<{ id: string; scope: TenantScope } | null> {
    if (!item.subscriptionId || !item.clientState) return null;
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{
        connection_id: string;
        workspace_id: string;
        organization_id: string;
        client_state_hash: string | null;
      }>(tx, sql`select * from private.mailbox_connection_by_subscription(${item.subscriptionId})`),
    );
    if (!row?.client_state_hash) return null;
    const given = Buffer.from(sha256Hex(item.clientState));
    const expected = Buffer.from(row.client_state_hash);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      deps.log.warn('ignored an Outlook notification with the wrong clientState');
      return null;
    }
    return {
      id: row.connection_id,
      scope: { workspaceId: row.workspace_id, organizationId: row.organization_id },
    };
  }
  const items = (req: FastifyRequest): GraphItem[] =>
    (((req.body ?? {}) as { value?: GraphItem[] }).value ?? []).slice(0, 100);

  // Answer fast (Graph wants 2xx within three seconds): a notification only brings the sync forward.
  app.post('/webhooks/graph/notifications', async (req, reply) => {
    if (handshake(req, reply)) return reply;
    for (const item of items(req)) {
      const box = await verified(item);
      if (box) await syncSoon(deps.httpDb, box.scope, box.id);
    }
    return reply.code(202).send();
  });

  app.post('/webhooks/graph/lifecycle', async (req, reply) => {
    if (handshake(req, reply)) return reply;
    for (const item of items(req)) {
      const box = await verified(item);
      if (!box) continue;
      // Removed: the next sync makes a new subscription. Needs reauthorizing: renewing does that.
      if (
        item.lifecycleEvent === 'subscriptionRemoved' ||
        item.lifecycleEvent === 'reauthorizationRequired'
      )
        await asWorker(deps.httpDb, box.scope, (tx) =>
          tx
            .update(mailboxConnections)
            .set(
              item.lifecycleEvent === 'subscriptionRemoved'
                ? { subscriptionId: null, subscriptionExpiresAt: null }
                : { subscriptionExpiresAt: new Date(Date.now() + 60_000) },
            )
            .where(eq(mailboxConnections.id, box.id)),
        );
      await syncSoon(deps.httpDb, box.scope, box.id);
    }
    return reply.code(202).send();
  });

  if (!fake) return;

  // ---------- the fake provider (development and tests only; production refuses it) ----------
  app.get('/oauth/fake/:provider/authorize', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = req.query as Record<string, string | undefined>;
    if (
      !isProvider(provider) ||
      !q.state ||
      !q.code_challenge ||
      q.redirect_uri !== callbackUrl(provider)
    )
      return deadEnd(
        reply,
        400,
        'That sign-in link doesn’t work',
        'Go back to Settings and try again.',
      );
    const name = PROVIDER_NAME[provider];
    const hidden = (k: string, v: string) =>
      `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
    return reply
      .type('text/html; charset=utf-8')
      .send(
        shell(
          `Sign in to ${name}`,
          `<h1 style="font-size: 18px; margin: 0 0 8px;">Sign in to ${name}</h1>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">A stand-in for ${name}’s sign-in on this development server. No real mailbox is touched.</p>` +
            `<form method="get" action="/oauth/fake/${provider}/approve">` +
            hidden('state', q.state) +
            hidden('code_challenge', q.code_challenge) +
            hidden('redirect_uri', q.redirect_uri) +
            `<label for="email" style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px;">Email address</label>` +
            `<input id="email" name="email" type="email" required value="owner@${provider === 'microsoft' ? 'outlook' : 'gmail'}.fake" style="width: 100%; box-sizing: border-box; height: 38px; padding: 0 10px; border: 1px solid #c9ced6; border-radius: 8px; font-size: 15px;">` +
            `<div style="display: flex; gap: 8px; margin-top: 18px;">` +
            `<button type="submit" name="decision" value="allow" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #2d69d8; color: #fff; font-weight: 600;">Allow</button>` +
            `<button type="submit" name="decision" value="deny" formnovalidate style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Cancel</button>` +
            `</div></form>`,
        ),
      );
  });

  app.get('/oauth/fake/:provider/approve', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = req.query as Record<string, string | undefined>;
    // The fake only ever answers our own callback.
    if (!isProvider(provider) || !q.state || q.redirect_uri !== callbackUrl(provider))
      return deadEnd(
        reply,
        400,
        'That sign-in link doesn’t work',
        'Go back to Settings and try again.',
      );
    const target = new URL(q.redirect_uri);
    target.searchParams.set('state', q.state);
    if (q.decision !== 'allow' || !q.email) target.searchParams.set('error', 'access_denied');
    else target.searchParams.set('code', fakeCode(provider, q.email, q.code_challenge ?? ''));
    return reply.redirect(target.toString(), 302);
  });

  /** Someone emails a fake mailbox. Its next sync (every few seconds) brings it in. */
  app.post('/test/mailboxes/deliver', async (req, reply) => {
    const b = (req.body ?? {}) as {
      account?: string;
      from?: { address?: string; name?: string };
      subject?: string;
      text?: string;
      html?: string;
      attachments?: { name: string; contentType: string; content: string }[];
    };
    const from = party(b.from?.address, b.from?.name);
    if (!b.account || !from)
      return reply.code(400).send({ error: 'account and from.address are required' });
    const id = fake.deliver(b.account, {
      from,
      subject: b.subject ?? '(no subject)',
      text: b.text ?? '',
      html: b.html ?? null,
      files: (b.attachments ?? []).slice(0, 10).map((a) => ({
        name: a.name,
        contentType: a.contentType,
        content: Buffer.from(a.content, 'base64'),
        contentId: null,
      })),
    });
    return reply.send({ providerMessageId: id });
  });
}
