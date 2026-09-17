import { targetOfLink } from './route-map';

/**
 * What the app does with a link once it can show it: open the screen, hand the desk work to the web, or say plainly
 * that it's for a business the person isn't part of. Links that aren't the app's are left alone.
 */
export type LinkDecision =
  | { readonly kind: 'screen'; readonly href: string; readonly later: string | null }
  | { readonly kind: 'web'; readonly path: string }
  | { readonly kind: 'not-yours'; readonly message: string }
  | { readonly kind: 'ignore' };

export const NOT_YOURS = 'That link is for a business you aren’t part of on HandsFreeOS.';

export function decideLink(
  link: string,
  context: { readonly businessIds: readonly string[]; readonly webOrigins?: readonly string[] },
): LinkDecision {
  const target = targetOfLink(link, context.webOrigins ?? []);
  if (target.kind === 'none') return { kind: 'ignore' };
  if (target.businessId !== null && !context.businessIds.includes(target.businessId))
    return { kind: 'not-yours', message: NOT_YOURS };
  if (target.kind === 'web') return { kind: 'web', path: target.path };
  return { kind: 'screen', href: target.href, later: target.later };
}
