/**
 * The words only the phone's Saved replies and Support people say: the confirmations a phone asks before something it
 * can't take back, and the lines a toast shows. What the web says too is core's `SAVED_REPLY_WORDS` and
 * `SUPPORT_TEAM_WORDS`.
 */
export const REPLIES_PHONE_WORDS = {
  editTitle: 'Change the saved reply',
  whoKeeps: 'Support leads and admins keep these. Ask one of them to add an answer worth keeping.',
  deleteTitle: 'Delete this saved reply?',
  deleteAsk: (title: string) =>
    `“${title}” goes for everyone answering support, and the AI stops reading it before it drafts. This can’t be undone.`,
  deleteConfirm: 'Delete it',
  keep: 'Keep it',
  saved: 'Saved',
  deleted: 'Deleted',
} as const;

export const TEAM_PHONE_WORDS = {
  pickRole: 'What they may do',
  suspendTitle: (name: string) => `Suspend ${name}?`,
  suspendAsk:
    'They can’t open the support desk until you let them back in. Their tickets stay with them, and nothing they wrote is lost.',
  suspendConfirm: 'Suspend them',
  removeTitle: (name: string) => `Remove ${name} from support?`,
  removeAsk:
    'They lose the support desk straight away. Their open tickets go back to the queue, and their name stays on the ones they answered. To have them back, invite them again.',
  removeConfirm: 'Remove them',
  keep: 'Keep them',
  roleChanged: 'Role changed',
  suspended: 'Suspended',
  letBackIn: 'Let back in',
  removed: 'Removed',
  resent: 'Sent again',
  revoked: 'Invitation cancelled',
} as const;
