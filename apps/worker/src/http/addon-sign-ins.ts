/**
 * Signing in to a service for one of a business's add-ons (round five, 20261021000500): the worker's side of an
 * add-on's Connect button, for a service its manifest connects by `oauth` (DocuSign, Dotloop).
 *
 * - `POST /v1/addons/connections/sign-in`: a person who may manage the connector, in a business where the add-on is
 *   on, starts. The state (hashed) and PKCE verifier (sealed) wait ten minutes; the answer is the service's sign-in
 *   page.
 * - `GET /oauth/addon/callback`: the service's answer. It connects nothing: what came back is sealed and handed to
 *   the app (`handoff.ts`, door `addon`).
 * - `POST /v1/addons/connections/finish`: the app, signed in, finishing. Only the person who pressed Connect gets
 *   any further; the code is swapped for tokens, which are sealed and kept, and the browser goes back to the add-on's
 *   Connections.
 * - With the stand-ins, the sign-in page is this server's own (`/oauth/fake/addon/…`) and the tokens are made up.
 */
import { randomBytes } from 'node:crypto';
import {
  ADDON_CATALOG,
  addonConnectionCommands,
  connectorOf,
  executeCommand,
  HfosError,
  type Catalog,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectionRefused } from '../addons/connections';
import { ADDON_WORKER_MODULES } from '../addons/modules';
import { fakeOAuthAccount, oauthAppOf, type OAuthAccount } from '../addons/sign-ins';
import type { AddonWorkerModule } from '../addons/types';
import { escapeHtml } from '../emails/templates';
import { pkcePair } from '../mailbox/provider';
import { sha256Hex } from '../mailbox/sync';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta } from '../services';
import { authenticate, parseBody, requirePermission, type HttpDeps } from './common';
import {
  finishUrl,
  HandoffBody,
  NOT_YOURS,
  openHandoff,
  sealHandoff,
  type FinishOutcome,
} from './handoff';
import { deadEnd, shell } from './oauth';

const slug = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const SignInInput = z.strictObject({
  workspaceId: z.uuid(),
  addonId: z.string().regex(/^[a-z]{2,16}$/),
  connector: slug,
  provider: slug,
});

interface StateRow extends Record<string, unknown> {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly organization_id: string;
  readonly addon_id: string;
  readonly connector: string;
  readonly provider: string;
  readonly status: string;
  readonly started_by: string | null;
  readonly state_expires_at: Date | string | null;
  readonly pkce_verifier_enc: string | null;
}

const EXPIRED = {
  title: 'This sign-in link has expired',
  body: 'Sign-in links last ten minutes. Go back to the add-on’s Connections and choose Connect again.',
};

