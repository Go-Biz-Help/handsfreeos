/**
 * Add-ons in words: what each state is called, what each move's button and question say, what a check that isn't
 * finished means, and the rest of what the Add-ons page and Home's suggestion card say. Browser-safe, so the web's
 * page and the phone's say exactly the same thing (docs/addon-architecture.md).
 */
import { joinNames } from '../account/settings-words';
import { requirementClosure, type Catalog } from './graph';
import type { AddonOffer, InstallationState, LifecycleAction } from './lifecycle';
import type { AddonCategory, AddonManifest } from './manifest';

/** "Rent Collection’s", "Demo Properties’": a name that ends in s takes the apostrophe alone. */
export const possessiveOf = (name: string): string =>
  /s$/i.test(name.trim()) ? `${name}’` : `${name}’s`;

/** How a state reads next to an add-on's name, and whether it is settled or on its way somewhere. */
export interface AddonStateWords {
  readonly label: string;
  /** One line on what it means for the business. */
  readonly detail: string;
  /** `busy` while the worker is still moving it: show a spinner, offer no move. */
  readonly tone: 'on' | 'off' | 'busy' | 'gone';
}

export const ADDON_STATE_WORDS: Readonly<Record<InstallationState, AddonStateWords>> = {
  installing: {
    label: 'Setting up',
    detail: 'It turns on by itself in a moment.',
    tone: 'busy',
  },
  enabled: { label: 'On', detail: 'Working for everyone who may use it.', tone: 'on' },
  disabled: {
    label: 'Off',
    detail:
      'Its screens and records are hidden and nothing it does runs. Its data and settings are kept.',
    tone: 'off',
  },
  uninstalling: {
    label: 'Uninstalling',
    detail: 'It is letting go of what it holds outside HandsFreeOS.',
    tone: 'busy',
  },
  uninstalled: {
    label: 'Uninstalled',
    detail:
      'Its data is kept, hidden, until an owner deletes it. Installing it again brings it back.',
    tone: 'gone',
  },
  purging: { label: 'Deleting its data', detail: 'This takes a little while.', tone: 'busy' },
  purged: {
    label: 'Data deleted',
    detail: 'Its records keep their names, and history keeps its lines without the details.',
    tone: 'gone',
  },
};

/** A move's button, and the question asked before one that takes something away. */
export interface AddonMoveWords {
  readonly button: string;
  /** The confirmation's title, with the add-on's name; null when the move needs no confirming. */
  readonly confirm: ((name: string) => string) | null;
  /** What confirming will do, in one or two sentences. */
  readonly consequence: string | null;
}

export const ADDON_MOVE_WORDS: Readonly<Record<LifecycleAction, AddonMoveWords>> = {
  install: { button: 'Install', confirm: null, consequence: null },
  enable: { button: 'Turn on', confirm: null, consequence: null },
  disable: {
    button: 'Turn off',
    confirm: (name) => `Turn off ${name}?`,
    consequence:
      'Its screens and records are hidden and anything it had scheduled is cancelled. Its data and settings are kept for when it’s back on.',
  },
  uninstall: {
    button: 'Uninstall',
    confirm: (name) => `Uninstall ${name}?`,
    consequence:
      'It stops and lets go of anything it holds outside HandsFreeOS. Its data is kept, hidden, until an owner deletes it.',
  },
  purge: {
    button: 'Delete its data',
    confirm: (name) => `Delete ${possessiveOf(name)} data for good?`,
    consequence:
      'Its own data is deleted. Your customers, conversations, invoices, payments, files and tasks stay; its records keep their names, and history keeps its lines without the details. This can’t be undone.',
  },
};

/** The checks the worker runs after a move (private.addon_verify), in words for whoever manages add-ons. */
export const ADDON_CHECK_WORDS: Readonly<Record<string, string>> = {
  record_kinds_shown: 'Some of its records are still hidden.',
  no_permissions_held: 'Some people still have its permissions.',
  no_jobs_pending: 'Some of its scheduled work is still waiting.',
  no_deliveries_pending: 'Some messages for it are still waiting.',
  record_kinds_hidden: 'Some of its records still show.',
  relationship_types_hidden: 'Some of its relationships still show.',
  no_resources_held: 'It still holds something outside HandsFreeOS.',
  no_rows_left: 'Some of its data is still there.',
  records_tombstoned: 'Some of its records still have their details.',
  no_relationships_left: 'Some of its relationships are still there.',
  no_settings_left: 'Some of its settings are still there.',
  no_permission_choices_left: 'Some permission choices for it are still there.',
  history_details_removed: 'Some history still has its details.',
};

/** One line for a check that failed, whatever its name. */
export const addonCheckWords = (check: string): string =>
  ADDON_CHECK_WORDS[check] ?? 'Something it left behind is still being cleared up.';

/**
 * The Add-ons page's own words, the same on the web and the phone: its sections and what they say when empty, one
 * add-on's parts and the notes in place of a move that isn't there, what's asked before a move, and Home's card.
 */
