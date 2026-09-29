import type { paths } from '@hfos/api-client';

/**
 * What the add-on queries and commands answer (packages/core/src/schemas/addon.ts), as the typed client has them.
 *
 * This folder is `add-ons`, not `addons`: the web keeps each add-on's own code in `src/addons/<id>/`, and a lint rule
 * that runs in every package stops anything but the web's registry importing from a folder of that name.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

/** `addon.list`: what the business has, what this person can do, and (for managers) what could be added. */
export type AddonList = Ok<'/v1/queries/addon.list'>;
export type InstalledRow = AddonList['installed'][number];
export type CatalogRow = AddonList['catalog'][number];
export type CapabilityRow = AddonList['capabilities']['current'][number];

/** `addon.impact`: what else would move, who loses what, and what it holds here. */
export type AddonImpact = Ok<'/v1/queries/addon.impact'>;
export type AddonHolds = AddonImpact['holds'];

/** `addon.settings`: the business's settings and switches (for whoever may see them), and the person's own. */
export type AddonSettings = Ok<'/v1/queries/addon.settings'>;

/** `addon.roadmap` (0109): what's coming soon, and every planned add-on up for a vote. */
export type AddonRoadmap = Ok<'/v1/queries/addon.roadmap'>;
export type ComingSoonRow = AddonRoadmap['comingSoon'][number];
export type PlannedRow = AddonRoadmap['planned'][number];
/** `addon.vote` and `addon.unvote`: where the business's vote stands now. */
export type AddonVoted = Ok<'/v1/commands/addon.vote'>;
/** Home's note: an add-on the business voted for is coming soon, or ready to add. */
export type AddonNews = NonNullable<Ok<'/v1/queries/addon.news'>['news']>;

/** The one add-on Home may suggest now. */
export type AddonSuggestion = NonNullable<Ok<'/v1/queries/addon.suggestion'>['suggestion']>;

/** One add-on a move moved, in the order it moved. */
export type AddonMoved = Ok<'/v1/commands/addon.install'>['moved'][number];
