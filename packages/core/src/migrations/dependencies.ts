/**
 * Choosing conversations without choosing customers is not a mistake a person should be able to make, and it
 * is certainly not one they should have to think about. So: they pick what they want, and this adds whatever
 * that needs, tells them it did, and locks it so an unticked box cannot quietly break the import.
 *
 * Two kinds of link, and the difference matters:
 *   dependsOn — cannot exist without it. A message with no conversation is not a message.
 *   prefers   — better with it, fine without. A customer with no owner is still a customer; the owner is
 *               attached in the links pass if the team came across too.
 *
 * Nothing here knows what CRM anyone is leaving.
 */
import { categoriesInOrder, migrationCategory, type MigrationCategory } from './catalog';

export interface SelectionRequest {
  /** What the person ticked. */
  readonly chosen: readonly string[];
  /** Categories the source has nothing in, or cannot give us; never added by this. */
  readonly unavailable?: readonly string[];
}

export interface ResolvedSelection {
  /** Everything that will run, in the order it runs. */
  readonly categories: readonly MigrationCategory[];
  /** What was added, and what asked for it — the words on the screen come straight from this. */
  readonly added: readonly { readonly category: string; readonly requiredBy: readonly string[] }[];
  /** Chosen, but its requirement cannot be met. The category is dropped and this says why. */
  readonly blocked: readonly { readonly category: string; readonly missing: readonly string[] }[];
}

/**
 * Adds every requirement of everything chosen, then everything those need, and so on. A requirement the
 * source cannot give blocks the category that wanted it rather than being silently skipped — a lead with no
 * pipeline would land in nowhere, and a half-landed record is worse than an honest refusal.
 */
export function resolveSelection(req: SelectionRequest): ResolvedSelection {
  const unavailable = new Set(req.unavailable ?? []);
  const requiredBy = new Map<string, Set<string>>();
  const wanted = new Set<string>();
  const queue: string[] = [];

  for (const id of req.chosen) {
    if (!migrationCategory(id) || unavailable.has(id)) continue;
    if (!wanted.has(id)) {
      wanted.add(id);
      queue.push(id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const cat = migrationCategory(id);
    if (!cat) continue;
    for (const need of cat.dependsOn) {
      if (!migrationCategory(need)) continue;
      let asked = requiredBy.get(need);
      if (!asked) requiredBy.set(need, (asked = new Set()));
      asked.add(id);
      if (!wanted.has(need)) {
        wanted.add(need);
        queue.push(need);
      }
    }
  }

  // A requirement the source cannot give takes down whatever asked for it, and whatever asked for that.
  const blocked = new Map<string, Set<string>>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...wanted]) {
      const cat = migrationCategory(id)!;
      const missing = cat.dependsOn.filter((d) => unavailable.has(d) || blocked.has(d));
      if (missing.length > 0 && !blocked.has(id)) {
        blocked.set(id, new Set(missing));
        wanted.delete(id);
        changed = true;
      }
    }
  }

  const chosenSet = new Set(req.chosen);
  const added = [...requiredBy.entries()]
    .filter(([id]) => wanted.has(id) && !chosenSet.has(id))
    .map(([category, asked]) => ({ category, requiredBy: [...asked].sort() }))
    .sort((a, b) => a.category.localeCompare(b.category));

  return {
    categories: categoriesInOrder([...wanted]),
    added,
    blocked: [...blocked.entries()]
      .map(([category, missing]) => ({ category, missing: [...missing].sort() }))
      .sort((a, b) => a.category.localeCompare(b.category)),
  };
}

/**
 * The sentence shown beside a category that was added for somebody else. Written as the reason first, because
 * that is the part a person is actually asking about.
 */
export function dependencyReason(category: string, requiredBy: readonly string[]): string {
  const cat = migrationCategory(category);
  const names = requiredBy
    .map((id) => migrationCategory(id)?.label ?? id)
    .sort((a, b) => a.localeCompare(b));
  const list =
    names.length === 1
      ? names[0]!
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const self = (cat?.label ?? category).toLowerCase();
  return `${list} need their ${self}, so ${self} were added to this migration.`;
}

/** Whether a category can run yet: everything it must have is finished. */
export function readyToRun(category: string, finished: ReadonlySet<string>): boolean {
  const cat = migrationCategory(category);
  if (!cat) return false;
  return cat.dependsOn.every((d) => finished.has(d));
}
