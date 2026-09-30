import { DESK_WORDS } from '@hfos/core';

/**
 * The words only the phone's Support desk says: what the web's /admin needs no words for, because a browser always has
 * a signal and a page can simply 404. What both say is core's `DESK_WORDS`.
 */
export const DESK_PHONE_WORDS = {
  ...DESK_WORDS,
  moreRow: 'Support desk',
  moreDetail: 'HandsFreeOS’s tickets and admin',
  loading: 'Getting it from HandsFreeOS…',
  needsSignal: 'The support desk needs a signal. Try again when you’re back online.',
  retry: 'Try again',
  notStaff:
    'This is HandsFreeOS’s own support desk, for the people who answer support. Your sign-in isn’t one of them.',
  checking: 'Checking you can open the support desk…',
  backToBusiness: 'Back to your business',
  signOut: 'Sign out',
  openOnWeb: 'Open on the web',
  showMore: 'Show more',
  saved: 'Saved',
  sent: 'Sent',
  noteSaved: 'Note saved',
  cancel: 'Cancel',
  savedReplies: 'Saved replies',
  writeBack: 'Write back',
  reply: 'Reply',
  pickStatus: 'Change the status',
  pickPriority: 'Change the priority',
  pickAssignee: 'Give it to someone',
  draftAsked: 'Asked the AI. The draft shows here when it’s written.',
  lookOnWeb: 'Look at their business on the web',
  lookOnWebDetail: 'Read-only, with a reason and a time limit, as on the web',
  openAsOwnerOnWeb: 'Open as owner on the web',
} as const;
