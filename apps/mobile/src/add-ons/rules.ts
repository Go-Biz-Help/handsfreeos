import {
  ADDON_STATE_WORDS,
  addonCheckWords,
  findAddon,
  moveFor,
  type AddonManifest,
  type Catalog,
  type InstallationState,
  type LifecycleAction,
} from '@hfos/core';

import type { AddonList, CatalogRow, InstalledRow } from './types';
import { ADDON_PHONE_WORDS } from './words';

/**
 * What the Add-ons screens show and offer, worked out from `addon.list`, the catalogue's manifests and what the
 * person may do. Plain functions, so the rules are pinned by tests rather than by what a screen happens to draw
 * (docs/addon-architecture.md, and the owner's decisions of 2026-09-28):
 *
 * - owners and admins (`addons.manage`) install, turn on and off and uninstall; only owners (`addons.purge`) delete
 *   an add-on's data;
 * - a state that is still on its way somewhere (tone `busy`) shows progress and offers no move;
 * - what could be added is what HandsFreeOS says this business can install, plus paid add-ons, which say that
 *   HandsFreeOS support can turn them on (billing isn't built); a beta add-on is never offered;
 * - planned add-ons are Coming soon, with no Install;
 * - a move's trouble is said in the checks' words, never the worker's own message.
 */

/** What this person may do with add-ons here. */
export interface AddonGrants {
  /** `addons.manage`: install, turn on and off, uninstall. Owners and admins. */
  readonly manage: boolean;
  /** `addons.purge`: delete an add-on's data, after typing its name. Owners only. */
  readonly purge: boolean;
}

/**
 * How it could come to this business: Install; HandsFreeOS support turns it on (paid, or one only support hands
 * out); Coming soon (planned); or nothing (it's here already, or it isn't offered).
 */
export type AddonOffer = 'install' | 'support' | 'coming_soon' | null;

/** One add-on as the screens draw it. */
export interface AddonView {
  readonly addonId: string;
  readonly name: string;
  readonly summary: string;
  /** The manifest's longer description, when this build knows the add-on. */
  readonly description: string | null;
  readonly category: string | null;
  /** Where it stands in this business; null when the business has never had it. */
  readonly state: InstallationState | null;
  /** On its way somewhere: the worker is finishing a move. Shows progress, offers no move. */
  readonly busy: boolean;
  /** Its code is gone from HandsFreeOS. */
  readonly retired: boolean;
  readonly offer: AddonOffer;
  /** The moves this person can make now, in the order their buttons go. */
  readonly moves: readonly LifecycleAction[];
  /** Why the last move hasn't finished, in words. Empty when nothing is wrong. */
  readonly trouble: readonly string[];
  /** What it lets a business do. */
  readonly does: readonly { readonly label: string; readonly description: string }[];
  /** Add-ons it can't be on without, and why. */
  readonly needs: readonly AddonLink[];
  /** Add-ons it uses when they're there. */
  readonly worksWith: readonly AddonLink[];
  /** Its switches, as its manifest declares them (their values here come from `addon.settings`). */
  readonly flags: readonly {
    readonly key: string;
    readonly label: string;
    readonly default: boolean;
  }[];
}

export interface AddonLink {
  readonly addonId: string;
  readonly name: string;
  readonly why: string;
}

export interface AddonGroups {
  /** Every add-on this business has had, whatever state it's in. */
  readonly installed: readonly AddonView[];
  /** What could be added: installable here, or paid (support turns it on). */
  readonly addable: readonly AddonView[];
  /** Planned: shown as Coming soon, never installable. */
  readonly comingSoon: readonly AddonView[];
}

/** The order the buttons go in: the move that brings it on first, the one that takes most away last. */
const MOVE_ORDER: readonly LifecycleAction[] = [
  'enable',
  'install',
  'disable',
  'uninstall',
  'purge',
];

export const isBusyState = (state: InstallationState | null): boolean =>
  state !== null && ADDON_STATE_WORDS[state].tone === 'busy';

/** Whether any add-on here is still on its way somewhere, so the list is worth asking for again soon. */
export const anyBusy = (list: Pick<AddonList, 'installed'>): boolean =>
  list.installed.some((row) => isBusyState(row.state));

/**
 * How an add-on the business doesn't have running could come to it. Only for one it has never had, or one
 * uninstalled or with its data deleted: anything else is here already.
 */
