/**
 * Opinly, from the browser. The pixel (`components/opinly.tsx`) defines `window.opinly` once it has loaded; an ad
 * blocker, `next dev` or a preview means it never does. Every call goes through here so that a call made while it is
 * still loading waits for it, a call it never gets is dropped quietly, and nothing it does can break the page that
 * made the call.
 */

interface Pixel {
  /** This browser's anonymous visitor id: the join key a server-side event can carry. */
  readonly anonId: string;
  track(
    event: string,
    properties?: Record<string, unknown>,
    opts?: { readonly externalEventId?: string },
  ): void;
  identify(person: { readonly email: string; readonly userId?: string }): void;
}

declare global {
  interface Window {
    opinly?: Pixel;
  }
}

function withPixel(call: (pixel: Pixel) => void): void {
  if (typeof window === 'undefined') return;
  const run = () => {
    try {
      if (window.opinly) call(window.opinly);
    } catch {
      // Counting something is never worth an error in front of the person being counted.
    }
  };
  // `opinly:ready` fires once and is not replayed, so check before listening for it.
  if (window.opinly) run();
  else window.addEventListener('opinly:ready', run, { once: true });
}

/** Record an event. `externalEventId` makes a retry, or the server's copy of the same event, count once. */
export const track = (...args: Parameters<Pixel['track']>): void =>
  withPixel((pixel) => pixel.track(...args));

/** Tie this browser's visits to a person. The first email a browser is identified with is the one it keeps. */
export const identify = (person: Parameters<Pixel['identify']>[0]): void =>
  withPixel((pixel) => pixel.identify(person));

/**
 * The visitor's anonymous id, if the pixel has loaded — sent along with a form or a sign-up link so the server can
 * report what happens next against this exact visit. Undefined before it loads, and on previews and `next dev`,
 * where it never does.
 */
export function anonId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const id = window.opinly?.anonId;
  return typeof id === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(id) ? id : undefined;
}
