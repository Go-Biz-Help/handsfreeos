/**
 * The final walkthrough's checklist (round six, X-24: "Mobile checklist uses contract, inspection, repair terms,
 * included items, and condition evidence"). Browser-safe and pure, so the server builds the list and the phone
 * shows the same one: the repairs the seller agreed to, what the contract says stays and goes, the inspection's
 * serious findings nobody asked to fix, and each room against how it looked.
 */
import type { RepairItem } from './closing';

export type WalkthroughSource = 'repair' | 'included' | 'excluded' | 'finding' | 'room' | 'added';

export interface WalkthroughItemDraft {
  readonly source: WalkthroughSource;
  readonly sourceRef: string | null;
  readonly title: string;
  readonly detail: string | null;
}

export interface WalkthroughFacts {
  /** The repair requests' items whose answer was agreed, newest request last. */
  readonly agreedRepairs: readonly RepairItem[];
  /** The contract's words for what stays and what goes ("Fridge, washer, dryer"). */
  readonly includedItems: string | null;
  readonly excludedItems: string | null;
  /** The inspection's findings: their id, title, where, and how serious (a safety issue or a repair; minor ones stay off). */
  readonly findings: readonly {
    readonly id: string;
    readonly title: string;
    readonly location: string | null;
    readonly severity: string;
  }[];
}

/** Rooms every walkthrough looks at, against the listing's photos and the last visit. */
export const WALKTHROUGH_ROOMS = [
  'Kitchen',
  'Bathrooms',
  'Bedrooms',
  'Living areas',
  'Garage',
  'Outside and yard',
] as const;

const ASK_WORDS: Readonly<Record<RepairItem['ask'], string>> = {
  repair: 'Repaired',
  replace: 'Replaced',
  credit: 'A credit instead: nothing to check in the home',
};

/** "Fridge, washer and dryer; window coverings" → each thing on its own line. */
export function splitItems(words: string | null): string[] {
  if (!words) return [];
  return words
    .split(/[,;\n]|\band\b/i)
    .map((w) => w.trim().replace(/\.$/, ''))
    .filter((w) => w.length > 0 && w.length <= 200);
}

/** The list, in the order an agent walks it. */
export function walkthroughItems(facts: WalkthroughFacts): WalkthroughItemDraft[] {
  const items: WalkthroughItemDraft[] = [];
  const repaired = new Set<string>();
  for (const r of facts.agreedRepairs) {
    if (repaired.has(r.findingId)) continue;
    repaired.add(r.findingId);
    if (r.ask === 'credit') continue;
    items.push({
      source: 'repair',
      sourceRef: r.findingId,
      title: r.title,
      detail: ASK_WORDS[r.ask],
    });
  }
  for (const thing of splitItems(facts.includedItems))
    items.push({
      source: 'included',
      sourceRef: null,
      title: thing,
      detail: 'Stays with the home',
    });
  for (const thing of splitItems(facts.excludedItems))
    items.push({
      source: 'excluded',
      sourceRef: null,
      title: thing,
      detail: 'Goes with the sellers',
    });
  for (const f of facts.findings) {
    if (repaired.has(f.id) || !['safety', 'repair'].includes(f.severity)) continue;
    items.push({
      source: 'finding',
      sourceRef: f.id,
      title: f.title,
      detail: [f.location, 'From the inspection, not in the repairs'].filter(Boolean).join(' · '),
    });
  }
  for (const room of WALKTHROUGH_ROOMS)
    items.push({
      source: 'room',
      sourceRef: null,
      title: room,
      detail: 'As it was when you last saw it',
    });
  return items;
}

/** How a walkthrough ended, in a line: "14 of 15 OK, 1 to fix before closing". */
export function walkthroughSummary(states: readonly string[]): string {
  const ok = states.filter((s) => s === 'ok').length;
  const bad = states.filter((s) => s === 'not_ok').length;
  const unsure = states.filter((s) => s === 'unsure').length;
  const unchecked = states.filter((s) => s === 'unchecked').length;
  const parts = [`${ok} of ${states.length} OK`];
  if (bad) parts.push(`${bad} to fix before closing`);
  if (unsure) parts.push(`${unsure} not sure`);
  if (unchecked) parts.push(`${unchecked} not checked`);
  return parts.join(', ');
}
