import { readStoredSessionText, removeStoredSession } from '../secure-storage';
import { supabase } from '../supabase';
import { SessionStore, useSessionState } from './session';

export type { SessionState, SignedInPerson } from './session';

/** The app's one session store: signed in or not, following the sign-in saved on this phone. */
export const session = new SessionStore(supabase, {
  read: readStoredSessionText,
  clear: removeStoredSession,
});

export function useSession() {
  return useSessionState(session);
}
