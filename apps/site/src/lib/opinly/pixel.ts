/**
 * The browser half of Opinly's analytics: `window.opinly`, which the pixel (components/opinly-pixel.tsx) puts
 * there once it has loaded. Every call is safe before it loads, on the server, and with an ad blocker: it waits
 * for the pixel, or quietly does nothing.
 */

export interface OpinlyPixelApi {
  /** This browser's anonymous visitor id: the join key a server-side event can carry. */
  readonly anonId?: string;
  track(
    event: string,
    properties?: Record<string, unknown>,
    opts?: { externalEventId?: string },
  ): void;
  identify(person: { email: string; userId?: string }): void;
  page(): void;
}

declare global {
  interface Window {
    opinly?: OpinlyPixelApi;
  }
}

/**
 * Run `fn` with the pixel: now if it is loaded, or when it announces itself. `opinly:ready` fires once and is not
 * replayed, so it has to be checked for before listening (Opinly's own advice).
 */
export function withPixel(fn: (pixel: OpinlyPixelApi) => void): void {
  if (typeof window === 'undefined') return;
  const run = () => {
    try {
      if (window.opinly) fn(window.opinly);
    } catch {
      // Analytics never gets to break the page it is measuring.
    }
  };
  if (window.opinly) run();
  else window.addEventListener('opinly:ready', run, { once: true });
}

/** The visitor's anonymous id, if the pixel has loaded; sent along with a form so the server can use it too. */
export function anonId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const id = window.opinly?.anonId;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : undefined;
}
