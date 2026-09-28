/**
 * Add-ons in words: what each state is called, what each move's button and question say, and what a check that
 * isn't finished means. Browser-safe, so the web's Add-ons page and the phone's say exactly the same thing
 * (docs/addon-architecture.md).
 */
import type { InstallationState, LifecycleAction } from './lifecycle';

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
    confirm: (name) => `Delete ${name}’s data for good?`,
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
