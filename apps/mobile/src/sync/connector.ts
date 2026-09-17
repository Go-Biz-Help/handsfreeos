import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/common';

/**
 * How the phone's copy reaches the sync service: the service's address and the signed-in person's access token.
 *
 * The sync service only reads; changes still go to the API as commands. Nothing on the phone writes to the synced
 * tables yet, so there is nothing to upload: the queue of changes (M10 step 10) plugs in as `upload`.
 */

export interface ConnectorSession {
  /** The access token, refreshed first if it's about to run out; null when nobody is signed in. */
  accessToken(): Promise<string | null>;
  /** Refreshes the sign-in now. Only a refusal from Supabase Auth signs the person out (`SessionStore`'s rules). */
  refreshNow(): Promise<void>;
}

/** A refused token asks for a refresh at most this often, however often the sync service retries. */
export const REFRESH_AFTER_REFUSAL_MS = 60_000;

/** Until M10 step 10, nothing writes to the synced tables, so finding a change to upload is a mistake to see. */
export async function uploadNothingYet(db: AbstractPowerSyncDatabase): Promise<void> {
  const next = await db.getNextCrudTransaction();
  if (next)
    throw new Error(
      `A change to ${next.crud[0]?.table ?? 'a synced table'} was made on the phone, but changes go through the queue (M10 step 10).`,
    );
}

export class CopyConnector implements PowerSyncBackendConnector {
  private lastRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly session: ConnectorSession;
      readonly upload?: (db: AbstractPowerSyncDatabase) => Promise<void>;
      readonly now?: () => number;
      readonly onRefused?: () => void;
    },
  ) {}

  /** The sync service's address and the access token; nothing when nobody is signed in or there's no token. */
  fetchCredentials = async (): Promise<PowerSyncCredentials | null> => {
    const token = await this.options.session.accessToken();
    return token ? { endpoint: this.options.endpoint, token } : null;
  };

  uploadData = (db: AbstractPowerSyncDatabase): Promise<void> =>
    (this.options.upload ?? uploadNothingYet)(db);

  /**
   * PowerSync calls this when the sync service refuses the token (401). The phone never signs out by itself here: it
   * asks Supabase Auth for a fresh token, and only Auth refusing that ends the sign-in.
   */
  invalidateCredentials = (): void => {
    this.options.onRefused?.();
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastRefreshAt < REFRESH_AFTER_REFUSAL_MS) return;
    this.lastRefreshAt = now;
    void this.options.session.refreshNow().catch(() => undefined);
  };
}
