/**
 * The guided email setup's words that only the phone says (the owner, 22 Nov 2026). Everything the web's screens
 * also say is core's (messaging/email-guided.ts); the phone adds what a finger does in place of a mouse, and the
 * parts it leaves to a computer: Settings → Email is on the web.
 */
export const EMAIL_GUIDED_PHONE_WORDS = {
  /** Check it over, where the web says "click". */
  reviewHint:
    'Nothing changes until you tap Set it up. Your answers are saved, so you can leave and come back.',
  freeNow: (free: string) => `Emails go out from ${free} as soon as you tap Set it up.`,
  /** Under an address that is already set up, on "Who reads each one?". */
  existingReader: 'Already set up. To change who reads it, open Settings → Email on the web.',
  /** The last step: the records are read off, held to copy, or shared whole. */
  share: 'Share',
  holdToCopy: 'Hold a name or a value to copy it.',
  /** Under Done's list, where the web links Settings → Email. */
  onTheWeb: 'on the web',
} as const;
