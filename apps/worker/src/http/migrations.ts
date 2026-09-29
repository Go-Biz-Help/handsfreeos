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
 * `/migrations/token` is the second door (0069): a private integration token the business made in its own
 * sub-account, posted here with that sub-account's id. It is posted straight from the screen to the worker
 * and never through the API, for one reason — the seal lives here, so this is the only process that can hold
 * a credential at all. It is a POST, not a link, because a token in a URL is a token in a log.
 *
 * Every token that arrives here is sealed before it touches the database and is never logged, never returned
 * and never shown. The state is random, hashed at rest, single use and good for ten minutes, whichever door
 * it belongs to — and a state made for one door is refused at the other.
 *
 * **The callback connects nothing** (SEC-M7). A state travels in a link, and an agency's sign-in approved from a
 * forwarded one would be sealed into the sender's organization, every sub-account with it. So the callback hands
 * what came back to the app (`handoff.ts`), and `/v1/migrations/finish` exchanges the code only when the app posts
 * it back signed in as the person who pressed Connect.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { HfosError } from '@hfos/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { escapeHtml } from '../emails/templates';
import { recordSystemEvent } from '../system-event';
import type { MigrationAdapters } from '../migrations/adapters/registry';
import { activateConnection, sealTokens } from '../migrations/engine/connection';
import { authenticate, parseBody, type HttpDeps } from './common';
import {
  finishUrl,
  HandoffBody,
  NOT_YOURS,
  openHandoff,
  sealHandoff,
  type FinishOutcome,
} from './handoff';

type StateRow = {
  connection_id: string;
  organization_id: string;
  source_system: string;
  install_kind: string;
  auth_kind: 'oauth' | 'private_token';
  status: string;
  state_expires_at: Date | string | null;
};

/**
 * What the paste-a-token screen sends. The token is bounded rather than trusted: GoHighLevel's own are short,
 * and a megabyte of "token" is not a typo anybody made.
 */