export const ADDON_PAGE_WORDS = {
  title: 'Add-ons',
  /** Under the row that opens the page, where there's room for a line. */
  settingsDetail: 'Extra features for this business',
  intro:
    'Add-ons add features to HandsFreeOS for particular kinds of work. Turn one off and its screens are hidden, with its data kept for when it’s back on. Only an owner can delete an add-on’s data.',
  inBusiness: 'In this business',
  noneHereTitle: 'Nothing added yet',
  noneHere: 'Add-ons you add show here, with whether each one is on.',
  available: 'Available to add',
  availableDetail: 'Adding one asks first if it needs another add-on too.',
  noneToAddTitle: 'None to add yet',
  noneToAdd: 'When there’s an add-on this business can use, it shows here.',
  comingSoon: 'Coming soon',
  comingSoonDetail: 'Being built now. You can’t add these yet.',
  /** One add-on that is coming soon. */
  notYet: 'It’s being built now. You can’t add it yet.',
  /** Nothing anywhere: none here, none to add, none coming. The catalogue is empty until the first add-on ships. */
  emptyTitle: 'No add-ons yet',
  empty:
    'Add-ons bring extra features to HandsFreeOS. When there are some for this business, they’ll be here.',
  /** Someone who doesn't manage add-ons, arriving by a link. */
  notYours: 'Owners and admins look after this business’s add-ons.',

  // One add-on.
  does: 'What it lets you do',
  willDo: 'What it will let you do',
  needs: 'What it needs',
  willNeed: 'What it will need',
  needsNothing: 'Nothing else.',
  worksWith: 'Works with',
  /** A paid add-on, in place of Install: billing isn't built, so HandsFreeOS support hands it out. */
  paid: 'A paid add-on. HandsFreeOS support can turn it on for you.',
  /** One only HandsFreeOS support hands out (in beta), in place of Install. */
  support: 'HandsFreeOS support can turn it on for you.',
  askSupport: 'Ask HandsFreeOS support',
  cantAdd: 'It can’t be added here right now.',
  ownersDelete: 'Only an owner can delete its data.',
  /** On here, but HandsFreeOS has switched it off everywhere for now. */
  paused: (name: string) =>
    `HandsFreeOS has switched ${name} off for now, so it isn’t running. Its data and settings are kept.`,
  retired: 'HandsFreeOS no longer has this add-on, so it can’t be turned on again.',
  /** Its last move isn't finished, and the checks say why (each in `addonCheckWords`). */
  troubleChecks: 'Not quite finished. HandsFreeOS keeps trying on its own.',
  /** Its last move isn't finished, and no check says why. */
  trouble: 'It ran into trouble finishing the last change. HandsFreeOS keeps trying on its own.',
  settings: 'Settings',
  settingsDescription: 'How it works in this business.',
  switches: 'Switches',
  switchesHidden: (name: string) =>
    `Only people who may change ${possessiveOf(name)} settings can see its switches.`,
  flipped: (label: string, on: boolean) => `${label} is ${on ? 'on' : 'off'}.`,

  // Before a move that takes something away.
  checking: 'Checking what else this changes…',
  impactFailed:
    'We couldn’t check what else this changes. You can still go ahead: anything else it would stop is asked about first.',
  already: 'Nothing to change: it’s already done.',
  whatStops: 'What stops',
  whatItHolds: 'What it holds here',
  typeName: (name: string) => `Type ${name} to confirm`,

  // Home's card.
  suggested: 'An add-on that could help',
  seeIt: 'See it',
  notNow: 'Not now',
  notInterested: 'Not interested',
  notNowDone: 'We’ll hold off on suggestions for a while.',
  notInterestedDone: (name: string) => `We won’t suggest ${name} again.`,
} as const;

/** The catalogue's categories, as a page names them under an add-on's name. */
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
export function addonCategoryLine(category: string | null): string | null {
  const word = category ? ADDON_CATEGORY_WORDS[category as AddonCategory] : undefined;
  return word ? `${word} add-on` : null;
}

