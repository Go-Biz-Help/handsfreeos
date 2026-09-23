/**
 * Which businesses stay on this phone, and which one opens. Pure rules, shared by the switcher, Settings and the sync
 * step (M10 step 9).
 */

export type Role = 'owner' | 'admin' | 'member';

export interface Business {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: Role;
  readonly timezone: string;
  /** What they may do there (0106), as `account.me` said; a phone's older copy may not have it. */
  readonly permissions?: readonly string[];
}

export interface KeepChoices {
  /** The business opened last. */
  readonly lastOpened: string | null;
  /** Switches the person set; a business without one is kept only if it was opened last. */
  readonly explicit: Readonly<Record<string, boolean>>;
}

/** Kept if its switch is on, or if it has no switch yet and was opened last. */
export function isKept(choices: KeepChoices, businessId: string): boolean {
  return choices.explicit[businessId] ?? businessId === choices.lastOpened;
}

/** The businesses to keep on this phone, in the person's order. */
export function keptIds(choices: KeepChoices, businesses: readonly Business[]): string[] {
  return businesses.filter((b) => isKept(choices, b.id)).map((b) => b.id);
}

/** Which business to open: the last one opened if the person still has it, otherwise the first. */
export function chooseBusiness(
  businesses: readonly Business[],
  lastOpened: string | null,
): Business | null {
  return businesses.find((b) => b.id === lastOpened) ?? businesses[0] ?? null;
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};
