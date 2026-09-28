/**
 * How add-ons depend on each other, worked out from their manifests alone. The catalogue's shape (unknown targets,
 * cycles) is checked by tests; at run time the lifecycle commands ask what else has to move with an add-on, which is
 * what lets the app ask one simple question ("Rent Collection needs Property Management. Turn off both?") instead of
 * ever breaking a required dependency behind someone's back.
 */
import type { AddonId, AddonIssue, AddonManifest } from './manifest';
import { manifestIssues } from './manifest';

export type Catalog = readonly AddonManifest[];

/** One add-on by id, or undefined. */
export const findAddon = (catalog: Catalog, id: AddonId): AddonManifest | undefined =>
  catalog.find((m) => m.id === id);

/** The add-ons `id` needs (required only), directly. */
export const requiredBy = (catalog: Catalog, id: AddonId): AddonId[] =>
  catalog
    .filter((m) => (m.requires ?? []).some((d) => d.addon === id && d.kind === 'required'))
    .map((m) => m.id);

/** The add-ons that use `id` when it's there (optional), directly. */
export const optionallyUsedBy = (catalog: Catalog, id: AddonId): AddonId[] =>
  catalog
    .filter((m) => (m.requires ?? []).some((d) => d.addon === id && d.kind === 'optional'))
    .map((m) => m.id);

/** What `id` needs, directly (required only). */
export const requirementsOf = (catalog: Catalog, id: AddonId): AddonId[] =>
  (findAddon(catalog, id)?.requires ?? []).filter((d) => d.kind === 'required').map((d) => d.addon);

/**
 * Everything reachable from `start` by `next`, not counting `start`, nearest first. Deterministic: ties keep the
 * catalogue's order.
 */
function reach(start: AddonId, next: (id: AddonId) => readonly AddonId[]): AddonId[] {
  const seen = new Set<AddonId>([start]);
  const out: AddonId[] = [];
  let frontier: AddonId[] = [start];
  while (frontier.length > 0) {
    const following: AddonId[] = [];
    for (const id of frontier)
      for (const n of next(id))
        if (!seen.has(n)) {
          seen.add(n);
          out.push(n);
          following.push(n);
        }
    frontier = following;
  }
  return out;
}

/** Everything `id` needs, all the way down (required only). */
export const requirementClosure = (catalog: Catalog, id: AddonId): AddonId[] =>
  reach(id, (x) => requirementsOf(catalog, x));

/** Everything that needs `id`, all the way up (required only). */
export const dependentClosure = (catalog: Catalog, id: AddonId): AddonId[] =>
  reach(id, (x) => requiredBy(catalog, x));

/** A cycle among required dependencies, as the ids around it, or null. */
export function findRequiredCycle(catalog: Catalog): AddonId[] | null {
  const state = new Map<AddonId, 'visiting' | 'done'>();
  const path: AddonId[] = [];
  const visit = (id: AddonId): AddonId[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    path.push(id);
    for (const next of requirementsOf(catalog, id)) {
      if (!findAddon(catalog, next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const m of catalog) {
    const cycle = visit(m.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Everything wrong with a whole catalogue: each manifest's own issues, plus what only shows across them (the same id
 * twice, a capability two add-ons both provide, a dependency on an add-on that doesn't exist, a cycle).
 */
export function catalogIssues(catalog: Catalog): AddonIssue[] {
  const issues: AddonIssue[] = catalog.flatMap(manifestIssues);
  const ids = new Map<AddonId, number>();
  for (const m of catalog) ids.set(m.id, (ids.get(m.id) ?? 0) + 1);
  for (const [id, n] of ids)
    if (n > 1) issues.push({ addon: id, message: `the id "${id}" is used ${n} times` });
  const capabilities = new Map<string, AddonId>();
  for (const m of catalog)
    for (const c of m.capabilities) {
      const other = capabilities.get(c.id);
      if (other && other !== m.id)
        issues.push({
          addon: m.id,
          message: `capability "${c.id}" is also provided by "${other}"`,
        });
      capabilities.set(c.id, m.id);
    }
  for (const m of catalog) {
    for (const d of m.requires ?? [])
      if (!ids.has(d.addon))
        issues.push({
          addon: m.id,
          message: `depends on "${d.addon}", which isn't in the catalogue`,
        });
    if (m.catalog.replacedBy && !ids.has(m.catalog.replacedBy))
      issues.push({
        addon: m.id,
        message: `is replaced by "${m.catalog.replacedBy}", which isn't in the catalogue`,
      });
    const planned = m.catalog.status === 'planned';
    for (const d of m.requires ?? []) {
      const target = findAddon(catalog, d.addon);
      if (!planned && d.kind === 'required' && target?.catalog.status === 'planned')
        issues.push({
          addon: m.id,
          message: `requires "${d.addon}", which is only planned`,
        });
    }
  }
  const cycle = findRequiredCycle(catalog);
  if (cycle)
    issues.push({
      addon: cycle[0] ?? '?',
      message: `required dependencies go round in a circle: ${cycle.join(' → ')}`,
    });
  return issues;
}

/**
 * The order to do things in when several add-ons move together: what's needed before what needs it. Stable: among
 * add-ons with no order between them, the catalogue's order wins.
 */
export function dependencyOrder(catalog: Catalog, ids: readonly AddonId[]): AddonId[] {
  const wanted = new Set(ids);
  const out: AddonId[] = [];
  const placed = new Set<AddonId>();
  const place = (id: AddonId, trail: Set<AddonId>) => {
    if (placed.has(id) || trail.has(id)) return;
    trail.add(id);
    for (const r of requirementsOf(catalog, id)) if (wanted.has(r)) place(r, trail);
    trail.delete(id);
    placed.add(id);
    out.push(id);
  };
  for (const m of catalog) if (wanted.has(m.id)) place(m.id, new Set());
  for (const id of ids) if (!placed.has(id)) place(id, new Set());
  return out;
}