/** What an add-on has here (`addon.impact`'s `holds`). */
export interface AddonHoldings {
  readonly records: number;
  readonly relationships: number;
  readonly pendingJobs: number;
  readonly heldResources: number;
  readonly ownRows: number;
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const oneThing = (parts: readonly string[]) => parts.length === 1 && parts[0]!.startsWith('1 ');

/**
 * What a move does with what an add-on has here, in a line or two: kept while it's off ("12 records stay for when
 * it’s back on."), kept hidden once it's uninstalled, or deleted with its data, each record keeping its name (the
 * owner's decisions, 2026-09-28). Empty when it has nothing here. Usage counted for billing isn't the person's
 * concern.
 */
export function addonHoldsLines(action: LifecycleAction, holds: AddonHoldings): string[] {
  const records = holds.records ? [count(holds.records, 'record', 'records')] : [];
  const others = [
    holds.relationships ? count(holds.relationships, 'relationship', 'relationships') : null,
    holds.ownRows ? count(holds.ownRows, 'other saved item', 'other saved items') : null,
  ].filter((part): part is string => part !== null);
  const lines: string[] = [];
  if (action === 'purge') {
    if (records.length)
      lines.push(
        oneThing(records)
          ? `${records[0]} keeps its name and nothing else.`
          : `${records[0]} keep their names and nothing else.`,
      );
    if (others.length)
      lines.push(`${capital(joinNames(others))} ${oneThing(others) ? 'is' : 'are'} deleted.`);
    return lines;
  }
  const kept = [...records, ...others];
  if (kept.length) {
    const one = oneThing(kept);
    lines.push(
      action === 'uninstall'
        ? `${capital(joinNames(kept))} ${one ? 'stays' : 'stay'}, hidden, until an owner deletes ${one ? 'it' : 'them'}.`
        : `${capital(joinNames(kept))} ${one ? 'stays' : 'stay'} for when it’s back on.`,
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

/** Add-ons that use this one when it's there: "Content Creator uses it and does less without it." */
export function addonOptionalLine(names: readonly string[]): string | null {
  if (!names.length) return null;
  const many = names.length > 1;
  return `${joinNames(names)} ${many ? 'use' : 'uses'} it and ${many ? 'do' : 'does'} less without it.`;
}

/**
 * The button that answers HandsFreeOS's question about other add-ons ("Rent Collection needs Property Management.
 * Turn it on too?") with yes: the move, with the others it takes (the owner's decision: ask to move both, never
 * silently). `others` are their names.
 */
export function addonAgreeWords(action: LifecycleAction, others: readonly string[]): string {
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
      return ADDON_MOVE_WORDS.purge.button;
  }
}

/**
 * What a move did, naming every other add-on that moved with it: "Uninstalling Property Management. It is letting go
 * of what it holds outside HandsFreeOS. Rent Collection is off too." Null when nothing moved (it was already there).
 */
export function addonMovedLine(
  addonId: string,
  name: string,
  action: LifecycleAction,
  moved: readonly { readonly addonId: string; readonly to: InstallationState }[],
  nameOf: (addonId: string) => string,
): string | null {
  if (!moved.length) return null;
  const lead = {
    install: `${ADDON_STATE_WORDS.installing.label} ${name}. ${ADDON_STATE_WORDS.installing.detail}`,
    enable: `${name} is ${ADDON_STATE_WORDS.enabled.label.toLowerCase()}.`,
    disable: `${name} is ${ADDON_STATE_WORDS.disabled.label.toLowerCase()}.`,
    uninstall: `Uninstalling ${name}. ${ADDON_STATE_WORDS.uninstalling.detail}`,
    purge: `Deleting ${possessiveOf(name)} data. ${ADDON_STATE_WORDS.purging.detail}`,
  }[action];
  const others = moved.filter((m) => m.addonId !== addonId);
  const named = (to: InstallationState) =>
    others.filter((m) => m.to === to).map((m) => nameOf(m.addonId));
  const said = (names: string[], what: string) =>
    names.length ? `${joinNames(names)} ${names.length === 1 ? 'is' : 'are'} ${what} too.` : null;
  return [
    lead,
    said(named('installing'), 'being set up'),
    said(named('enabled'), 'on'),
    said(named('disabled'), 'off'),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Why an add-on that is available and free still can't be added here, when what it needs says so: something it
 * needs is still being removed, or can't be added here. Null when nothing it needs explains it.
 */
export function addonBlockedWords(
  catalog: Catalog,
  m: AddonManifest,
  stateOf: (id: string) => InstallationState | null,
  canAdd: (id: string) => boolean,
): string | null {
  const nameOf = (id: string) => catalog.find((a) => a.id === id)?.name ?? id;
  for (const id of requirementClosure(catalog, m.id)) {
    const state = stateOf(id);
    if (state === 'uninstalling' || state === 'purging')
      return `It needs ${nameOf(id)}, which is still being removed.`;
    const here = state === 'installing' || state === 'enabled' || state === 'disabled';
    if (!here && !canAdd(id)) return `It needs ${nameOf(id)}, which can’t be added here.`;
  }
  return null;
}

/**
 * What a page says in place of Install for an add-on the business doesn't have now: support hands out a paid one and
 * one in beta, one that needs something that can't come says what (`blocked`, from `addonBlockedWords`), a planned
 * one isn't ready, and anything else can't be added now. Null when it can be installed, or the business has it.
 */
export function addonOfferNote(
  offer: AddonOffer | null,
  blocked: string | null = null,
): string | null {
  switch (offer) {
    case 'paid':
      return ADDON_PAGE_WORDS.paid;
    case 'support':
      return ADDON_PAGE_WORDS.support;
    case 'blocked':
      return blocked ?? ADDON_PAGE_WORDS.cantAdd;
    case 'coming_soon':
      return ADDON_PAGE_WORDS.notYet;
    case 'none':
      return ADDON_PAGE_WORDS.cantAdd;
    default:
      return null;
  }
}
