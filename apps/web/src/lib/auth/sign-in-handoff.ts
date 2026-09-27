/**
 * The sealed handoff a provider sign-in comes back with (components/settings/finish-sign-in), kept in this tab
 * until the worker has answered it as somebody signed in (SEC-M1).
 *
 * It arrives after the `#`, so it survives the redirect to Sign in when the person was signed out, but not the
 * trip back: Sign in keeps it here, and the finish page picks it up again. It is sealed and good for ten minutes,
 * and it is forgotten as soon as anything but "sign in first" comes back.
 */
const KEY = 'hfos.sign-in-handoff';

/** Where every sign-in comes back to be finished. */
export const FINISH_PATH = '/app/oauth/finish';

export function keepHandoff(sealed: string): void {
  try {
    sessionStorage.setItem(KEY, sealed);
  } catch {
    // A browser with storage turned off still finishes; it just can't pick up again after signing in.
  }
}

export const keptHandoff = (): string | null => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const forgetHandoff = (): void => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
};

/**
 * On Sign in, when it is on the way to finishing a sign-in: keeps the handoff the redirect carried after the `#`
 * and takes it out of the address bar.
 */
export function keepHandoffFromSignIn(next: string): void {
  if (!next.startsWith(FINISH_PATH) || window.location.hash.length < 2) return;
  keepHandoff(decodeURIComponent(window.location.hash.slice(1)));
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
