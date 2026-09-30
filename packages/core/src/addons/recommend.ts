/**
 * When HandsFreeOS may mention an add-on a business doesn't have. The rules are in code, so no wording in a prompt
 * can turn the Assistant into an advert:
 *
 * - only add-ons in the `installable` set that are `available` and free: not installed, installable here, and never
 *   planned, in development, beta, built, deprecated or unavailable (one staff handed a business to try is
 *   installable there, but never suggested);
 * - only when the request matches it well enough (`MIN_SCORE`);
 * - only when nothing the business already has matches the request as well (the request is a gap);
 * - at most `limit` (2), best first.
 *
 * The matching is deliberately plain (shared words, lightly stemmed) and deterministic, so tests can pin it. It only
 * ever narrows what the AI is allowed to say; the AI still decides whether the person is actually asking for it.
 */
import type { CapabilityContext, CapabilityView } from './capabilities';
import { capabilitySets, effectiveStatus } from './capabilities';
import { findAddon } from './graph';
import type { AddonId, CapabilityId } from './manifest';

/** How well a request has to match before an add-on may be named. */
export const MIN_SCORE = 2;

const STOP = new Set(
  'a an and any are as at be but by can could do does for from get have how i in into is it its me my of on or our please should so that the their them then there these they this to up us want we what when which who will with would you your'.split(
    ' ',
  ),
);

/** Lowercase words, stop words out, crude stemming so "posts" meets "post" and "scheduling" meets "schedule". */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) =>
      w.length > 5 && w.endsWith('ing')
        ? w.slice(0, -3)
        : w.length > 4 && w.endsWith('ies')
          ? `${w.slice(0, -3)}y`
          : w.length > 4 && w.endsWith('es')
            ? w.slice(0, -2)
            : w.length > 3 && w.endsWith('s')
              ? w.slice(0, -1)
              : w.length > 5 && w.endsWith('ed')
                ? w.slice(0, -2)
                : w,
    )
    .map((w) => (w.endsWith('e') && w.length > 4 ? w.slice(0, -1) : w));
}

/** How many of the request's words a text shares (each word counted once). */
function overlap(need: ReadonlySet<string>, text: string): number {
  const seen = new Set<string>();
  for (const w of words(text)) if (need.has(w)) seen.add(w);
  return seen.size;
}

function scoreCapability(need: ReadonlySet<string>, c: CapabilityView): number {
  return overlap(need, `${c.label} ${c.description}`);
}

export interface Recommendation {
  readonly addonId: AddonId;
  readonly name: string;
  readonly summary: string;
  readonly capabilities: readonly CapabilityId[];
  readonly score: number;
}

/** Add-ons that may be suggested for `need`, best first: possibly none, never more than `limit`. */
export function recommendAddons(ctx: CapabilityContext, need: string, limit = 2): Recommendation[] {
  const wanted = new Set(words(need));
  if (wanted.size === 0) return [];
  const sets = capabilitySets(ctx);
  // How well what the business already has answers the request: an add-on has to beat that.
  const haveBest = Math.max(
    0,
    ...[...sets.current, ...sets.restricted, ...sets.turnedOff].map((c) =>
      scoreCapability(wanted, c),
    ),
  );
  const byAddon = new Map<AddonId, CapabilityView[]>();
  for (const c of sets.installable) {
    if (c.provider === 'core') continue;
    byAddon.set(c.provider, [...(byAddon.get(c.provider) ?? []), c]);
  }
  const out: Recommendation[] = [];
  for (const [addonId, caps] of byAddon) {
    const m = findAddon(ctx.catalog, addonId);
    if (!m || effectiveStatus(m, ctx.overrides) !== 'available' || m.billing.model !== 'free')
      continue;
    const text = [
      m.name,
      m.summary,
      ...m.catalog.keywords,
      ...(m.catalog.exampleNeeds ?? []),
      ...(m.catalog.industries ?? []),
      ...caps.map((c) => `${c.label} ${c.description}`),
    ].join(' ');
    const score = overlap(wanted, text);
    if (score < MIN_SCORE || score <= haveBest) continue;
    out.push({
      addonId,
      name: m.name,
      summary: m.summary,
      capabilities: caps.map((c) => c.id),
      score,
    });
  }
  return out
    .sort((a, b) => b.score - a.score || a.addonId.localeCompare(b.addonId))
    .slice(0, limit);
}