export function offerFor(
  list: AddonList,
  catalog: Catalog,
  addonId: string,
  state: InstallationState | null,
): AddonOffer {
  const row = list.catalog.find((c) => c.addonId === addonId);
  if (state === null && row?.status === 'planned') return 'coming_soon';
  if (state !== null && state !== 'uninstalled' && state !== 'purged') return null;
  // HandsFreeOS's own answer: available, free, and everything it needs is on here or could come with it.
  if (list.capabilities.installable.some((c) => c.provider === addonId)) return 'install';
  const m = findAddon(catalog, addonId);
  if (!m) return null;
  if (row?.status === 'available' && m.billing.model === 'paid') return 'support';
  // One HandsFreeOS support handed this business before (in beta, or built and not offered yet): only support turns
  // it on again.
  if (state !== null && (m.catalog.status === 'beta' || m.catalog.status === 'built'))
    return 'support';
  return null;
}

/** All a retired add-on (its code gone from HandsFreeOS) can do: leave, and then have its data deleted. */
const RETIRED_MOVES: ReadonlySet<LifecycleAction> = new Set(['uninstall', 'purge']);

/**
 * The moves this person can make on an add-on now: the lifecycle's own table (core's `moveFor`), less what a busy
 * state, a retired add-on, the offer and their permissions rule out.
 */
export function movesFor(
  state: InstallationState | null,
  offer: AddonOffer,
  grants: AddonGrants,
  retired = false,
): LifecycleAction[] {
  if (!grants.manage || isBusyState(state)) return [];
  return MOVE_ORDER.filter((action) => {
    if (moveFor(state, action).kind !== 'move') return false;
    if (retired && !RETIRED_MOVES.has(action)) return false;
    if (action === 'install') return offer === 'install';
    if (action === 'purge') return grants.purge;
    return true;
  });
}

/**
 * Why the move it's making now hasn't finished, in words: each failed check as core says it, or a plain line when
 * the worker only left its own message (which is for HandsFreeOS, not the business). Only while there's trouble
 * (`lastError`): the worker sets it whenever a check fails, and a person's next move clears it at once, while the
 * checks stored for the move before stay until the worker looks again.
 */
export function troubleOf(row: Pick<InstalledRow, 'failedChecks' | 'lastError'>): string[] {
  if (!row.lastError) return [];
  const lines = [...new Set(row.failedChecks.map(addonCheckWords))];
  return lines.length ? lines : [ADDON_PHONE_WORDS.stillTrying];
}

/** An add-on's name, from what HandsFreeOS said and then the catalogue; its id when neither knows it. */
export function addonNameOf(list: AddonList | null, catalog: Catalog, addonId: string): string {
  return (
    list?.installed.find((r) => r.addonId === addonId)?.name ??
    list?.catalog.find((r) => r.addonId === addonId)?.name ??
    findAddon(catalog, addonId)?.name ??
    addonId
  );
}

/** What it lets a business do: HandsFreeOS's own capability rows for it, else its manifest's. */
function doesOf(list: AddonList, m: AddonManifest | undefined, addonId: string) {
  const found = new Map<string, { label: string; description: string }>();
  const { current, restricted, turnedOff, installable, planned } = list.capabilities;
  for (const set of [current, restricted, turnedOff, installable, planned])
    for (const c of set)
      if (c.provider === addonId && !found.has(c.id))
        found.set(c.id, { label: c.label, description: c.description });
  if (!found.size && m)
    for (const c of m.capabilities) found.set(c.id, { label: c.label, description: c.description });
  return [...found.values()];
}

function viewOf(
  list: AddonList,
  catalog: Catalog,
  grants: AddonGrants,
  addonId: string,
  installed: InstalledRow | null,
  listed: CatalogRow | null,
): AddonView {
  const m = findAddon(catalog, addonId);
  const state = installed?.state ?? null;
  const retired = installed?.retired ?? false;
  const offer = offerFor(list, catalog, addonId, state);
  const link = (kind: 'required' | 'optional') =>
    (m?.requires ?? [])
      .filter((d) => d.kind === kind)
      .map((d) => ({ addonId: d.addon, name: addonNameOf(list, catalog, d.addon), why: d.why }));
  return {
    addonId,
    name: installed?.name ?? listed?.name ?? m?.name ?? addonId,
    summary: installed?.summary || listed?.summary || m?.summary || '',
    description: m?.description ?? null,
    category: listed?.category ?? m?.category ?? null,
    state,
    busy: isBusyState(state),
    retired,
    offer,
    moves: movesFor(state, offer, grants, retired),
    trouble: installed ? troubleOf(installed) : [],
    does: doesOf(list, m, addonId),
    needs: link('required'),
    worksWith: link('optional'),
    flags: Object.entries(m?.settings?.flags ?? {}).map(([key, f]) => ({
      key,
      label: f.label,
      default: f.default,
    })),
  };
}

