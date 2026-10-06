/**
 * How well someone fits a business's playbooks (./playbooks.ts), from what's known about them: the lines Facebook
 * shows under their name or in their intro, their mutual friends, and the group they were found in. It puts the
 * friend requests someone gets in order, the best fit first, with why in plain words. Browser-safe and without zod:
 * the extension sorts the requests on the page with it, and the Friends tab the ones saved.
 *
 * Only what can be checked counts, so a playbook says what to look for in quotes:
 * - **Signs** in quotes ("“Owner”, “Founder” or “CEO” in their intro"): any of those words in what they show.
 * - **The area**: one of its places ("Austin and Round Rock") in what they show.
 * - **Mutual friends**: some, and more for ten or more.
 * - **A group**: they were found in one the person works.
 * - **Who to skip** in quotes ("“Realtor”"): any of those words makes them a skip, whatever else fits.
 */
import type { PlaybookDetails } from './playbooks';

/** What's known about someone, to see how they fit. */
export interface FitFacts {
  /** What Facebook shows about them: their intro, or the lines under their name in a list. */
  readonly lines: readonly string[];
  readonly mutualFriends: number | null;
  /** The group they were found in, when they were. */
  readonly groupName: string | null;
}

/** A playbook in use, as much of it as fit reads. */
export interface FitPlaybook {
  readonly id: string;
  readonly name: string;
  readonly details: Pick<PlaybookDetails, 'signs' | 'skip' | 'area'>;
}

export const FIT_LEVELS = {
  good: 'Good fit',
  maybe: 'Might fit',
  unknown: 'Not sure',
  skip: 'Skip',
} as const;
export type FitLevel = keyof typeof FIT_LEVELS;
export const FIT_LEVEL_KEYS = Object.keys(FIT_LEVELS) as [FitLevel, ...FitLevel[]];

export interface Fit {
  readonly level: FitLevel;
  /** Higher fits better: 0 when nothing known fits, below it for a skip. */
  readonly score: number;
  /** The playbook they fit best, when the business has one in use. */
  readonly playbookId: string | null;
  readonly playbookName: string | null;
  /** Why: "“Owner” on their profile", "In Austin", "12 mutual friends", "Found in Westfield Makers Market". */
  readonly reasons: readonly string[];
}

/** A score from here up is a good fit: a sign and their area, say. */
const GOOD = 3;

