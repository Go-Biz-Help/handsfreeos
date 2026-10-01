/**
 * The support desk's Saved replies and Support people (M13), in the words the web's /admin and the phone's Support
 * desk both say. Who may change what is the API's to decide: `support.manage` keeps the saved replies and
 * `platform.staff.manage` invites, suspends and removes support people. Nobody changes their own role, and the last
 * admin can't be removed or demoted; the database refuses both.
 */

import { STAFF_ROLES, type StaffRole } from '../permissions';
import { STAFF_ROLE_WORDS } from './desk-words';

/** What each role may do, in a line, beside its name where somebody picks one. */
export const STAFF_ROLE_HELP: Readonly<Record<StaffRole, string>> = {
  agent: 'Answers tickets, and can look at a business read-only.',
  lead: 'Also assigns tickets, keeps the saved replies, and sees the health page.',
  admin: 'Also invites and removes support people.',
};

/** The roles to pick from, the least first: an invitation's "What they may do", and changing someone's role. */
export const STAFF_ROLE_CHOICES: readonly {
  readonly value: StaffRole;
  readonly label: string;
  readonly help: string;
}[] = STAFF_ROLES.map((value) => ({
  value,
  label: STAFF_ROLE_WORDS[value],
  help: STAFF_ROLE_HELP[value],
}));

export const SAVED_REPLY_WORDS = {
  intro:
    'Written once, used often. The AI reads these before it drafts, so a good one here makes every draft better.',
  add: 'New saved reply',
  edit: 'Edit',
  titleLabel: 'What is it for?',
  titlePlaceholder: 'Texts are not arriving',
  bodyLabel: 'The reply',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  emptyTitle: 'Nothing saved yet.',
  emptyBody: 'The next answer you find yourself writing twice belongs here.',
} as const;

export const SUPPORT_TEAM_WORDS = {
  invite: 'Invite someone',
  youTag: ' · you',
  suspend: 'Suspend',
  letBackIn: 'Let back in',
  remove: 'Remove',
  roleFor: (email: string) => `Role for ${email}`,
  waiting: 'Waiting to accept',
  sendAgain: 'Send again',
  cancel: 'Cancel',
  signOffTitle: 'How you sign off',
  signOffDetail: 'This is the name on your replies, and the last line of them.',
  nameLabel: 'Your name to customers',
  namePlaceholder: 'Chris',
  signatureLabel: 'Sign-off',
  signaturePlaceholder: '— Chris at HandsFreeOS',
  save: 'Save',
  saved: 'Saved.',
  inviteTitle: 'Invite someone to answer support',
  inviteDetail:
    'They get a link that works once, only for this address. They will need a HandsFreeOS sign-in with the same address.',
  emailLabel: 'Their email',
  emailPlaceholder: 'name@example.com',
  badEmail: 'Enter a valid email address.',
  whatTheyMayDo: 'What they may do',
  sendInvitation: 'Send the invitation',
  /** "Sent to riley@example.com. They have seven days to accept.", with the address in bold between the two. */
  sentTo: 'Sent to',
  sevenDays: 'They have seven days to accept.',
  done: 'Done',
} as const;

/** Whether an invitation's address looks like one, before asking the API (which checks it properly). */
export const supportInviteEmailOk = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

/** A support person's name: the one customers see on their replies, else their own, else their address. */
export const supportPersonName = (p: {
  readonly displayName: string;
  readonly fullName: string;
  readonly email: string;
}): string => p.displayName || p.fullName || p.email;

/** The line under a support person's name: "sam@handsfreeos.com · 2 open tickets · suspended". */
export const supportPersonLine = (p: {
  readonly email: string;
  readonly openTicketCount: number;
  readonly status: 'active' | 'suspended';
}): string =>
  `${p.email} · ${p.openTicketCount} open ${p.openTicketCount === 1 ? 'ticket' : 'tickets'}${
    p.status === 'suspended' ? ' · suspended' : ''
  }`;

/** An invitation still waiting: "Support agent · invited by Sam Carter · link expires 10/7/2026". */
export const supportInvitationLine = (i: {
  readonly role: StaffRole;
  readonly invitedByName: string;
  readonly expiresAt: string;
}): string =>
  `${STAFF_ROLE_WORDS[i.role]} · invited by ${i.invitedByName || 'HandsFreeOS'} · link expires ${new Date(
    i.expiresAt,
  ).toLocaleDateString()}`;
