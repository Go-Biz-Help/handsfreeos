import { session } from './auth';
import { SESSION_KEY, readStoredSessionText, secureSessionStorage } from './secure-storage';

/**
 * Development and test builds only: makes the saved sign-in's access token look an hour old, so a phone can show that
 * it stays signed in with no signal after the token runs out, and refreshes when signal returns.
 */
export async function expireSavedSignIn(): Promise<void> {
  const text = await readStoredSessionText();
  if (!text) return;
  const saved = JSON.parse(text) as { expires_at?: number };
  saved.expires_at = Math.floor(Date.now() / 1000) - 60;
  await secureSessionStorage.setItem(SESSION_KEY, JSON.stringify(saved));
  await session.refreshFromStorage();
}
