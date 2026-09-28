/**
 * Where an add-on stands in one business, and which moves are allowed from where. The database holds the state
 * (`app.addon_installations.state`, checked by `private.guard_addon_installation`); this is the same table of moves in
 * code, so the commands can refuse a bad move with a plain reason before touching anything.
 *
 *   (none) ─install─▶ installing ─worker─▶ enabled ◀─enable─ disabled
 *                                            └──────disable──────▶┘
 *   installing, enabled or disabled ─uninstall─▶ uninstalling ─worker─▶ uninstalled
 *   uninstalled or purged ─install─▶ installing        uninstalled ─purge─▶ purging ─worker─▶ purged
 *
 * Only `enabled` is active: in every other state the kernel refuses the add-on's commands and queries for every actor,
 * its permissions are nobody's, and its queued work is cancelled. The worker finishes the three moves that take time
 * (installing, uninstalling, purging) and checks nothing is left behind before it says they're done.
 */

export const INSTALLATION_STATES = [
  'installing',
  'enabled',
  'disabled',
  'uninstalling',
  'uninstalled',
  'purging',
  'purged',
] as const;
export type InstallationState = (typeof INSTALLATION_STATES)[number];

/** What a person (or the Assistant, for them) can ask for. */
export const LIFECYCLE_ACTIONS = ['install', 'enable', 'disable', 'uninstall', 'purge'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** Whether an add-on in this state runs: the one question every checkpoint asks. */
export const isActiveState = (state: InstallationState | null | undefined): boolean =>
  state === 'enabled';

/** Whether a business has it at all, on or off (its data is kept and it shows in the add-on list). */
export const isInstalledState = (state: InstallationState | null | undefined): boolean =>
  state === 'installing' || state === 'enabled' || state === 'disabled' || state === 'uninstalling';

/** The moves the worker makes when the slow part of one is done. */
export const COMPLETIONS: Readonly<Partial<Record<InstallationState, InstallationState>>> = {
  installing: 'enabled',
  uninstalling: 'uninstalled',
  purging: 'purged',
};

export type Move =
  /** The move to make. */
  | { readonly kind: 'move'; readonly to: InstallationState }
  /** Already there: nothing changes, and asking again is not an error. */
  | { readonly kind: 'already' }
  | { readonly kind: 'refused'; readonly rule: string; readonly message: string };

/**
 * What `action` does from `from` (null: never installed here). Repeating a move that already happened is `already`,
 * so a retried request or a double click changes nothing and fails nothing.
 */
export function moveFor(from: InstallationState | null, action: LifecycleAction): Move {
  const move = (to: InstallationState): Move => ({ kind: 'move', to });
  const refused = (rule: string, message: string): Move => ({ kind: 'refused', rule, message });
  const busy = refused(
    'addon_busy',
    'That add-on is still being removed. Try again when it has finished.',
  );
  switch (action) {
    case 'install':
      if (from === null || from === 'uninstalled' || from === 'purged') return move('installing');
      if (from === 'installing' || from === 'enabled') return { kind: 'already' };
      if (from === 'disabled')
        return refused(
          'addon_installed_off',
          'That add-on is already installed. Turn it on instead.',
        );
      return busy;
    case 'enable':
      if (from === 'disabled') return move('enabled');
      if (from === 'enabled' || from === 'installing') return { kind: 'already' };
      if (from === null || from === 'uninstalled' || from === 'purged')
        return refused('addon_not_installed', 'That add-on isn’t installed here.');
      return busy;
    case 'disable':
      if (from === 'enabled' || from === 'installing') return move('disabled');
      if (from === 'disabled') return { kind: 'already' };
      if (from === null || from === 'uninstalled' || from === 'purged')
        return refused('addon_not_installed', 'That add-on isn’t installed here.');
      return busy;
    case 'uninstall':
      if (from === 'installing' || from === 'enabled' || from === 'disabled')
        return move('uninstalling');
      if (from === 'uninstalling' || from === 'uninstalled') return { kind: 'already' };
      if (from === null || from === 'purged')
        return refused('addon_not_installed', 'That add-on isn’t installed here.');
      return busy;
    case 'purge':
      if (from === 'uninstalled') return move('purging');
      if (from === 'purging' || from === 'purged') return { kind: 'already' };
      if (from === null)
        return refused('addon_not_installed', 'That add-on has never been installed here.');
      if (from === 'uninstalling') return busy;
      return refused(
        'addon_uninstall_first',
        'Uninstall the add-on first, then its data can be deleted.',
      );
  }
}