/** The catalogue's order (HandsFreeOS lists add-ons that way everywhere), then any it doesn't know, by name. */
function inCatalogueOrder(catalog: Catalog) {
  const place = (id: string) => {
    const i = catalog.findIndex((m) => m.id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return (a: AddonView, b: AddonView) =>
    place(a.addonId) - place(b.addonId) || a.name.localeCompare(b.name);
}

/** The three sections of the Add-ons screen. */
export function groupAddons(list: AddonList, catalog: Catalog, grants: AddonGrants): AddonGroups {
  const had = new Set(list.installed.map((r) => r.addonId));
  const order = inCatalogueOrder(catalog);
  const listedOf = (id: string) => list.catalog.find((c) => c.addonId === id) ?? null;
  const installed = list.installed
    .map((r) => viewOf(list, catalog, grants, r.addonId, r, listedOf(r.addonId)))
    .sort(order);
  const notHad = list.catalog.filter((c) => !had.has(c.addonId));
  const addable = notHad
    .filter((c) => c.status === 'available')
    .map((c) => viewOf(list, catalog, grants, c.addonId, null, c))
    .filter((v) => v.offer === 'install' || v.offer === 'support');
  const comingSoon = notHad
    .filter((c) => c.status === 'planned')
    .map((c) => viewOf(list, catalog, grants, c.addonId, null, c));
  return { installed, addable, comingSoon };
}

/** One add-on, for its own screen: one the business has had, or one the catalogue offers or promises. */
export function findAddonView(
  list: AddonList,
  catalog: Catalog,
  grants: AddonGrants,
  addonId: string,
): AddonView | null {
  const installed = list.installed.find((r) => r.addonId === addonId) ?? null;
  const listed = list.catalog.find((c) => c.addonId === addonId) ?? null;
  if (!installed && !listed) return null;
  return viewOf(list, catalog, grants, addonId, installed, listed);
}

export const isEmptyGroups = (g: AddonGroups): boolean =>
  !g.installed.length && !g.addable.length && !g.comingSoon.length;

/** A refusal a person can answer: "Rent Collection needs Property Management. Turn it on too?" */
export interface AddonQuestion {
  readonly rule: 'addon_needs' | 'addon_required_by';
  /** HandsFreeOS's own question. */
  readonly question: string;
  /** The other add-ons it asks about, to send back as `include` on a yes. */
  readonly addons: readonly string[];
}

/**
 * The question in a refused move, or null: `addon_needs` (installing or turning on one that needs others) and
 * `addon_required_by` (turning off or uninstalling one others need), whose details name the add-ons to agree to.
 */
export function questionOf(error: unknown): AddonQuestion | null {
  const e = error as { rule?: unknown; details?: unknown; message?: unknown } | null;
  if (!e || (e.rule !== 'addon_needs' && e.rule !== 'addon_required_by')) return null;
  const addons = (e.details as { addons?: unknown } | null | undefined)?.addons;
  if (!Array.isArray(addons) || !addons.length || !addons.every((a) => typeof a === 'string'))
    return null;
  return { rule: e.rule, question: String(e.message ?? ''), addons };
}

/** What the person agreed to so far, and the add-ons they just agreed to as well. */
export const agreedWith = (include: readonly string[], more: readonly string[]): string[] => [
  ...new Set([...include, ...more]),
];

/** Whether the name typed to delete an add-on's data is its name: any case, spaces around it ignored. */
export const typedNameMatches = (typed: string, name: string): boolean =>
  typed.trim().toLowerCase() === name.trim().toLowerCase();

/** The moves that ask first, with `addon.impact`: each takes something away. */
export const asksFirst = (action: LifecycleAction): action is 'disable' | 'uninstall' | 'purge' =>
  action === 'disable' || action === 'uninstall' || action === 'purge';
