/**
 * The add-on screens this build of the phone draws, by the route each has under `app/w/[workspaceId]/`
 * (`a/realestate/deals/:dealId`). An add-on names the pages the phone draws in its manifest (`ui.phone`); a link to
 * one opens its screen here once this set has it, and the web until then, so no link changes when a screen arrives.
 *
 * Empty until the first add-on screen is built: Real Estate Agent's deal screens come in its last round.
 */
export const ADDON_SCREENS: ReadonlySet<string> = new Set<string>();
