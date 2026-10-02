/**
 * The built-in order of duties (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round four", step 4): which duties
 * can't be done before another is. A link is written on a deal once both duties are on it, and the agent adds their
 * own. Kept beside the catalog rather than in its rows, so a business's published duty list (step 12) keeps its
 * version: an order is how duties relate, not what each one is. Browser-safe and pure; the catalog test checks every
 * id is a real duty and that nothing waits on itself, however far round.
 */
import type { DutyId } from './types';

/** Each duty, and the duties it waits on. */
export const DUTY_ORDER: Readonly<Partial<Record<DutyId, readonly DutyId[]>>> = {
  // A buyer's search, offer and inspection.
  'B-07': ['B-05'], // Attend showings, after they're scheduled.
  'B-08': ['B-07'], // Showing feedback, after the showings.
  'B-11': ['B-10'], // The offer, after the CMA.
  'B-16': ['B-15'], // Another offer, after another CMA.
  'B-20': ['B-19'], // Attend the inspection, after it's scheduled.
  'B-21': ['B-20'], // Read the report, after the inspection.
  'B-23': ['B-22'], // A specialist's inspection, after it's scheduled.
  'B-24': ['B-21'], // A repair strategy, after the report is read.
  'B-25': ['B-24'], // Negotiate, with a strategy.
  // A listing, from the consultation to the market.
  'S-04': ['S-03'], // The consultation, after it's prepared.
  'S-07': ['S-06'], // A price, after the CMA.
  'S-08': ['S-07'], // The agreement, with a price.
  'S-17': ['S-15', 'S-16'], // Photography, with the house ready and the photographer booked.
  'S-18': ['S-17'], // Organize the photos, once they're taken.
  'S-20': ['S-18', 'S-19'], // Into the MLS, with photos and a description.
  'S-22': ['S-20', 'S-21'], // Publish, once it's on the MLS and the marketing is made.
  'S-37': ['S-36'], // Market the open house, once it's scheduled.
  'S-39': ['S-38'], // Follow up with visitors, once they've signed in.
  // A listing's offers and its contract.
  'S-42': ['S-41'], // Compare offers, once their details are pulled out.
  'S-43': ['S-41'], // Explain them, the same.
  'S-54': ['S-53'], // A repair response, after the request is read.
  'S-59': ['S-58'], // Watch the appraisal, once access is arranged.
  'S-63': ['X-23'], // The walkthrough, after the repairs are checked.
  'S-66': ['S-64', 'S-65'], // Closing, with the seller ready and it scheduled.
  'S-67': ['S-66'], // Update the MLS, once it's closed.
  // Closing, on either side.
  'X-24': ['X-23'], // The buyer's walkthrough, after the repairs are checked.
  'X-25': ['X-05'], // The Closing Disclosure, after the loan's milestones.
  'X-26': ['X-09'], // The closing documents, once title and escrow are on track.
  'X-28': ['X-26'], // Keys, after the closing documents.
};

/** What a duty waits on, by its catalog id. */
export const waitsOnOf = (key: string): readonly string[] =>
  (DUTY_ORDER as Readonly<Record<string, readonly string[]>>)[key] ?? [];

/** Whether making `dutyKey` wait on `dependsOnKey` would go round in a circle, given the links already there. */
export function makesCircle(
  links: readonly { readonly from: string; readonly to: string }[],
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  // From `to`, can we reach `from` by following what each waits on?
  const next = new Map<string, string[]>();
  for (const l of links) next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === from) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...(next.get(at) ?? []));
  }
  return false;
}
