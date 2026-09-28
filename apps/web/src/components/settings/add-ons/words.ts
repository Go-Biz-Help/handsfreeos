/**
 * Settings → Add-ons in words, built on the words the web and the phone share (`ADDON_STATE_WORDS`,
 * `ADDON_MOVE_WORDS`, `addonCheckWords` in @hfos/core): what a move's impact holds, what the button that agrees to
 * move others says, and what the page says once a move is made. Browser-safe and pure.
 */
import {
  ADDON_CATALOG,
  ADDON_STATE_WORDS,
  findAddon,
  requirementClosure,
  type AddonManifest,
  type InstallationState,
  type LifecycleAction,
} from '@hfos/core';
import type { AddonImpact, AddonMoved } from '@/lib/api/types';

/** An add-on's name, from the catalogue, or its id when this build has no such add-on. */
export const addonName = (id: string): string => findAddon(ADDON_CATALOG, id)?.name ?? id;

/** "A", "A and B", "A, B and C". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** Whether a list of counts is a single thing ("1 record"), for the verb that follows it. */
const single = (counts: readonly string[]): boolean =>
  counts.length === 1 && counts[0]!.startsWith('1 ');

/**
 * What an add-on holds here, and what the move does with it: kept (turning off, uninstalling) or deleted (deleting
 * its data), in a line or two. Empty when it holds nothing.
 */
export function holdsLines(action: LifecycleAction, holds: AddonImpact['holds']): string[] {
  const lines: string[] = [];
  const records = holds.records ? [count(holds.records, 'record', 'records')] : [];
  const others = [
    holds.relationships ? count(holds.relationships, 'relationship', 'relationships') : null,
    holds.ownRows ? count(holds.ownRows, 'other saved item', 'other saved items') : null,
  ].filter((w): w is string => w !== null);
  if (action === 'purge') {
    // Deleting its data keeps each record's name and every history line (the owner's decision, 2026-09-28).
    if (records.length)
      lines.push(
        single(records)
          ? `${records[0]} keeps its name and nothing else.`
          : `${records[0]} keep their names and nothing else.`,
      );
    if (others.length)
      lines.push(`${capital(listWords(others))} ${single(others) ? 'is' : 'are'} deleted.`);
    return lines;
  }
  const kept = [...records, ...others];
  if (kept.length) {
    const one = single(kept);
    lines.push(
      action === 'uninstall'
        ? `${capital(listWords(kept))} ${one ? 'stays' : 'stay'}, hidden, until an owner deletes ${one ? 'it' : 'them'}.`
        : `${capital(listWords(kept))} ${one ? 'stays' : 'stay'} for when it’s back on.`,
    );
  }
  if (holds.pendingJobs)
    lines.push(
      `${capital(count(holds.pendingJobs, 'thing it had scheduled is', 'things it had scheduled are'))} cancelled.`,
    );
  if (action === 'uninstall' && holds.heldResources)
    lines.push(
      `It lets go of ${count(holds.heldResources, 'thing', 'things')} it holds outside HandsFreeOS.`,
    );
  return lines;
}

/**
 * The button that answers "…needs Property Management. Turn it on too?" with yes: the move, with the others the
 * person agrees to move along with it (the owner's decision: ask to move both, never silently).
 */
export function agreeLabel(action: LifecycleAction, others: readonly string[]): string {
  const all = others.length === 1 ? 'both' : `all ${others.length + 1}`;
  switch (action) {
    case 'install':
      return `Add ${all}`;
    case 'enable':
      return `Turn on ${all}`;
    case 'disable':
      return `Turn off ${all}`;
    case 'uninstall':
      return `Uninstall and turn off ${others.length === 1 ? others[0] : `${others.length} others`}`;
    case 'purge':
      return 'Delete its data';
  }
}

/** What the page says once a move is made, naming every other add-on that moved with it. */
export function movedWords(
  addonId: string,
  name: string,
  action: LifecycleAction,
  moved: readonly AddonMoved[],
): string {
  const lead = {
    install: `${ADDON_STATE_WORDS.installing.label} ${name}. ${ADDON_STATE_WORDS.installing.detail}`,
    enable: `${name} is ${ADDON_STATE_WORDS.enabled.label.toLowerCase()}.`,
    disable: `${name} is ${ADDON_STATE_WORDS.disabled.label.toLowerCase()}.`,
    uninstall: `Uninstalling ${name}. ${ADDON_STATE_WORDS.uninstalling.detail}`,
    purge: `Deleting ${name}’s data. ${ADDON_STATE_WORDS.purging.detail}`,
  }[action];
  const others = moved.filter((m) => m.addonId !== addonId);
  const named = (to: InstallationState) =>
    others.filter((m) => m.to === to).map((m) => addonName(m.addonId));
  const said = (names: string[], what: string) =>
    names.length ? `${listWords(names)} ${names.length === 1 ? 'is' : 'are'} ${what} too.` : null;
  return [
    lead,
    said(named('installing'), 'being set up'),
    said(named('enabled'), 'on'),
    said(named('disabled'), 'off'),
  ]
    .filter(Boolean)
    .join(' ');
}

/** One add-on another needs or works with, as its card lists it. */
export interface NeedLine {
  readonly addonId: string;
  readonly name: string;
  readonly why: string;
  readonly required: boolean;
}

/** What an add-on needs (required) and what it works with when it's there (optional), from its manifest. */
export const needsOf = (m: AddonManifest | undefined): NeedLine[] =>
  (m?.requires ?? []).map((d) => ({
    addonId: d.addon,
    name: addonName(d.addon),
    why: d.why,
    required: d.kind === 'required',
  }));

/**
 * Why an add-on that is available and free still can't be added here, when what it needs says so: something it
 * needs is on its way out, or isn't one this business can add. Null when nothing it needs explains it.
 */
export function blockedWords(
  m: AddonManifest,
  stateOf: (id: string) => InstallationState | null,
  canAdd: (id: string) => boolean,
): string | null {
  for (const id of requirementClosure(ADDON_CATALOG, m.id)) {
    const state = stateOf(id);
    if (state === 'uninstalling' || state === 'purging')
      return `It needs ${addonName(id)}, which is still being removed.`;
    const here = state === 'installing' || state === 'enabled' || state === 'disabled';
    if (!here && !canAdd(id)) return `It needs ${addonName(id)}, which can’t be added here.`;
  }
  return null;
}