/** The words a line puts in quotes, curly or straight: “Owner”, "CEO". */
export function quoted(line: string): string[] {
  return [...line.matchAll(/[“"]([^”"]{1,60})[”"]/g)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
}

/** US states, by name and by code: "Round Rock, Texas" is Round Rock, not everyone in Texas. */
const STATES = new Set(
  (
    'alabama al alaska ak arizona az arkansas ar california ca colorado co connecticut ct delaware de florida fl ' +
    'georgia ga hawaii hi idaho id illinois il indiana in iowa ia kansas ks kentucky ky louisiana la maine me ' +
    'maryland md massachusetts ma michigan mi minnesota mn mississippi ms missouri mo montana mt nebraska ne ' +
    'nevada nv new_hampshire nh new_jersey nj new_mexico nm new_york ny north_carolina nc north_dakota nd ohio oh ' +
    'oklahoma ok oregon or pennsylvania pa rhode_island ri south_carolina sc south_dakota sd tennessee tn texas tx ' +
    'utah ut vermont vt virginia va washington wa west_virginia wv wisconsin wi wyoming wy usa us'
  )
    .split(' ')
    .map((state) => state.replace(/_/g, ' ')),
);
/** Words around a place that aren't the place: "within 30 miles of Denver", "the Phoenix area". */
const AROUND = /^(?:the|greater|around|near|in|within\s+\d+\s*(?:miles?|mi|km)\s+of)\s+/i;
const AREA_WORDS = /\s+(?:area|metro|region|and nearby)$/i;

/**
 * The places an area names: "Austin and Round Rock" is Austin and Round Rock, and "within 30 miles of Denver, CO"
 * is Denver. A state is left out beside a place in it, so it doesn't take in the whole state.
 */
export function placesIn(area: string | null): string[] {
  if (!area) return [];
  const parts = area
    .split(/[,;/&]|\band\b|\bor\b/i)
    .map((part) => {
      let place = part.trim();
      for (let before = ''; before !== place;) {
        before = place;
        place = place.replace(AROUND, '').replace(AREA_WORDS, '').trim();
      }
      return place;
    })
    .filter((place) => place.length >= 2);
  const places = parts.filter((place) => !STATES.has(place.toLowerCase()));
  return places.length ? places : parts;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the lines say some words, as whole words, whatever the capitals. */
export function says(lines: readonly string[], words: string): boolean {
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped(words)}(?:$|[^\\p{L}\\p{N}])`, 'iu');
  return lines.some((line) => pattern.test(line));
}

const listed = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];

/** How someone fits one playbook, or none (null) by what fits any business: mutual friends and a group. */
export function fitFor(playbook: FitPlaybook | null, facts: FitFacts): Fit {
  const which = { playbookId: playbook?.id ?? null, playbookName: playbook?.name ?? null };
  const details = playbook?.details ?? { signs: [], skip: [], area: null };
  const skipped = details.skip.flatMap(quoted).find((words) => says(facts.lines, words));
  if (skipped)
    return { ...which, level: 'skip', score: -1, reasons: [`“${skipped}” on their profile`] };
  let score = 0;
  const reasons: string[] = [];
  const signs = [...new Set(details.signs.flatMap(quoted))].filter((words) =>
    says(facts.lines, words),
  );
  if (signs.length) {
    score += 2;
    reasons.push(`${listed(signs.map((words) => `“${words}”`))} on their profile`);
  }
  const place = placesIn(details.area).find((name) => says(facts.lines, name));
  if (place) {
    score += 2;
    reasons.push(`In ${place}`);
  }
  if (facts.mutualFriends) {
    score += facts.mutualFriends >= 10 ? 2 : 1;
    reasons.push(
      `${facts.mutualFriends.toLocaleString('en-US')} mutual ${facts.mutualFriends === 1 ? 'friend' : 'friends'}`,
    );
  }
  if (facts.groupName) {
    score += 1;
    reasons.push(`Found in ${facts.groupName}`);
  }
  return {
    ...which,
    level: score >= GOOD ? 'good' : score > 0 ? 'maybe' : 'unknown',
    score,
    reasons,
  };
}

/**
 * How someone fits the business's playbooks in use: the one they fit best, a skip only when every playbook skips
 * them, and by mutual friends and group alone when there's no playbook yet.
 */
export function bestFit(playbooks: readonly FitPlaybook[], facts: FitFacts): Fit {
  if (!playbooks.length) return fitFor(null, facts);
  const fits = playbooks.map((playbook) => fitFor(playbook, facts));
  const kept = fits.filter((fit) => fit.level !== 'skip');
  if (!kept.length) return fits[0]!;
  return kept.reduce((best, fit) => (fit.score > best.score ? fit : best));
}

/** Someone in a list of requests, with how they fit when that's known. */
export interface Fitted {
  readonly fit: Pick<Fit, 'score'> | null;
  readonly mutualFriends: number | null;
}

/** Requests in order: the best fit first, then the most mutual friends, then as the list had them. */
export function byFit<T extends Fitted>(list: readonly T[]): T[] {
  return list
    .map((item, at) => ({ item, at }))
    .sort(
      (a, b) =>
        (b.item.fit?.score ?? 0) - (a.item.fit?.score ?? 0) ||
        (b.item.mutualFriends ?? 0) - (a.item.mutualFriends ?? 0) ||
        a.at - b.at,
    )
    .map(({ item }) => item);
}
