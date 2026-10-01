/**
 * Buyer memory (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Round two: Buyer core"): the kinds of thing a buyer
 * says that are worth keeping on their deal, in words. Browser-safe and pure.
 */

export const MEMORY_KINDS = {
  likes: 'Likes',
  dislikes: 'Doesn’t like',
  must_have: 'Must have',
  deal_breaker: 'Deal-breaker',
  timing: 'Timing',
  money: 'Money',
  other: 'Other',
} as const;
export type MemoryKind = keyof typeof MEMORY_KINDS;
export const MEMORY_KIND_KEYS = Object.keys(MEMORY_KINDS) as [MemoryKind, ...MemoryKind[]];

export const MEMORY_STATUSES = {
  suggested: 'Suggested',
  confirmed: 'Confirmed',
  rejected: 'Not kept',
  retired: 'No longer true',
} as const;
export type MemoryStatus = keyof typeof MEMORY_STATUSES;

/** Two items say the same thing when their words match, ignoring case, spacing and end punctuation. */
export const sameMemory = (a: string, b: string): boolean => {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.!?,;:]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return norm(a) === norm(b);
};
