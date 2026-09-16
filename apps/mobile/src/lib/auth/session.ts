import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';

/**
 * Whether someone is signed in on this phone, decided from the sign-in saved on it, not from supabase-js's
 * `getSession()`. An hour into a dead zone the access token has run out and supabase-js reports no session, although
 * the saved sign-in is fine and refreshes as soon as there's signal. So:
 * - a saved sign-in counts as signed in, however old its access token;
 * - it's refreshed when the app is open and there's signal (supabase-js's timer, and `refreshIfDue` when signal
 *   returns);
 * - only supabase-js deleting it, which it does after Supabase Auth refuses it (`refresh-fetch.ts` keeps anything
 *   else from counting as a refusal), or the person signing out, ends it.
 */

export interface SignedInPerson {
  readonly userId: string;
  readonly email: string;
  /** From the sign-in itself; the app prefers the name on the person's profile once it has it. */
  readonly name: string | null;
}

export type SessionState =
  | { readonly status: 'starting' }
  | {
      readonly status: 'signedOut';
      /** Supabase Auth refused the saved sign-in (not the person signing out): the sign-in screen says so. */
      readonly ended: boolean;
    }
  | {
      readonly status: 'signedIn';
      readonly person: SignedInPerson;
      /** When the access token runs out (seconds since 1970); it may already have while offline. */
      readonly expiresAt: number;
    };

export interface SavedSignIn {
  readonly person: SignedInPerson;
  readonly expiresAt: number;
}

type SessionLike = Pick<Session, 'access_token' | 'refresh_token' | 'expires_at'> & {
  user?: { id?: unknown; email?: unknown; user_metadata?: Record<string, unknown> } | null;
};

function personOf(session: SessionLike): SignedInPerson | null {
  const user = session.user;
  if (!user || typeof user.id !== 'string') return null;
  const meta = user.user_metadata ?? {};
  const name =
    typeof meta.full_name === 'string' && meta.full_name.trim()
      ? meta.full_name.trim()
      : typeof meta.name === 'string' && meta.name.trim()
        ? meta.name.trim()
        : null;
  return { userId: user.id, email: typeof user.email === 'string' ? user.email : '', name };
}

/** The sign-in supabase-js saved on the phone, if it's one it could still refresh. */
export function readSaved(text: string | null): SavedSignIn | null {
  if (!text) return null;
  try {
    const session = JSON.parse(text) as SessionLike;
    if (
      !session ||
      typeof session.access_token !== 'string' ||
      typeof session.refresh_token !== 'string' ||
      !session.refresh_token ||
      typeof session.expires_at !== 'number'
    )
      return null;
    const person = personOf(session);
    return person ? { person, expiresAt: session.expires_at } : null;
  } catch {
    return null;
  }
}

/**
 * What an auth event means for the app. `saved` is what's on the phone right after the event, read only when the
 * event came without a session.
 */
export function nextState(
  prev: SessionState,
  event: AuthChangeEvent,
  session: Session | null,
  saved: SavedSignIn | null,
  signingOut: boolean,
): SessionState {
  if (session) {
    const person = personOf(session);
    if (person) return { status: 'signedIn', person, expiresAt: session.expires_at ?? 0 };
  }
  if (event === 'SIGNED_OUT' || !saved) {
    // Already signed out: a later event without a session changes nothing (and keeps "your sign-in ended").
    if (prev.status === 'signedOut') return prev;
    // supabase-js signs out only after deleting the saved sign-in: the person did, or Supabase Auth refused it.
    return { status: 'signedOut', ended: prev.status === 'signedIn' && !signingOut };
  }
  // No session in the event, but one is still saved: the access token ran out with no signal. Still signed in.
  return { status: 'signedIn', person: saved.person, expiresAt: saved.expiresAt };
}

/** Refresh a little before the access token runs out, as supabase-js does (three 30-second ticks). */
const REFRESH_MARGIN_S = 90;

export function refreshIsDue(state: SessionState, nowMs: number): boolean {
  return state.status === 'signedIn' && state.expiresAt - nowMs / 1000 < REFRESH_MARGIN_S;
}

export interface SessionStorage {
  read(): Promise<string | null>;
  clear(): Promise<void>;
}

export class SessionStore {
  private state: SessionState = { status: 'starting' };
  private readonly listeners = new Set<() => void>();
  private signingOut = false;
  private started = false;

  constructor(
    private readonly client: SupabaseClient,
    private readonly storage: SessionStorage,
  ) {}

  readonly getState = (): SessionState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: SessionState) {
    const prev = this.state;
    if (
      prev.status === next.status &&
      (next.status !== 'signedIn' ||
        (prev.status === 'signedIn' &&
          prev.person.userId === next.person.userId &&
          prev.person.name === next.person.name &&
          prev.expiresAt === next.expiresAt)) &&
      (next.status !== 'signedOut' || (prev.status === 'signedOut' && prev.ended === next.ended))
    )
      return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Reads the saved sign-in, then follows supabase-js's events. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const saved = readSaved(await this.storage.read());
    this.set(
      saved
        ? { status: 'signedIn', person: saved.person, expiresAt: saved.expiresAt }
        : { status: 'signedOut', ended: false },
    );
    this.client.auth.onAuthStateChange((event, session) => {
      // Never await supabase-js inside its own callback.
      setTimeout(() => void this.handle(event, session), 0);
    });
  }

  /** @internal Exposed for tests: what happens when supabase-js reports an event. */
  async handle(event: AuthChangeEvent, session: Session | null): Promise<void> {
    const saved = session ? null : readSaved(await this.storage.read());
    this.set(nextState(this.state, event, session, saved, this.signingOut));
  }

  /** The access token for an API request, refreshed first if it's due; null with no signal and an old token. */
  async accessToken(): Promise<string | null> {
    if (this.state.status !== 'signedIn') return null;
    const { data } = await this.client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  /** When signal returns: refresh an access token that ran out while offline. */
  async refreshIfDue(nowMs = Date.now()): Promise<void> {
    if (!refreshIsDue(this.state, nowMs)) return;
    // getSession refreshes a token that's due; a refusal signs out (SIGNED_OUT), no signal changes nothing.
    await this.client.auth.getSession();
  }

  /** Sign out on this phone. Works with no signal: the saved sign-in is deleted either way. */
  async signOut(): Promise<void> {
    this.signingOut = true;
    try {
      // Tells Supabase Auth to end this phone's session when there's signal; with none, supabase-js may keep the
      // saved sign-in, so it's deleted here as well.
      await this.client.auth.signOut({ scope: 'local' });
    } catch {
      // No signal: deleting the saved sign-in below is what matters.
    }
    await this.storage.clear();
    this.set({ status: 'signedOut', ended: false });
    this.signingOut = false;
  }

  /** After signing in: the event may take a moment, so read what supabase-js just saved. */
  async refreshFromStorage(): Promise<void> {
    const saved = readSaved(await this.storage.read());
    if (saved) this.set({ status: 'signedIn', person: saved.person, expiresAt: saved.expiresAt });
  }
}

export function useSessionState(store: SessionStore): SessionState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
