import { joinNames, type AddonCategory, type InstallationState } from '@hfos/core';

import type { AddonHolds } from './types';

/**
 * The Add-ons screens' words that only the phone says. What each state is called, each move's button, question and
 * consequence, and what an unfinished check means are core's (`packages/core/src/addons/words.ts`), the same words
 * the web's page uses; these are the rest: the sections, the cards shown before there's anything, the lines under a
 * question, and Home's suggestion card.
 */
export const ADDON_PHONE_WORDS = {
  title: 'Add-ons',
  /** The row in Settings. */
  settingsDetail: 'Extra features for this business',
  inBusiness: 'In this business',
  couldAdd: 'Could be added',
  comingSoon: 'Coming soon',
  /** Nothing anywhere: none here, none to add, none coming. The catalogue is empty until the first add-on ships. */
  emptyTitle: 'No add-ons yet',
  empty:
    'Add-ons bring extra features to HandsFreeOS. When there are some for this business, they’ll be here.',
  noneHere: 'This business has no add-ons yet.',
  loading: 'Getting add-ons…',
  needsSignal: 'Add-ons need signal. Try again when you’re back online.',
  retry: 'Try again',
  /** Someone who doesn't manage add-ons, arriving by a link. */
  notYours: 'Owners and admins look after this business’s add-ons.',
  footnote: 'Owners and admins add add-ons and turn them off. Only owners delete an add-on’s data.',
  notFound: 'That add-on isn’t here. It may have been taken out of HandsFreeOS.',

  // One add-on.
  does: 'What it lets you do',
  needs: 'What it needs',
  worksWith: 'Works with',
  switches: 'Switches',
  /** A paid add-on, or one only HandsFreeOS support hands out, in place of Install. */
  support: 'HandsFreeOS support can turn it on for you.',
  askSupport: 'Ask HandsFreeOS support',
  notYet: 'It isn’t available yet.',
  cantInstall: 'It can’t be installed here right now.',
  ownersDelete: 'Only an owner can delete its data.',
  retired: 'HandsFreeOS no longer offers this add-on.',
  /** The worker's last try didn't finish and no check says why. */
  stillTrying: 'Its last change hasn’t finished. HandsFreeOS keeps trying.',
  saved: 'Saved.',

  // Before a move that takes something away.
  checking: 'Checking what this changes…',
  already: 'Nothing to change: it’s already done.',
  cantNow: 'That can’t be done right now.',
  cancel: 'Cancel',
  typeName: (name: string) => `Type ${name} to confirm`,

  // Home's card.
  suggested: 'Suggested add-on',
  seeIt: 'See it',
  notNow: 'Not now',
  notInterested: 'Not interested',
  notNowDone: 'We’ll hold off on suggestions for a while.',
  notInterestedDone: 'We won’t suggest it again.',
} as const;

/** The catalogue's categories, as the phone names them under an add-on's name. */
export const ADDON_CATEGORY_WORDS: Readonly<Record<AddonCategory, string>> = {
  sales: 'Sales',
  marketing: 'Marketing',
  operations: 'Operations',
  finance: 'Finance',
  industry: 'Industry',
  productivity: 'Productivity',
  ai: 'AI',
};

/** "Finance add-on", under an add-on's name; null for a category this build doesn't know. */
export function categoryLine(category: string | null): string | null {
  const word = category ? ADDON_CATEGORY_WORDS[category as AddonCategory] : undefined;
  return word ? `${word} add-on` : null;
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What an add-on has here, from `addon.impact`: "It keeps 12 records and 3 relationships here.", "It has 2 things
 * scheduled.", "It holds 1 thing outside HandsFreeOS." Only what it has; usage counted for billing isn't the
 * person's concern.
 */
export function holdsLines(holds: AddonHolds): string[] {
  const kept = [
    holds.records ? count(holds.records, 'record', 'records') : null,
    holds.relationships ? count(holds.relationships, 'relationship', 'relationships') : null,
    holds.ownRows ? count(holds.ownRows, 'item of its own', 'items of its own') : null,
  ].filter((part): part is string => part !== null);
  const lines: string[] = [];
  if (kept.length) lines.push(`It keeps ${joinNames(kept)} here.`);
  if (holds.pendingJobs)
    lines.push(`It has ${count(holds.pendingJobs, 'thing', 'things')} scheduled.`);
  if (holds.heldResources)
    lines.push(`It holds ${count(holds.heldResources, 'thing', 'things')} outside HandsFreeOS.`);
  return lines.length ? lines : ['It keeps nothing here yet.'];
}

/**
 * The other add-ons a move takes with it, as a statement under the question: "Rent Collection needs Property
 * Management, so it turns off too." Turning one off or uninstalling it turns off whatever needs it (never
 * uninstalls it); turning one on or installing it brings on what it needs.
 */
export function alsoLine(
  name: string,
  others: readonly { readonly name: string; readonly action: string }[],
): string | null {
  if (!others.length) return null;
  const names = joinNames(others.map((o) => o.name));
  const many = others.length > 1;
  if (others.every((o) => o.action === 'disable'))
    return `${names} ${many ? 'need' : 'needs'} ${name}, so ${many ? 'they turn' : 'it turns'} off too.`;
  return `${name} needs ${names}, so ${many ? 'they’re' : 'it’s'} turned on too.`;
}

/** Add-ons that use this one when it's there: "Content Creator works with it and does less without it." */
export function optionalLine(names: readonly string[]): string | null {
  if (!names.length) return null;
  const many = names.length > 1;
  return `${joinNames(names)} ${many ? 'work' : 'works'} with it and ${many ? 'do' : 'does'} less without it.`;
}

/** What stops for the business: "Everyone here loses: Properties and units, Leases and Overdue rent." */
export function lostLine(labels: readonly string[]): string | null {
  const unique = [...new Set(labels)];
  return unique.length ? `Everyone here loses: ${joinNames(unique)}.` : null;
}

/** The yes to "…Turn it on too?" and "…Turn them off too?": it sends the move again with the others agreed to. */
export function yesWords(rule: 'addon_needs' | 'addon_required_by', others: number): string {
  const them = others > 1 ? 'them' : 'it';
  return rule === 'addon_needs' ? `Yes, turn ${them} on too` : `Yes, turn ${them} off too`;
}

const MOVED: Readonly<Record<InstallationState, (names: readonly string[]) => string>> = {
  installing: (n) => `Setting up ${joinNames(n)}.`,
  enabled: (n) => `${joinNames(n)} ${n.length > 1 ? 'are' : 'is'} on.`,
  disabled: (n) => `${joinNames(n)} ${n.length > 1 ? 'are' : 'is'} off.`,
  uninstalling: (n) => `Uninstalling ${joinNames(n)}.`,
  uninstalled: (n) => `${joinNames(n)} ${n.length > 1 ? 'are' : 'is'} uninstalled.`,
  purging: (n) => `Deleting ${joinNames(n)}’s data.`,
  purged: (n) => `${joinNames(n)}’s data is deleted.`,
};

/**
 * What a move did, for the toast: "Rent Collection is off. Uninstalling Property Management." Null when nothing
 * moved (it was already there), since the screen, read again, says where it stands.
 */
export function movedLine(
  moved: readonly { readonly addonId: string; readonly to: InstallationState }[],
  nameOf: (addonId: string) => string,
): string | null {
  if (!moved.length) return null;
  const byState = new Map<InstallationState, string[]>();
  for (const m of moved) byState.set(m.to, [...(byState.get(m.to) ?? []), nameOf(m.addonId)]);
  return [...byState].map(([to, names]) => MOVED[to](names)).join(' ');
}
