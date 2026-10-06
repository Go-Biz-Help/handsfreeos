import { PHONE_GUIDE_WORDS } from '@hfos/core';

/**
 * Quick setup's words that only the phone says (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8). Everything the
 * web's screens also say is core's (ai-setup/words.ts); the phone adds only what comes of working without signal, the
 * pickers a phone draws in place of a menu, its own alerts in place of "Get the phone app", and the PDF it leaves to a
 * computer.
 */
export const AI_SETUP_PHONE_WORDS = {
  needsSignal: 'Quick setup needs signal. It picks up where you are once you’re back online.',
  tryAgain: 'Try again',
  notAllowed: 'Only people who manage the AI teammate can set it up.',
  notAllowedHint: 'Ask an owner or admin of this business.',
  /** The kind-of-business field before one is picked, and its sheet. */
  pickKind: 'Pick the kind of business',
  searchKinds: 'Search, like plumber or dog grooming',
  noKindFits: 'Nothing fits those words. Pick Other at the end of the list.',
  /** The hours editor's time picker. */
  opens: 'Opens',
  closes: 'Closes',
  closed: 'Closed',
  addHours: 'Add hours',
  removeHours: 'Remove these hours',
  midnight: 'Midnight',
  /** The choices a question for leads offers, on its own sheet. */
  answerWith: 'They answer with',
  /** "Stay in the loop": this phone's alerts, in place of the web's "Get the phone app". */
  alertsTitle: 'Alerts on this phone',
  alertsOn: 'Alerts are on. This phone hears when {name} needs a person.',
  alertsOff: 'Turn them on, so this phone hears when {name} needs a person.',
  turnOnAlerts: 'Turn on alerts',
  /** "Stay in the loop" before the business has a number to confirm a cell from. */
  cellNoNumber:
    'Once the business has a number, add your cell in More → Settings → My cell phone, so hand-off texts reach you.',
  openSettings: PHONE_GUIDE_WORDS.openSettings,
  notificationsOff: PHONE_GUIDE_WORDS.notificationsOff,
  /** "What Ava learned": a PDF is picked on a computer. */
  pdfOnComputer: 'To add a PDF, like a price sheet or menu, open Knowledge on a computer.',
  /** The test chat's worker isn't in this build, or not on this server yet. */
  testNotHere:
    'The test chat isn’t ready in this app yet. Try it on the web, on the AI teammate page.',
  shareCode: 'Share the code',
  /** "Set it up myself" and "More settings" open the web. */
  onTheWeb: 'Opens on the web',
} as const;
