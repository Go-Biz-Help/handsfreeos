/**
 * An add-on's connections to other services, from its worker half (round five, 20261021000100). The business's
 * own account comes first, HandsFreeOS's after it; a sealed key is opened only here, for the call that needs it,
 * and never logged or sent back.
 *
 * - `connectionFor(ctx, connector)`: the account to use now for one thing the add-on connects, or null.
 * - `connectionWorked(ctx, connection, …)`: whether a call to the service just worked, so the business sees its
 *   health and what it affects; a refusal says to connect it again.
 * - A service the add-on can be connected to by key has a tester in its worker half (`connectors`), which tries
 *   what the business pasted before anything is kept.
 */
import { addonConnectionHealth, executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { AddonScopeContext } from './types';

/** The account an add-on uses at a service: the business's own, or HandsFreeOS's. */
export interface AddonConnection {
  readonly id: string;
  readonly provider: string;
  readonly auth: 'key' | 'oauth' | 'platform';
  readonly label: string | null;
  readonly accountRef: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  /** What was given: the pasted fields, a sign-in's tokens, or HandsFreeOS's own key from the environment. */
  readonly secret: Readonly<Record<string, string>>;
  /** It's been failing: try it, but don't be surprised. */
  readonly failing: boolean;
}

/** What trying a pasted key found: who it is at the service, and what else is safe to show. */
export interface ConnectionTried {
  readonly label: string | null;
  readonly accountRef: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Tries what a business pasted with the service. Throws ConnectionRefused when the service says no; anything else
 * thrown means it couldn't be reached. `fake` is the stand-in (development and tests): no call leaves the worker.
 */
export type ConnectionTester = (
  fields: Readonly<Record<string, string>>,
  ctx: { readonly fake: boolean; readonly signal: AbortSignal },
) => Promise<ConnectionTried>;

/** The service turned what it was given down: the words say what to do, for the person who pasted it. */
export class ConnectionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionRefused';
  }
}

/** Where HandsFreeOS's own account at a service is kept: the worker's environment, by `<addon>.<provider>`. */
export const platformKeyName = (addonId: string, provider: string) => `${addonId}.${provider}`;

/** The account to use now for one thing the add-on connects: its own before HandsFreeOS's; null when there's none. */
export async function connectionFor(
  ctx: AddonScopeContext,
  connector: string,
): Promise<AddonConnection | null> {
  const list = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{
      id: string;
      provider: string;
      auth: 'key' | 'oauth' | 'platform';
      status: string;
      label: string | null;
      account_ref: string | null;
      details: Record<string, unknown>;
      secret_enc: string | null;
    }>(
      tx,
      sql`select id, provider, auth, status, label, account_ref, details, secret_enc
          from app.addon_connections
          where workspace_id = ${ctx.scope.workspaceId} and addon_id = ${ctx.manifest.id}
            and connector = ${connector} and status in ('active', 'error')
          order by (auth = 'platform'), connected_at desc nulls last`,
    ),
  );
  for (const c of list) {
    let secret: Record<string, string> | null = null;
    if (c.auth === 'platform')
      secret = ctx.addonConnect?.platformKeys[platformKeyName(ctx.manifest.id, c.provider)] ?? null;
    else if (c.secret_enc)
      secret = JSON.parse(ctx.sealer.open(c.secret_enc)) as Record<string, string>;
    // HandsFreeOS's own account with no key here (a local stack, a deploy without it): as if it weren't there.
    if (!secret) continue;
    return {
      id: c.id,
      provider: c.provider,
      auth: c.auth,
      label: c.label,
      accountRef: c.account_ref,
      details: c.details ?? {},
      secret,
      failing: c.status === 'error',
    };
  }
  return null;
}

/** Records whether a call to the service just worked. A refusal (a key turned down) needs connecting again. */
export async function connectionWorked(
  ctx: AddonScopeContext,
  connection: Pick<AddonConnection, 'id'>,
  result:
    | { readonly ok: true }
    | { readonly ok: false; readonly error: string; readonly refused?: boolean },
): Promise<void> {
  await executeCommand(
    ctx.db,
    addonConnectionHealth,
    {
      workspaceId: ctx.scope.workspaceId,
      connectionId: connection.id,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error.slice(0, 500), refused: !!result.refused }),
    },
    ctx.actor,
    ctx.meta,
  );
}