const TokenBody = z.object({
  state: z.string().trim().min(16).max(200),
  token: z.string().trim().min(8, 'Paste the token.').max(4000),
  /** The sub-account the token belongs to — GoHighLevel calls it the Location ID. */
  accountId: z.string().trim().min(1, 'Paste the Location ID.').max(200),
});

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
  /**
   * Where a finished sign-in goes: the business's own Migrations page when it was connected from one, since only an
   * agency's owners and admins can open the agency's; the agency's otherwise.
   */
  const backTo = async (row: StateRow, extra = '') => {
    const [c] = await asWorker(deps.httpDb, { organizationId: row.organization_id }, (tx) =>
      rows<{ workspace_id: string | null }>(
        tx,
        sql`select workspace_id from app.migration_connections where id = ${row.connection_id}`,
      ),
    );
    return c?.workspace_id
      ? `${deps.webUrl}/app/w/${c.workspace_id}/settings/migrations${extra}`
      : `${deps.webUrl}/app/org/${row.organization_id}/migrations${extra}`;
  };

  /** The pending sign-in a state belongs to, checked in constant time. */
  const stateRow = async (state: string | undefined): Promise<StateRow | null> => {
    if (!state) return null;
    return stateRowByHash(sha256Hex(state), state);
  };
  /** The same, by the state's hash: what a handoff carries back. */
  const stateRowByHash = async (hash: string, state?: string): Promise<StateRow | null> => {
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<StateRow>(
        tx,
        sql`select connection_id, organization_id, source_system, install_kind, auth_kind, status,
              state_expires_at
            from private.migration_connection_by_state(${hash})`,
      ),
    );
    if (!row) return null;
    // The lookup is by hash already; this guards against a timing difference on the way in.
    if (state !== undefined) {
      const a = Buffer.from(hash);
      const b = Buffer.from(sha256Hex(state));
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    }
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
    // A state belongs to one door. This one signs in; the other is pasted to.
    if (row.auth_kind !== 'oauth')
      return deadEnd(
        reply,
        400,
        'That link is for a different way in',
        'That connection was started as a pasted token. Start again from Migrations.',
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

  /**
   * The source's answer. Nothing is exchanged here: whoever this browser belongs to is not known, so what came
   * back is sealed and handed to the app, which finishes it signed in (`/v1/migrations/finish`).
   */
  const handleCallback = async (
    req: {
      query: { state?: string; code?: string; error?: string };
    },
    reply: FastifyReply,
  ) => {
    const row = await stateRow(req.query.state);
    if (!row || row.auth_kind !== 'oauth')
      return deadEnd(
        reply,
        410,
        'That sign-in has expired',
        'Start connecting the old system again from Migrations.',
      );
    const sealed = sealHandoff(deps.sealer, {
      door: 'migration',
      provider: '',
      stateHash: sha256Hex(req.query.state!),
      code: req.query.code?.slice(0, 4000) ?? null,
      error: req.query.error?.slice(0, 200) ?? null,
      errorDescription: null,
    });
    return reply
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .redirect(finishUrl(deps.webUrl, 'migration', sealed), 302);
  };

  const expiredPage: FinishOutcome = {
    page: {
      title: 'That sign-in has expired',
      body: 'Start connecting the old system again from Migrations.',
    },
  };

  /**
   * The app, signed in, finishing what the callback handed it. Only the person who pressed Connect gets any
   * further; anybody else ends the sign-in, so a forwarded link can't be tried twice.
   */
  app.post('/v1/migrations/finish', async (req, reply): Promise<FinishOutcome> => {
    const actor = await authenticate(deps, req);
    const { handoff } = parseBody(HandoffBody, req.body);
    reply.header('cache-control', 'no-store');
    const h = openHandoff(deps.sealer, handoff, 'migration');
    if (!h) return expiredPage;
    const row = await stateRowByHash(h.stateHash);
    if (!row || row.auth_kind !== 'oauth') return expiredPage;
    const [started] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ by: string | null }>(
        tx,
        sql`select private.oauth_state_started_by(${h.stateHash}) as by`,
      ),
    );
    if (!started?.by || started.by !== actor.userId) {
      deps.log.warn(
        { connectionId: row.connection_id },
        'a source sign-in came back to somebody other than the person who started it',
      );
      await asWorker(deps.httpDb, { organizationId: row.organization_id }, (tx) =>
        tx.execute(sql`
            update app.migration_connections
               set status = 'error',
                   last_error = 'The sign-in was finished by somebody other than the person who started it.',
                   oauth_state_hash = null, oauth_state_expires_at = null
             where id = ${row.connection_id}`),
      );
      return { page: NOT_YOURS };
    }
    if (h.error || !h.code) {
      await asWorker(deps.httpDb, { organizationId: row.organization_id }, (tx) =>
        tx.execute(sql`
            update app.migration_connections
               set status = 'error', last_error = ${String(h.error ?? 'no code').slice(0, 2000)},
                   oauth_state_hash = null, oauth_state_expires_at = null
             where id = ${row.connection_id}`),
      );
      return { next: await backTo(row, '?connect=cancelled') };
    }
    const adapter = adapters.get(row.source_system);
    if (!adapter)
      return {
        page: { title: 'Not set up on this server', body: 'Nothing here can read that system.' },
      };

    try {
      const connection = await adapter.exchangeCode({
        code: h.code,
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
      return { next: await backTo(row, '?connected=1') };
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
      return { next: await backTo(row, '?connect=failed') };
    }
  });

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

  /**
   * The second door: a private integration token, pasted.
   *
   * It answers JSON rather than redirecting, because the screen that posted it is still open and can say what
   * went wrong in place — which matters here in a way it does not for a sign-in, since the two things most
   * likely to be wrong are a mistyped Location ID and access nobody ticked when the token was made.
   *
   * A rejected token leaves the one-time state alive so the same dialog can correct a typo and try again,
   * until the ten minutes are up or ten tries have been used. Nothing is stored until GoHighLevel has
   * actually answered with it: a token nobody has tried is a connection that fails in the middle of an
   * import a week later.
   */
  app.post('/migrations/token', async (req, reply) => {
    const body = parseBody(TokenBody, req.body);
    const row = await stateRow(body.state);
    if (!row || row.auth_kind !== 'private_token')
      throw HfosError.rule(
        'migration_state_expired',
        410,
        'That form has expired. Start connecting the old system again from Migrations.',
      );
    const adapter = adapters.get(row.source_system);
    if (!adapter?.connectWithToken)
      throw HfosError.rule(
        'migration_token_unavailable',
        501,
        'That system can’t be connected with a pasted token here. Start again from Migrations and choose to sign in to it instead.',
      );

    let connection;
    try {
      connection = await adapter.connectWithToken({
        token: body.token,
        accountId: body.accountId,
      });
    } catch (e) {
      // Never the body of the answer, and never a log line: what was posted here is a live credential.
      deps.log.warn({ connectionId: row.connection_id }, 'a pasted source token was not accepted');
      const why = (e as Error).message.slice(0, 300);
      const [state] = await asWorker(deps.httpDb, { organizationId: row.organization_id }, (tx) =>
        rows<{ failures: number }>(
          tx,
          sql`update app.migration_connections
                   set failures = failures + 1, last_error = ${why}
                 where id = ${row.connection_id}
             returning failures`,
        ),
      );
      // Enough wrong tries and the door closes rather than staying open for the rest of its ten minutes.
      if ((state?.failures ?? 0) >= 10)
        await asWorker(deps.httpDb, { organizationId: row.organization_id }, (tx) =>
          tx.execute(sql`
            update app.migration_connections
               set status = 'error', oauth_state_hash = null, oauth_state_expires_at = null
             where id = ${row.connection_id}`),
        );
      throw HfosError.rule('migration_token_rejected', 400, why);
    }

    await asWorker(deps.httpDb, { organizationId: row.organization_id }, async (tx) => {
      // Sealed before it touches the database, exactly like a sign-in's. No refresh token and no expiry:
      // a private token has neither.
      await tx.execute(sql`
        update app.migration_connections
           set token_enc = ${sealTokens(deps.sealer, {
             accessToken: connection.accessToken,
             refreshToken: null,
           })},
               token_key_id = ${deps.sealer.keyId}, token_expires_at = null
         where id = ${row.connection_id}`);
      await activateConnection(tx, {
        connectionId: row.connection_id,
        organizationId: row.organization_id,
        sourceSystem: row.source_system,
        externalAccountId: connection.externalAccountId ?? body.accountId,
        displayName: connection.displayName ?? null,
        installKind: 'location',
        // A private token never says what it may read, so there is nothing honest to write here. The scan
        // asks each category and reports what came back.
        scopes: [],
        missingScopes: [],
        adapterVersion: adapter.adapterVersion,
      });
      await recordSystemEvent(tx, {
        type: 'migration_connection.connected',
        action: 'migration_connection.connect',
        organizationId: row.organization_id,
        workspaceId: null,
        entityType: 'migration_connection',
        entityId: row.connection_id,
        payload: { source: row.source_system, installKind: 'location', authKind: 'private_token' },
        after: {
          source: row.source_system,
          reaches: 'one business',
          how: 'a private token',
        },
        correlationId: row.connection_id,
        causationId: row.connection_id,
      });
    });

    return reply.header('cache-control', 'no-store').send({
      connectionId: row.connection_id,
      status: 'active',
      displayName: connection.displayName ?? null,
    });
  });
}
