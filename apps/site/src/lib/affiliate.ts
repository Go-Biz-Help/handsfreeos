/**
 * An affiliate's link, `handsfreeos.com/?ref=<code>` (20261027014000), and a discount or trial code's,
 * `handsfreeos.com/?code=<code>` (20261027014300). Browser-safe: the proxy and the sign-up links both read it.
 *
 * The proxy keeps the code in a cookie for {@link REF_DAYS} days, with when it was clicked, and takes `?ref=` off the
 * address so a page is shared and indexed at one address. The last link clicked wins. Sign-up links then carry it
 * to the app as `?ref=` and `?ref_at=`, which keeps it on the new account until it makes its business.
 *
 * A code's link is kept the same way, in a cookie of its own, and goes to sign-up as `?code=`, where the new account
 * keeps it for the plan page to fill in. Whether it is a code is the app's to say; it counts no click.
 */

/** The link's own word. Matches `AFFILIATE_REF_PARAM` in `@hfos/core`. */
export const REF_PARAM = 'ref';
/** How long a click counts before sign-up (decision 4). Matches `AFFILIATE_CLICK_DAYS` in `@hfos/core`. */
export const REF_DAYS = 90;
export const REF_COOKIE = 'hfos_ref';

/** A link code as the app makes them: 3 to 24 lowercase letters, digits and dashes. Anything else is ignored. */
export function refCode(value: string | null | undefined): string | null {
  const code = value?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(code) ? code : null;
}

export interface Ref {
  readonly code: string;
  readonly clickedAt: Date;
}

/** The cookie's value: the code, then when it was clicked, as `<code>.<milliseconds>`. */
export const refCookieValue = (ref: Ref): string => `${ref.code}.${ref.clickedAt.getTime()}`;

/** The cookie read back, or null when it's missing, malformed or older than {@link REF_DAYS} days. */
export function readRef(value: string | null | undefined, now = Date.now()): Ref | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  const code = refCode(value.slice(0, dot));
  const at = Number(value.slice(dot + 1));
  if (dot < 0 || !code || !Number.isSafeInteger(at) || at > now + 60_000) return null;
  if (now - at > REF_DAYS * 86_400_000) return null;
  return { code, clickedAt: new Date(at) };
}

/** A code's link word. Matches `AFFILIATE_CODE_PARAM` in `@hfos/core`. */
export const CODE_PARAM = 'code';
export const CODE_COOKIE = 'hfos_code';
