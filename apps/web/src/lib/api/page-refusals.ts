/**
 * A page load the API refused (403) on its way to the business's own error screen
 * (app/app/w/[workspaceId]/error.tsx), which draws it inside the shell instead of Next's bare error page (FE-4).
 *
 * What a server component throws reaches the browser as a digest only — its message and its class stay on the
 * server — so `unwrapPage` (./server.ts) marks the refusal with one of these digests. A page that catches the
 * refusal itself (Money's `allowed`, a `.catch(() => null)`) still gets the ApiError it always did; only one that
 * nobody catches reaches the screen. Browser-safe: the screen reads it.
 */

/** The rule of the kernel's refusal while an add-on isn't on in the business (HfosError.addonInactive, 0108). */
export const ADDON_INACTIVE = 'addon_inactive';

/** Any other refusal: shown as the page not being there, the same words as a 404. */
export const REFUSED_DIGEST = 'HFOS_REFUSED';
/** An add-on's look-up while the add-on is off: its screens are hidden until it's back on (owner's decision). */
export const ADDON_OFF_DIGEST = 'HFOS_ADDON_OFF';

export type PageRefusal = 'refused' | 'addon_off';

/** The digest a refusal with this rule is marked with. */
export const refusalDigest = (rule: string | undefined): string =>
  rule === ADDON_INACTIVE ? ADDON_OFF_DIGEST : REFUSED_DIGEST;

/** Which refusal the error an error screen was handed stands for, or null for anything else. */
export function pageRefusalOf(error: unknown): PageRefusal | null {
  const digest =
    typeof error === 'object' && error !== null ? (error as { digest?: unknown }).digest : null;
  if (digest === ADDON_OFF_DIGEST) return 'addon_off';
  if (digest === REFUSED_DIGEST) return 'refused';
  return null;
}