export function registerAddonSignInRoutes(
  app: FastifyInstance,
  deps: HttpDeps,
  opts: { readonly catalog?: Catalog; readonly modules?: readonly AddonWorkerModule[] } = {},
): void {
  const catalog = opts.catalog ?? ADDON_CATALOG;
  const modules = opts.modules ?? ADDON_WORKER_MODULES;
  const { beginSignIn, endSignIn, save } = addonConnectionCommands(catalog);
  const fake = () => deps.addonConnect?.fake ?? true;
  const redirectUri = `${deps.publicUrl}/oauth/addon/callback`;
  const oauthOf = (addonId: string, connector: string, provider: string) =>
    modules.find((m) => m.manifest.id === addonId)?.oauth?.[connector]?.[provider] ?? null;
  const connectionsUrl = (workspaceId: string, addonId: string) =>
    `${deps.webUrl}/app/w/${workspaceId}/addons/${addonId}/connections`;

  async function lookup(stateHash: string): Promise<StateRow | null> {
    const [row] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<StateRow>(
        tx,
        sql`select * from private.addon_connection_by_state(${Buffer.from(stateHash, 'hex')})`,
      ),
    );
    if (!row || !row.state_expires_at || new Date(row.state_expires_at).getTime() < Date.now())
      return null;
    return row;
  }

  const end = (row: StateRow, error: string) =>
    executeCommand(
      deps.httpDb,
      endSignIn,
      {
        workspaceId: row.workspace_id,
        connectionId: row.connection_id,
        error: error.slice(0, 500),
      },
      systemActor({ workspaceId: row.workspace_id, organizationId: row.organization_id }),
      workerMeta(),
    );

  /** Starts a sign-in: the service's page to send the browser to. */
  app.post('/v1/addons/connections/sign-in', async (req) => {
    const actor = await authenticate(deps, req);
    const input = parseBody(SignInInput, req.body);
    const { connector, provider } = connectorOf(
      catalog,
      input.addonId,
      input.connector,
      input.provider,
    );
    const manifest = catalog.find((m) => m.id === input.addonId)!;
    const [on] = await asWorker(deps.httpDb, {}, (tx) =>
      rows<{ ok: boolean; organization_id: string | null }>(
        tx,
        sql`select private.addon_in_use(${input.workspaceId}::uuid, ${input.addonId}, false) as ok,
                   private.workspace_organization(${input.workspaceId}::uuid) as organization_id`,
      ),
    );
    if (!on?.organization_id)
      throw HfosError.notFound(
        'This workspace isn’t there anymore. Refresh the page and try again.',
      );
    if (!on.ok) throw HfosError.addonInactive(manifest);
    await requirePermission(deps, actor.userId, input.workspaceId, connector.permission);
    if (!provider.auth.includes('oauth'))
      throw HfosError.rule(
        'addon_connector_auth',
        409,
        `${provider.label} doesn’t connect by signing in here. Use what its Connections offers.`,
      );
    const oauth = oauthOf(input.addonId, input.connector, input.provider);
    const oauthApp = oauthAppOf(deps, input.addonId, input.provider);
    if (!fake() && (!oauth || !oauthApp))
      throw HfosError.rule(
        'addon_sign_in_not_set_up',
        503,
        `${provider.label} can’t be signed in to on this server yet. Ask HandsFreeOS support to set it up.`,
      );
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = pkcePair();
    await executeCommand(
      deps.httpDb,
      beginSignIn,
      {
        workspaceId: input.workspaceId,
        addonId: input.addonId,
        connector: input.connector,
        provider: input.provider,
        stateHash: sha256Hex(state),
        pkceVerifierEnc: deps.sealer.seal(verifier),
        startedBy: actor.userId,
      },
      systemActor(
        { workspaceId: input.workspaceId, organizationId: on.organization_id },
        actor.userId,
      ),
      workerMeta(),
    );
    const url = fake()
      ? `${deps.publicUrl}/oauth/fake/addon/authorize?${new URLSearchParams({
          state,
          code_challenge: challenge,
          redirect_uri: redirectUri,
          service: provider.label,
        }).toString()}`
      : oauth!.authorizeUrl({ app: oauthApp!, state, codeChallenge: challenge, redirectUri });
    return { url };
  });

  /** The service's answer, sealed and handed to the app: nothing is connected here. */
  app.get('/oauth/addon/callback', async (req, reply) => {
    const q = req.query as {
      state?: string;
      code?: string;
      error?: string;
      error_description?: string;
    };
    const row = q.state ? await lookup(sha256Hex(q.state)) : null;
    if (!row || !q.state) return deadEnd(reply, 410, EXPIRED.title, EXPIRED.body);
    const sealed = sealHandoff(deps.sealer, {
      door: 'addon',
      provider: `${row.addon_id}:${row.provider}`,
      stateHash: sha256Hex(q.state),
      code: q.code?.slice(0, 4000) ?? null,
      error: q.error?.slice(0, 200) ?? null,
      errorDescription: q.error_description?.slice(0, 500) ?? null,
    });
    return reply
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .redirect(finishUrl(deps.webUrl, 'addon', sealed), 302);
  });

  /** The app, signed in, finishing: only the person who pressed Connect. */
  app.post('/v1/addons/connections/finish', async (req, reply): Promise<FinishOutcome> => {
    reply.header('cache-control', 'no-store');
    const actor = await authenticate(deps, req);
    const { handoff } = parseBody(HandoffBody, req.body);
    const h = openHandoff(deps.sealer, handoff, 'addon');
    const row = h ? await lookup(h.stateHash) : null;
    if (!h || !row || `${row.addon_id}:${row.provider}` !== h.provider) return { page: EXPIRED };
    const back = connectionsUrl(row.workspace_id, row.addon_id);
    if (row.started_by !== actor.userId) {
      deps.log.warn(
        { connectionId: row.connection_id },
        'an add-on sign-in came back to somebody other than the person who started it',
      );
      await end(row, 'The sign-in was finished by somebody other than the person who started it.');
      return { page: NOT_YOURS };
    }
    const { provider } = connectorOf(catalog, row.addon_id, row.connector, row.provider);
    if (h.error || !h.code) {
      await end(row, `The sign-in ended without access (${(h.error ?? 'no code').slice(0, 80)}).`);
      return { next: `${back}?signin=${h.error === 'access_denied' ? 'cancelled' : 'failed'}` };
    }
    let account: OAuthAccount;
    try {
      if (fake()) account = fakeOAuthAccount(row.provider, provider.label);
      else {
        const oauth = oauthOf(row.addon_id, row.connector, row.provider);
        const oauthApp = oauthAppOf(deps, row.addon_id, row.provider);
        if (!oauth || !oauthApp || !row.pkce_verifier_enc) {
          await end(row, 'This server can’t finish that sign-in.');
          return { page: EXPIRED };
        }
        account = await oauth.exchange(
          {
            app: oauthApp,
            code: h.code,
            codeVerifier: deps.sealer.open(row.pkce_verifier_enc),
            redirectUri,
          },
          AbortSignal.timeout(20_000),
        );
      }
    } catch (e) {
      const words =
        e instanceof ConnectionRefused
          ? e.message
          : `${provider.label} didn’t answer just now, so nothing was connected. Try again in a minute.`;
      if (!(e instanceof ConnectionRefused))
        deps.log.warn(
          { connectionId: row.connection_id, err: errorMessage(e) },
          'an add-on sign-in failed',
        );
      await end(row, words);
      return {
        page: {
          title: 'That didn’t connect',
          body: words,
          link: { href: back, label: 'Back to Connections' },
        },
      };
    }
    await executeCommand(
      deps.httpDb,
      save,
      {
        workspaceId: row.workspace_id,
        addonId: row.addon_id,
        connector: row.connector,
        provider: row.provider,
        auth: 'oauth',
        label: account.label?.slice(0, 200) || null,
        accountRef: account.accountRef?.slice(0, 200) || null,
        details: account.details ?? {},
        secretEnc: deps.sealer.seal(JSON.stringify(account.tokens)),
        keyId: deps.sealer.keyId,
        tokenExpiresAt: account.expiresAt,
        connectedBy: actor.userId,
      },
      systemActor(
        { workspaceId: row.workspace_id, organizationId: row.organization_id },
        actor.userId,
      ),
      workerMeta(),
    );
    return { next: `${back}?connected=${row.provider}` };
  });

  // ---------- the stand-in sign-in page (development and tests) ----------

  app.get('/oauth/fake/addon/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!fake() || !q.state || !q.code_challenge || q.redirect_uri !== redirectUri)
      return deadEnd(
        reply,
        400,
        'That sign-in link doesn’t work',
        'Go back to Connections and try again.',
      );
    const name = (q.service ?? 'the service').slice(0, 80);
    const hidden = (k: string, v: string) =>
      `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
    return reply
      .type('text/html; charset=utf-8')
      .send(
        shell(
          `Sign in to ${name}`,
          `<h1 style="font-size: 18px; margin: 0 0 8px;">Sign in to ${escapeHtml(name)}</h1>` +
            `<p style="font-size: 14px; line-height: 1.5; color: #5b616a; margin: 0 0 18px;">A stand-in for ${escapeHtml(name)}’s sign-in on this development server. No real account is touched.</p>` +
            `<form method="get" action="/oauth/fake/addon/approve">` +
            hidden('state', q.state) +
            hidden('redirect_uri', q.redirect_uri) +
            `<div style="display: flex; gap: 8px;">` +
            `<button type="submit" name="decision" value="allow" style="height: 36px; padding: 0 16px; border: 0; border-radius: 8px; background: #2d69d8; color: #fff; font-weight: 600;">Allow</button>` +
            `<button type="submit" name="decision" value="deny" style="height: 36px; padding: 0 16px; border: 1px solid #c9ced6; border-radius: 8px; background: #fff;">Cancel</button>` +
            `</div></form>`,
        ),
      );
  });

  app.get('/oauth/fake/addon/approve', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!fake() || !q.state || q.redirect_uri !== redirectUri)
      return deadEnd(
        reply,
        400,
        'That sign-in link doesn’t work',
        'Go back to Connections and try again.',
      );
    const back = new URL(redirectUri);
    back.searchParams.set('state', q.state);
    if (q.decision === 'allow')
      back.searchParams.set('code', `fake-${randomBytes(8).toString('hex')}`);
    else back.searchParams.set('error', 'access_denied');
    return reply.redirect(back.toString(), 302);
  });
}
