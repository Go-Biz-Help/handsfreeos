/**
 * What a business's own domain serves, and what it does not (M17).
 *
 * `booking.lonestarhvac.com/` is their booking page, `booking.lonestarhvac.com/quote` is their form called
 * `quote`, and every link we have ever sent a customer keeps the shape it was sent in — only the origin
 * moves — so a text from last month still works on either name.
 *
 * **The rule that matters is the last one.** The app, the sign-in pages and the admin side are never served
 * on somebody else's name: a sign-in form on a business's domain is a phishing page built out of a feature,
 * and it would be built by us. The decision lives here rather than in the web app's proxy so it can be read
 * and tested as a rule, apart from the framework that carries it out.
 */

/** Paths a customer's link already uses. Served as they are, on either name. */
const PUBLIC_PREFIXES = [
  '/book',
  '/f/',
  '/e/',
  '/i/',
  '/m/',
  '/p/',
  '/w/',
  '/hold/',
  // A campaign email's unsubscribe page.
  '/u/',
  '/chat/',
  // The chat loader the business pastes into its own site, so the snippet reads as theirs too.
  '/embed/',
] as const;

/** A single name with nothing else in it: `/quote`, not `/quote/thanks`. */
const BARE_NAME = /^\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

/**
 * Single names that are ours before they are anybody's form.
 *
 * `booking_sites` already refuses these as slugs (`private.booking_slug_reserved`, mirrored in
 * `siteSlugFrom`), and the same names have to mean the same thing one level down or somebody typing
 * `booking.lonestarhvac.com/app` gets a 404 instead of the app they were looking for. The sign-in names are
 * here for a second reason: whatever we do with them, it is never "render something on a business's domain
 * that looks like the start of signing in to HandsFreeOS".
 */
const RESERVED = new Set([
  'manage',
  'c',
  'api',
  'app',
  'admin',
  'www',
  'help',
  'support',
  'sign-in',
  'sign-up',
  'invite',
  'auth',
]);

export type BrandedRoute =
  /** Serve this path instead, without the address bar changing. */
  | { readonly kind: 'rewrite'; readonly path: string }
  /** Serve it as asked: the link already has the shape it was sent in. */
  | { readonly kind: 'serve' }
  /** Not this business's to serve. Send the browser to our own address. */
  | { readonly kind: 'elsewhere' };

/**
 * What a request on a branded domain is really for, given the booking site it belongs to.
 *
 * `path` is the pathname alone — no host, no query. Anything not recognised goes `elsewhere` rather than
 * being guessed at, which is what keeps a new route from quietly appearing on every business's domain.
 */
export function brandedRoute(site: string, path: string): BrandedRoute {
  if (path === '/') return { kind: 'rewrite', path: `/book/${site}` };
  if (PUBLIC_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p)))
    return { kind: 'serve' };
  if (BARE_NAME.test(path) && !RESERVED.has(path.slice(1).toLowerCase()))
    return { kind: 'rewrite', path: `/f/${site}${path}` };
  return { kind: 'elsewhere' };
}
