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
  'a/realestate',
  'a/realestate/duties',
  'a/realestate/coordinate',
  'a/realestate/vendors',
  // Real Estate: a deal, its duty, dates, contingencies, contract, documents, history, client update (78–81).
  'a/realestate/deals/:dealId',
  'a/realestate/deals/:dealId/dates',
  'a/realestate/deals/:dealId/contingencies',
  'a/realestate/deals/:dealId/contract/:readId',
  'a/realestate/deals/:dealId/documents',
  'a/realestate/deals/:dealId/history',
  'a/realestate/deals/:dealId/updates/:draftId',
  // Real Estate: the buyer's pages (82–84).
  'a/realestate/deals/:dealId/buyer',
  'a/realestate/deals/:dealId/homes',
  'a/realestate/deals/:dealId/matches',
  'a/realestate/deals/:dealId/tours',
  'a/realestate/deals/:dealId/cma/:cmaId',
  'a/realestate/deals/:dealId/offers',
  'a/realestate/deals/:dealId/offers/:offerId',
  'a/realestate/deals/:dealId/offers/:offerId/summary',
  // Real Estate: financing, inspections, the client's to-do, the walkthrough (85–86).
  'a/realestate/deals/:dealId/financing',
  'a/realestate/deals/:dealId/inspections',
  'a/realestate/deals/:dealId/client-tasks',
  'a/realestate/deals/:dealId/walkthrough',
  // Real Estate: the listing's pages and showings (87–89).
  'a/realestate/deals/:dealId/facts',
  'a/realestate/deals/:dealId/photos',
  'a/realestate/deals/:dealId/description',
  'a/realestate/deals/:dealId/price',
  'a/realestate/deals/:dealId/marketing',
  'a/realestate/deals/:dealId/open-houses',
  'a/realestate/deals/:dealId/net-sheet',
  'a/realestate/deals/:dealId/showings',
]);
