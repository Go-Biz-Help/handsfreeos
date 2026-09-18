/**
 * Signing in to the CRM a business is leaving, and hearing about changes while it is still being used.
 *
 * `/migrations/start` sends the browser on with a one-time state; `/migrations/callback` takes it back,
 * seals the tokens and connects the source. Neither address names the source: the state already says which
 * one it is, and GoHighLevel's marketplace form refuses a redirect URL that mentions HighLevel. Both older
 * `/migrations/:source/…` addresses stay as aliases, so a link in flight and an app registered against the
 * old callback both keep working. The same shape as mailboxes, calendars and payment accounts
 * (`http/oauth.ts`), separately because a migration belongs to the agency rather than to one business, and
 * because the callback has a different place to send somebody afterwards.
 *
 * Every token that arrives here is sealed before it touches the database and is never logged, never returned
 * and never shown. The state is random, hashed at rest, single use and good for ten minutes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { escapeHtml } from '../emails/templates';
import { recordSystemEvent } from '../system-event';
import type { MigrationAdapters } from '../migrations/adapters/registry';
import { activateConnection, sealTokens } from '../migrations/engine/connection';
import type { HttpDeps } from './common';

type StateRow = {
  connection_id: string;
  organization_id: string;
  source_system: string;
  install_kind: string;
  status: string;
  state_expires_at: Date | string | null;
};

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');

const shell = (title: string, inner: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
  `<body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #191d25; background: #f7f8fa; margin: 0;">` +
  `<main style="max-width: 440px; margin: 12vh auto; background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 28px 30px;">${inner}</main></body></html>`;

function deadEnd(reply: FastifyReply, status: number, title: string, body: string) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      shell(
        title,
        `<h1 style="font-size: 18px; margin: 0 0 8px;">${escapeHtml(title)}</h1>` +
          `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0;">${escapeHtml(body)}</p>`,
      ),
    );
}

export function registerMigrationRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  adapters: MigrationAdapters,
): void {
  // No source name in the redirect: GoHighLevel's marketplace form refuses a redirect URL that mentions
  // HighLevel, and the source is already known from the one-time state, so the path never needed it.
  const callbackUrl = () => `${deps.publicUrl}/migrations/callback`;
  const backTo = (organizationId: string, extra = '') =>
    `${deps.webUrl}/app/org/${organizationId}/migrations${extra}`;

  /** The pending sign-in a state belongs to, checked in constant time. */
  const stateRow = async (state: string | undefined): Promise<StateRow | null> => {
    if (!state) return null;
    const hash = sha256Hex(state);
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<StateRow>(
        tx,
        sql`select connection_id, organization_id, source_system, install_kind, status, state_expires_at
            from private.migration_connection_by_state(${hash})`,
      ),
    );
    if (!row) return null;
    // The lookup is by hash already; this guards against a timing difference on the way in.
    const a = Buffer.from(hash);
    const b = Buffer.from(sha256Hex(state));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const expires = row.state_expires_at ? new Date(row.state_expires_at) : null;
    if (!expires || expires.getTime() < Date.now()) return null;
    return row;
  };

  /**
   * Sends the browser on to the old system's own sign-in.
   *
   * The source is not in the path, for the same reason it is not in the callback: the one-time state already
   * says which system this sign-in belongs to, and a name in two places is a name that can disagree with
   * itself. `/migrations/:source/start` stays as an alias so a link already in flight still works, and when
   * it is used the name is checked against the state rather than trusted — a hand-edited or stale link gets
   * told plainly rather than being signed into the wrong system.
   */
  const handleStart = async (
    // Both addresses share this, so `params` is whatever the route it came in on had: the alias carries a
    // source, the plain address carries nothing.
    req: { query: { state?: string }; params: unknown },
    reply: FastifyReply,
  ) => {
    const fromPath = (req.params as { source?: string } | null | undefined)?.source;
    const row = await stateRow(req.query.state);
    if (!row)
      return deadEnd(
        reply,
        410,
        'That link has expired',
        'Start connecting the old system again from Migrations.',
      );
    if (fromPath && row.source_system !== fromPath)
      return deadEnd(
        reply,
        400,
        'That link is for a different system',
        'Start again from Migrations.',
      );
    const adapter = adapters.get(row.source_system);
    if (!adapter)
      return deadEnd(
        reply,
        501,
        'Not set up on this server',
        `Nothing here knows how to read ${row.source_system} yet.`,
      );
    let url: string;
    try {
      url = adapter.authorizeUrl({
        state: req.query.state!,
        redirectUri: callbackUrl(),
      });
    } catch {
      return deadEnd(
        reply,
        501,
        'Not set up on this server',
        'The app for that system has not been configured here yet.',
      );
    }
    return reply.header('cache-control', 'no-store').redirect(url, 302);
  };

  app.get<{ Querystring: { state?: string } }>('/migrations/start', handleStart);
  app.get<{ Params: { source: string }; Querystring: { state?: string } }>(
    '/migrations/:source/start',
    handleStart,
  );

  const handleCallback = async (
    req: {
      query: { state?: string; code?: string; error?: string };
    },
    reply: FastifyReply,
  ) => {
    const row = await stateRow(req.query.state);
    if (!row)
      return deadEnd(
        reply,
        410,
        'That sign-in has expired',
        'Start connecting the old system again from Migrations.',
      );
    if (req.query.error || !req.query.code) {
      await asWorker(deps.httpDb, { organizationId: row.organization_id }, (tx) =>
        tx.execute(sql`
            update app.migration_connections
               set status = 'error', last_error = ${String(req.query.error ?? 'no code').slice(0, 2000)},
                   oauth_state_hash = null, oauth_state_expires_at = null
             where id = ${row.connection_id}`),
      );
      return reply.redirect(backTo(row.organization_id, '?connect=cancelled'), 302);
    }
    const adapter = adapters.get(row.source_system);
    if (!adapter)
      return deadEnd(reply, 501, 'Not set up on this server', 'Nothing here can read that system.');

    try {
      const connection = await adapter.exchangeCode({
        code: req.query.code,
        redirectUri: callbackUrl(),
      });
      // Sealed before it touches the database, exactly like a mailbox or a payment account.
      await asWorker(deps.httpDb, { organizationId: row.organization_id }, (tx) =>
        tx.execute(sql`
            update app.migration_connections
               set token_enc = ${sealTokens(deps.sealer, {
                 accessToken: connection.accessToken,
                 refreshToken: connection.refreshToken ?? null,
               })},
                   token_key_id = ${deps.sealer.keyId},
                   token_expires_at = ${connection.expiresAt?.toISOString() ?? null}
             where id = ${row.connection_id}`),
      );
      // What was asked for and not granted: the difference the scan turns into "we were not allowed to look".
      const granted = new Set(connection.scopes);
      const missing = adapter.requestedScopes.filter((x) => !granted.has(x));
      await asWorker(deps.httpDb, { organizationId: row.organization_id }, async (tx) => {
        await activateConnection(tx, {
          connectionId: row.connection_id,
          organizationId: row.organization_id,
          sourceSystem: row.source_system,
          externalAccountId: connection.externalAccountId ?? 'unknown',
          displayName: null,
          installKind: connection.installKind,
          scopes: [...granted],
          missingScopes: missing,
          adapterVersion: adapter.adapterVersion,
        });
        await recordSystemEvent(tx, {
          type: 'migration_connection.connected',
          action: 'migration_connection.connect',
          organizationId: row.organization_id,
          workspaceId: null,
          entityType: 'migration_connection',
          entityId: row.connection_id,
          payload: {
            source: row.source_system,
            installKind: connection.installKind,
            missingScopes: missing,
          },
          after: {
            source: row.source_system,
            reaches: connection.installKind === 'agency' ? 'every business' : 'one business',
            notAllowedToRead: missing.length,
          },
          correlationId: row.connection_id,
          causationId: row.connection_id,
        });
      });
      return reply.redirect(backTo(row.organization_id, '?connected=1'), 302);
    } catch (e) {
      // Never the body of the answer: a failed exchange can carry the code, and the code is a secret.
      deps.log.warn({ connectionId: row.connection_id }, 'source sign-in did not finish');
      await asWorker(deps.httpDb, { organizationId: row.organization_id }, (tx) =>
        tx.execute(sql`
            update app.migration_connections
               set status = 'error', last_error = ${(e as Error).message.slice(0, 2000)},
                   oauth_state_hash = null, oauth_state_expires_at = null
             where id = ${row.connection_id}`),
      );
      return reply.redirect(backTo(row.organization_id, '?connect=failed'), 302);
    }
  };

  // The address registered with the source. `/migrations/:source/callback` stays so an app still registered
  // with the older address keeps working.
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    '/migrations/callback',
    handleCallback,
  );
  app.get<{
    Params: { source: string };
    Querystring: { state?: string; code?: string; error?: string };
  }>('/migrations/:source/callback', handleCallback);
}
