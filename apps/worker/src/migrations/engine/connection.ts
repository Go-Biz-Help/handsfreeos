/**
 * Opening a source connection for a job: the sealed token out of its seal, refreshed if it is about to
 * expire, and a per-sub-account token where the source works that way.
 *
 * The rule the sealing exists for: the token never leaves this process, never reaches `authenticated`, and
 * never appears in a log line, an error message or a customer's report. A long import outliving its access
 * token is ordinary, so refreshing happens here and the job carries on rather than starting again.
 */
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { CrmSourceAdapter, SourceConnection, SourceScope } from '@hfos/core/server';
import type { Logger } from 'pino';
import type { Sealer } from '../../crypto';

/** Refreshed this far before it expires, so a page in flight never fails on the boundary. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export type ConnectionRow = {
  id: string;
  organization_id: string;
  source_system: string;
  install_kind: 'agency' | 'location';
  status: string;
  external_account_id: string | null;
  scopes: string[];
  token_enc: string | null;
  token_key_id: string | null;
  /** Raw SQL hands timestamps back as strings, so this is parsed rather than trusted. */
  token_expires_at: string | Date | null;
};

export class SourceAuthError extends Error {
  constructor(
    message: string,
    readonly code: 'reauth_required' | 'not_connected' | 'no_adapter',
  ) {
    super(message);
    this.name = 'SourceAuthError';
  }
}

/** The sealed value holds both halves, because they are rotated together and are useless apart. */
interface SealedTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

export function sealTokens(sealer: Sealer, tokens: SealedTokens): string {
  return sealer.seal(JSON.stringify(tokens));
}

function openTokens(sealer: Sealer, sealed: string): SealedTokens {
  const parsed = JSON.parse(sealer.open(sealed)) as SealedTokens;
  if (!parsed.accessToken) throw new SourceAuthError('That sign-in is empty.', 'not_connected');
  return parsed;
}

export interface OpenedConnection {
  readonly connection: SourceConnection;
  readonly adapter: CrmSourceAdapter;
  readonly organizationId: string;
}

/**
 * The connection a job runs on. Refreshes and stores the new token when it is close to expiring; a refusal
 * from the source is turned into `reauth_required` on the row, so the screen asks for a new sign-in instead
 * of the job retrying forever against a dead token.
 */
export async function openConnection(
  deps: { readonly db: Db; readonly sealer: Sealer; readonly log: Logger },
  adapters: { get(system: string): CrmSourceAdapter | undefined },
  connectionId: string,
  /** The organization the job belongs to: without it the worker's own policies show it nothing. */
  organizationId: string,
): Promise<OpenedConnection> {
  const [row] = await asWorker(deps.db, { workspaceId: null, organizationId }, (tx) =>
    rows<ConnectionRow>(
      tx,
      sql`select id, organization_id, source_system::text as source_system,
            install_kind::text as install_kind, status::text as status, external_account_id, scopes,
            token_enc, token_key_id, token_expires_at
          from app.migration_connections where id = ${connectionId}`,
    ),
  );
  if (!row) throw new SourceAuthError('That source is not connected.', 'not_connected');
  if (row.status === 'disconnected')
    throw new SourceAuthError('That source has been disconnected.', 'not_connected');
  if (!row.token_enc) throw new SourceAuthError('That sign-in never finished.', 'not_connected');
  const adapter = adapters.get(row.source_system);
  if (!adapter)
    throw new SourceAuthError(`Nothing here knows how to read ${row.source_system}.`, 'no_adapter');

  const tokens = openTokens(deps.sealer, row.token_enc);
  let connection: SourceConnection = {
    id: row.id,
    system: row.source_system,
    installKind: row.install_kind,
    externalAccountId: row.external_account_id,
    scopes: row.scopes ?? [],
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: row.token_expires_at ? new Date(row.token_expires_at) : null,
  };

  const expiring =
    connection.expiresAt && connection.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (expiring && connection.refreshToken) {
    try {
      connection = await adapter.refresh(connection);
      await asWorker(deps.db, { workspaceId: null, organizationId: row.organization_id }, (tx) =>
        tx.execute(sql`
          update app.migration_connections
             set token_enc = ${sealTokens(deps.sealer, {
               accessToken: connection.accessToken,
               refreshToken: connection.refreshToken ?? null,
             })},
                 token_key_id = ${deps.sealer.keyId},
                 token_expires_at = ${connection.expiresAt?.toISOString() ?? null},
                 failures = 0, last_error = null
           where id = ${row.id}`),
      );
    } catch (e) {
      const message = (e as Error).message;
      await asWorker(deps.db, { workspaceId: null, organizationId: row.organization_id }, (tx) =>
        tx.execute(sql`
          update app.migration_connections
             set status = 'reauth_required', failures = failures + 1,
                 last_error = ${message.slice(0, 2000)}
           where id = ${row.id}`),
      );
      // Never the token, never the body: just that it has to be signed in again.
      deps.log.warn({ connectionId: row.id }, 'source sign-in needs doing again');
      throw new SourceAuthError('The old system needs signing in to again.', 'reauth_required');
    }
  }
  return { connection, adapter, organizationId: row.organization_id };
}

/** A sub-account, with its own token where the source hands those out. */
export async function scopeFor(opened: OpenedConnection, scope: SourceScope): Promise<SourceScope> {
  if (!opened.adapter.scopeToken) return scope;
  return opened.adapter.scopeToken(opened.connection, scope);
}

/** A Postgres `text[]` from a list, empty included. */
const textArray = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

/**
 * Finishing a sign-in: the account it reaches, what it was granted, and what it was not.
 *
 * Not a command, deliberately. A HandsFreeOS system actor is always bound to one business, and a source
 * connection belongs to the agency — so rather than loosening that rule for one caller, the write happens
 * here and the audit trail comes from the system event beside it.
 */
export async function activateConnection(
  tx: Tx,
  input: {
    readonly connectionId: string;
    readonly organizationId: string;
    readonly sourceSystem: string;
    readonly externalAccountId: string;
    readonly displayName: string | null;
    readonly installKind: 'agency' | 'location';
    readonly scopes: readonly string[];
    readonly missingScopes: readonly string[];
    readonly adapterVersion: string;
  },
): Promise<void> {
  // Reconnecting the same account replaces the old row, so the unique index never sees two live ones.
  await tx.execute(sql`
    update app.migration_connections
       set status = 'disconnected', disconnected_reason = 'replaced', disconnected_at = now()
     where organization_id = ${input.organizationId}
       and source_system = ${input.sourceSystem}::app.migration_source
       and external_account_id = ${input.externalAccountId}
       and id <> ${input.connectionId}
       and status <> 'disconnected'`);
  await tx.execute(sql`
    update app.migration_connections
       set status = 'active', external_account_id = ${input.externalAccountId},
           display_name = ${input.displayName}, install_kind = ${input.installKind}::app.migration_install_kind,
           scopes = ${textArray(input.scopes)}, missing_scopes = ${textArray(input.missingScopes)},
           adapter_version = ${input.adapterVersion}, connected_at = now(), failures = 0, last_error = null,
           oauth_state_hash = null, oauth_state_expires_at = null, pkce_verifier_enc = null
     where id = ${input.connectionId}`);
}
