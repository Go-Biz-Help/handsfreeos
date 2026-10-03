/**
 * The words on the settings people have of their own — appearance, the phone's own Settings and More, and
 * "Delete my account" — in one browser-safe place (M10 step 17). The web's Settings → Account and the phone's
 * Settings read the same lines, so neither is worded twice.
 *
 * Everything about a business (texting, payments, members, calendars) stays on the web and has no words here.
 */

/** Light, dark, or the device's own setting. */
export type AppearanceChoice = 'light' | 'dark' | 'system';

export interface AppearanceOption {
  readonly value: AppearanceChoice;
  readonly label: string;
  /** Under the label on the web's cards. */
  readonly desc: string;
}

/** The three choices, in the order both apps show them. */
export const APPEARANCE_OPTIONS: readonly AppearanceOption[] = [
  { value: 'light', label: 'Light', desc: 'Always light' },
  { value: 'dark', label: 'Dark', desc: 'Always dark' },
  { value: 'system', label: 'System', desc: 'Follows this device' },
];

export const APPEARANCE_LABELS: Record<AppearanceChoice, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export const APPEARANCE_WORDS = {
  title: 'Appearance',
  /** The web keeps the choice with the account; the phone keeps it on the phone. */
  web: 'Saved to your account, so every device you sign in on follows it.',
  phone: 'System follows this phone’s own light or dark setting.',
  done: 'Done',
} as const;

/** More, as the phone's board draws it (design/m10/More.dc.html). */
export const MORE_WORDS = {
  title: 'More',
  switch: 'Switch',
  changes: 'Changes on this phone',
  /** Over the business's own rows, once an add-on's places sit above them. */
  yourBusiness: 'Your business',
  customers: 'Contacts',
  tasks: 'Tasks',
  money: 'Money',
  /** M17: forms a phone can fill in with no signal. */
  forms: 'Forms',
  approvals: 'Approvals',
  /** The AI teammate's test console, for people who manage it. */
  testTeammate: 'Test your AI teammate',
  testTeammateDetail: 'Text, chat, email or call your AI teammate as a customer',
  settings: 'Settings',
  openOnWeb: 'Open on the web',
  openOnWebDetail: 'Workflows, the AI teammate, business settings, members and more',
  getHelp: 'Get help',
  getHelpDetail: 'Ask us. A person reads every one',
} as const;

/** Asking HandsFreeOS for help from inside the app (M13). Plain, and honest about what it sends. */
export const GET_HELP_WORDS = {
  title: 'Get help',
  intro:
    'A person reads these, Monday to Friday, and answers by email. We already know which business you are in and which screen you were on.',
  subject: 'In a few words',
  subjectPlaceholder: 'Appointment reminders stopped going out',
  body: 'What happened?',
  bodyHint:
    'What you were doing, what you expected, and roughly when. Do not include passwords or card numbers.',
  send: 'Send it',
  sending: 'Sending',
  needsBody: 'Tell us what is going on.',
  sent: (number: number) => `Got it — that is ticket #${number}. We will answer by email.`,
  offline: 'You need a signal to send this. Try again when you are back on.',
} as const;

/** Settings on the phone: you and this phone, and nothing about the business. */
export const PHONE_SETTINGS_WORDS = {
  title: 'Settings',
  thisPhone: 'This phone',
  you: 'You',
  /** The one group about the business the phone has: its balance, which owners and admins see (M16). */
  thisBusiness: 'This business',
  lockDetail: 'Asks when you open the app',
  lockUnavailable: 'Set up Face ID, a fingerprint or a passcode on this phone first',
  lockRefused: 'That didn’t match, so nothing changed.',
  lockOn: 'Turn on the lock',
  lockOff: 'Turn off the lock',
  businesses: 'Businesses on this phone',
  changes: 'Changes on this phone',
  notifications: 'Notifications',
  notificationsDetail: 'Push and email',
  profile: 'Profile and sign-in',
  signOut: 'Sign out',
  deleteAccount: 'Delete my account',
  footnote: 'Business settings, texting, payments and members are on the web.',
  myCellDetail: 'Where Call rings you first',
} as const;

/**
 * What the Businesses row says under its label: none kept, some still coming down, or the ones that work with no
 * signal. `coming` counts the kept businesses whose copy hasn't finished.
 */
export function keptBusinessesLine(kept: readonly { readonly name: string }[], coming: number) {
  if (kept.length === 0) return 'None: every business opens only with signal';
  if (coming > 0) return `Getting ${coming === 1 ? 'one' : coming} onto this phone…`;
  if (kept.length === 1) return `${kept[0]!.name} · works with no signal`;
  return `${kept.length} businesses · work with no signal`;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Delete my account (M10): the same words on the web's Settings → Account, on the public page, and on the phone.
 * The account goes; what the person worked on stays with each business, credited to a former teammate.
 */
export const DELETE_ACCOUNT_WORDS = {
  title: 'Delete my account',
  /** The web has room for the whole sentence; the phone says it in two cards. */
  intro:
    'Your sign-in and your name are removed, and you are signed out everywhere, on the web and on your phones. The customers, messages and jobs you worked on stay with each business, shown as from a former teammate.',
  phoneIntro: 'Your sign-in and your name are removed, and you’re signed out everywhere.',
  removedTitle: 'Removed',
  removedDetail: (businessName: string) =>
    `Your sign-in, your name and photo, and your place at ${businessName}`,
  keptTitle: 'Kept by the business',
  keptDetail:
    'The customers, messages, jobs and notes you worked on, shown as from a former teammate',
  confirmLabel: 'Type your email address to confirm',
  mismatch: 'Type your email address exactly as it is on your account.',
  button: 'Delete my account',
  keep: 'Keep my account',
  /** The phone's footnote: the same thing can be done at a desk. */
  alsoOnWeb:
    'You can also delete your account on the web, or from the public page on handsfreeos.com.',
  /** Handing a business over is the web's job; the phone says so and opens it. */
  handOverOnWeb: 'Make someone else an owner on the web first, then come back here.',
  openOnWeb: 'Open on the web',
} as const;

/** What to do about a business whose only owner is leaving; the business is named beside it. */
export function onlyOwnerLine(suggestionFirstName: string | null): string {
  return suggestionFirstName
    ? `Make ${suggestionFirstName} or someone else an owner first, so the business isn’t left without one.`
    : 'Invite someone and make them an owner first, so the business isn’t left without one.';
}

/** Under a Delete button that can't be pressed yet: what has to happen first. */
export function deleteBlockedLine(names: readonly string[]): string {
  return names.length === 1
    ? `Available once someone else owns ${names[0]}.`
    : `Available once someone else owns each of ${joinNames(names)}.`;
}

/** A business that stays with its other owners once the person goes. */
export function handsOverLine(name: string, owners: readonly string[]): string {
  return `${name} stays with ${joinNames(owners)}, ${owners.length === 1 ? 'its other owner' : 'its other owners'}.`;
}
