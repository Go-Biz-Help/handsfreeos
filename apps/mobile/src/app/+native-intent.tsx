import { config } from '@/lib/config';
import { pendingLinks } from '@/links/pending';
import { targetOfLink } from '@/links/route-map';

/**
 * Every address the phone hands the app (an email's https://app.handsfreeos.com/app/… link, the handsfreeos:// scheme)
 * goes through the app's route map rather than straight to a screen: it can arrive before anyone is signed in, while
 * the app is locked, or for a business the person isn't part of. The link is kept and opened once the app can show it
 * (`components/links/link-gate.tsx`); anything that isn't the app's is left alone. Expo Router calls this outside the
 * app's screens, so it only keeps the link.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (targetOfLink(path, [config.webUrl]).kind !== 'none') pendingLinks.open(path);
  } catch {
    // An address the map can't read opens nothing.
  }
  // Starting the app opens it as usual (the last business, or signing in); an app already open stays where it is.
  return initial ? '/' : null;
}
