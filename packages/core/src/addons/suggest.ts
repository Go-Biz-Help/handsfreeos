/**
 * The one add-on HandsFreeOS may suggest on Home, unasked (the owner's decision, 2026-09-28: occasionally, a small
 * card for owners and admins when an available add-on fits what the business does, easy to dismiss). Pure, so the
 * rules are pinned by tests:
 *
 * - only to people who may add add-ons (`addons.manage`), never to anyone else;
 * - only an add-on `recommendAddons` would name: available, free, installable here, and a better fit than anything
 *   the business already has;
 * - matched against what the business is (its name, its line of work, the kinds of records it made for itself), so a
 *   business that keeps "Properties" hears about a property add-on and nobody hears about everything;
 * - quiet for `SUGGESTION_QUIET_DAYS` after the person sets any card aside, and never again for an add-on they said
 *   they aren't interested in;
 * - one card at most, best fit first.
 */
import type { CapabilityContext } from './capabilities';
import { findAddon } from './graph';
import type { AddonId } from './manifest';
import { recommendAddons } from './recommend';

/** How long every suggestion stays away after someone sets one aside ("Not now" or "Not interested"). */
export const SUGGESTION_QUIET_DAYS = 30;

export const SUGGESTION_CHOICES = ['not_now', 'not_interested'] as const;
export type SuggestionChoice = (typeof SUGGESTION_CHOICES)[number];

/** A card someone set aside: not now, or not interested in that add-on. */
export interface SuggestionDismissal {
  readonly addonId: AddonId;
  readonly choice: SuggestionChoice;
  readonly decidedAt: Date;
}

/** What the business is, in its own words. */
export interface SuggestionProfile {
  readonly name: string;
  /** Its line of work, as onboarding records it (`home_services`, `other`). */
  readonly industry: string;
  /** The kinds of records it made for itself: "Pet", "Pets", "Property", "Properties". */
  readonly recordKinds: readonly string[];
}

export interface HomeSuggestion {
  readonly addonId: AddonId;
  readonly name: string;
  readonly summary: string;
  /** What it would let the business do, in its capabilities' words. */
  readonly does: readonly string[];
}

/** The words a business is described by: its name, its line of work and its own kinds of records. */
export const profileText = (p: SuggestionProfile): string =>
  [p.name, p.industry.replace(/_/g, ' '), ...p.recordKinds].join(' ');

/** The add-on to suggest to this person now, or null. */
export function suggestAddon(
  ctx: CapabilityContext,
  profile: SuggestionProfile,
  dismissals: readonly SuggestionDismissal[],
  now: number,
): HomeSuggestion | null {
  if (!(ctx.permissions ?? []).includes('addons.manage')) return null;
  const quietSince = now - SUGGESTION_QUIET_DAYS * 86_400_000;
  if (dismissals.some((d) => d.decidedAt.getTime() > quietSince)) return null;
  const refused = new Set(
    dismissals.filter((d) => d.choice === 'not_interested').map((d) => d.addonId),
  );
  const best = recommendAddons(ctx, profileText(profile), 10).find((r) => !refused.has(r.addonId));
  if (!best) return null;
  const m = findAddon(ctx.catalog, best.addonId);
  return {
    addonId: best.addonId,
    name: best.name,
    summary: best.summary,
    does: (m?.capabilities ?? []).map((c) => c.label),
  };
}
