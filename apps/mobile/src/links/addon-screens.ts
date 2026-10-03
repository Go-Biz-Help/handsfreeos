/**
 * The add-on screens this build of the phone draws, by the route each has under `app/w/[workspaceId]/`
 * (`a/realestate/deals/:dealId`). An add-on names the pages the phone draws in its manifest (`ui.phone`); a link to
 * one opens its screen here once this set has it, and the web until then, so no link changes when a screen arrives.
 *
 * Real Estate Agent's screens (round six) live in `app/app/w/[workspaceId]/(tabs)/(more)/a/realestate/`, inside More
 * so the tab bar stays; each route is added here, in its group, once its screen is built.
 */
export const ADDON_SCREENS: ReadonlySet<string> = new Set<string>([
  // Real Estate: Deals, My duties, Coordinate, Vendors (board 76–77).
  // Real Estate: a deal, its duty, dates, contingencies, contract, documents, history, client update (78–81).
  // Real Estate: the buyer's pages (82–84).
  // Real Estate: financing, inspections, the client's to-do, the walkthrough (85–86).
  // Real Estate: the listing's pages and showings (87–89).
]);
