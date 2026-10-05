/**
 * An add-on's connections by sign-in (round five, 20261021000500): what an add-on's worker half says about a service
 * a business signs in to (its worker module's `oauth`), and the tokens to use now.
 *
 * - **The sign-in** is the worker's (http/addon-sign-ins.ts), the way every other sign-in here works: a one-time
 *   state, PKCE, a callback that connects nothing, and only the person who pressed Connect finishing it.
 * - **HandsFreeOS's app at the service** (its client ID and secret) is in the worker's environment with the other
 *   accounts, `ADDON_PLATFORM_KEYS` under `<add-on>.<service>`; without it the service can't be signed in to here.
 * - **With the stand-ins** (ADDON_CONNECTORS=fake) the sign-in page is this server's own, and its tokens are made up.
 * - `signedInTokens(ctx, connection)` gives the tokens to call the service with, renewed first when they're about to
 *   lapse; a renewal turned down asks for the sign-in again.
 */
import { addonConnectionTokens, executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  ConnectionRefused,
  connectionWorked,
  platformKeyName,
  type AddonConnection,
} from './connections';
import type { AddonScopeContext } from './types';

/** HandsFreeOS's own app at the service: what its sign-in and token calls are made with. */
export type OAuthApp = Readonly<Record<string, string>>;

/** What a finished sign-in brought: the tokens, when they lapse, and who it is at the service. */
export interface OAuthAccount {
  readonly tokens: Readonly<Record<string, string>>;
  /** ISO time; null when they don't lapse. */
  readonly expiresAt: string | null;
  readonly label: string | null;
  readonly accountRef: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** How an add-on signs a business in to one service (its worker module's `oauth[connector][service]`). */
export interface AddonOAuthProvider {
  /** The service's sign-in page, for this state and PKCE challenge. */
  authorizeUrl(input: {
    readonly app: OAuthApp;
    readonly state: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
  }): string;
  /** Swaps the code for tokens, and says who signed in. Throws ConnectionRefused when the service says no. */
  exchange(
    input: {
      readonly app: OAuthApp;
      readonly code: string;
      readonly codeVerifier: string;
      readonly redirectUri: string;
    },
    signal: AbortSignal,
  ): Promise<OAuthAccount>;
  /** New tokens from the refresh token. Throws ConnectionRefused when it's turned down (sign in again). */
  refresh(
    input: { readonly app: OAuthApp; readonly tokens: Readonly<Record<string, string>> },
    signal: AbortSignal,
  ): Promise<{
    readonly tokens: Readonly<Record<string, string>>;
    readonly expiresAt: string | null;
  }>;
}

/** HandsFreeOS's app at a service, or null when this worker hasn't been given one. */
export const oauthAppOf = (
  ctx: Pick<AddonScopeContext, 'addonConnect'>,
  addonId: string,
  provider: string,
): OAuthApp | null => ctx.addonConnect?.platformKeys[platformKeyName(addonId, provider)] ?? null;

/** Made-up tokens for the stand-in sign-in. */
export function fakeOAuthAccount(provider: string, label: string): OAuthAccount {
  return {
    tokens: { accessToken: `fake-access-${provider}`, refreshToken: `fake-refresh-${provider}` },
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    label: `Stand-in ${label} account`,
    accountRef: `standin-${provider}`,
    details: {},
  };
}

/** Renewed this far before they lapse. */
const RENEW_BEFORE_MS = 2 * 60_000;

/**
 * The tokens to call the service with now: renewed first if they lapse within two minutes. With the stand-ins they
 * never need it. Throws ConnectionRefused when the service turned the renewal down (the connection then says to sign
 * in again).
 */
export async function signedInTokens(
  ctx: AddonScopeContext,
  connection: AddonConnection,
  provider: AddonOAuthProvider,
): Promise<Readonly<Record<string, string>>> {
  if (ctx.addonConnect?.fake ?? true) return connection.secret;
  const [row] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ token_expires_at: Date | null }>(
      tx,
      sql`select token_expires_at from app.addon_connections where id = ${connection.id}`,
    ),
  );
  const lapses = row?.token_expires_at ? new Date(row.token_expires_at).getTime() : null;
  if (lapses === null || lapses - Date.now() > RENEW_BEFORE_MS) return connection.secret;
  const app = oauthAppOf(ctx, ctx.manifest.id, connection.provider);
  if (!app) throw new ConnectionRefused('HandsFreeOS can’t sign in to that service here yet.');
  try {
    const renewed = await provider.refresh(
      { app, tokens: connection.secret },
      AbortSignal.timeout(20_000),
    );
    const tokens = { ...connection.secret, ...renewed.tokens };
    await executeCommand(
      ctx.db,
      addonConnectionTokens,
      {
        workspaceId: ctx.scope.workspaceId,
        connectionId: connection.id,
        secretEnc: ctx.sealer.seal(JSON.stringify(tokens)),
        keyId: ctx.sealer.keyId,
        tokenExpiresAt: renewed.expiresAt,
      },
      ctx.actor,
      ctx.meta,
    );
    return tokens;
  } catch (e) {
    if (e instanceof ConnectionRefused)
      await connectionWorked(ctx, connection, { ok: false, refused: true, error: e.message });
    throw e;
  }
}
