/**
 * The rules for the phone's copy of the business (the plan's "The phone's database", "How much is on the phone" and
 * pitfall 14), as plain functions: what stays on the phone, for how long, when it's deleted and when it locks.
 */

const DAY_S = 24 * 60 * 60;

/**
 * How long a kept business's subscription lasts without being renewed: 30 days, the same as the lock. It's renewed
 * every time the app opens its copy and every few seconds while it's connected, so it only runs out on a phone that
 * hasn't opened HandsFreeOS in 30 days, whose copy is locked by then anyway. The app renews it again before it
 * connects, so even then nothing kept is lost.
 */
export const KEPT_TTL_S = 30 * DAY_S;

/**
 * How long a business opened with signal but not kept stays after it's left: 10 minutes. Long enough to look at
 * another business and come back without downloading it again; short enough that it's gone long before the phone is
 * left anywhere. It never runs out while the business is open.
 */
export const OPEN_TTL_S = 10 * 60;

/** A copy that hasn't finished a sync in this long locks until it does. */
export const LOCK_AFTER_DAYS = 30;
const LOCK_AFTER_MS = LOCK_AFTER_DAYS * DAY_S * 1000;

/**
 * Whether the copy is locked behind "Connect to bring this phone up to date": its last completed sync is more than 30
 * days old. A copy that never finished one isn't locked; it's still being fetched. Nothing is deleted either way.
 */
export function copyLocked(lastSyncedAt: Date | null | undefined, nowMs: number): boolean {
  return lastSyncedAt != null && nowMs - lastSyncedAt.getTime() > LOCK_AFTER_MS;
}

/**
 * Signing out: with nothing waiting to send, the person's copy and its key are deleted. With changes waiting they
 * stay, still encrypted and locked to that person, and go when they sign back in on this phone.
 */
export function onSignOut(waiting: number): 'delete' | 'keep' {
  return waiting > 0 ? 'keep' : 'delete';
}

/**
 * Before a person's copy opens: everyone else's copy is deleted and their key replaced (the sign-out sheet warns that
 * someone else signing in deletes waiting changes), and the person's own key is replaced when there's no copy for it
 * to open, as after deleting and reinstalling the app, whose Keychain entries outlive it.
 */
export function beforeOpening(input: {
  readonly userId: string;
  /** People with a copy on this phone. */
  readonly peopleWithCopies: readonly string[];
  /** People this phone has kept a key for, as far as it knows. */
  readonly peopleWithKeys: readonly string[];
  readonly ownKeyFound: boolean;
}): {
  readonly deleteCopiesOf: string[];
  readonly replaceKeysOf: string[];
  readonly newOwnKey: boolean;
} {
  const others = (ids: readonly string[]) => ids.filter((id) => id !== input.userId);
  const hasOwnCopy = input.peopleWithCopies.includes(input.userId);
  return {
    deleteCopiesOf: others(input.peopleWithCopies),
    replaceKeysOf: [
      ...new Set([...others(input.peopleWithCopies), ...others(input.peopleWithKeys)]),
    ],
    newOwnKey: !hasOwnCopy || !input.ownKeyFound,
  };
}

/**
 * Which businesses the phone subscribes to, and for how long each stays once it's no longer wanted: every kept
 * business, and the one open now if it isn't kept, while there's signal or it's already on the phone.
 */
export function wantedBusinesses(input: {
  readonly kept: readonly string[];
  readonly open: string | null;
  readonly online: boolean;
  /** Businesses the phone holds a subscription for now. */
  readonly held: readonly string[];
}): Map<string, number> {
  const wanted = new Map<string, number>(input.kept.map((id) => [id, KEPT_TTL_S]));
  if (input.open && !wanted.has(input.open) && (input.online || input.held.includes(input.open)))
    wanted.set(input.open, OPEN_TTL_S);
  return wanted;
}
