/**
 * About you (docs/outreach.md, decision 165; the owner, 14 Nov 2026: "so maybe we need a personal info section"): what
 * a person says of themselves, in their own words, for every AI that writes as them. One box on Settings → Account,
 * on the web and the phone, and the words both show. Theirs alone: no teammate reads it.
 *
 * The AI uses it only when the other person's post or message brings it up (a "same here" when it's true), never to
 * bring up the person's own life first, and with nothing here it never claims to share anyone's background.
 * Browser-safe.
 */

/** The most About you holds: a few short paragraphs. */
export const ABOUT_YOU_MOST = 2000;

export const ABOUT_YOU_WORDS = {
  title: 'About you',
  lead: 'A few things about you, in your own words, so the AI that writes as you never guesses. It writes your outreach messages and comments.',
  label: 'About you',
  placeholder:
    'For example: I grew up in Greenville, South Carolina. Married with two boys. I played college baseball and I’m a big Braves fan. I was a roofer for ten years before I started this business.',
  /** What's worth saying, beside the box. */
  ideasTitle: 'Things worth adding',
  ideas: [
    'Where you’re from, and where you live now',
    'Your heritage or culture, and the languages you speak',
    'Family: married, kids, pets',
    'Your faith, if you’d speak of it',
    'Hobbies, sports and the teams you root for',
    'Past jobs, the military, schools',
  ],
  how: 'The AI only uses this when someone’s own post or message brings it up, like “same here” when it’s true for you. It never brings up your personal life first, and with nothing here it never says you share someone’s background.',
  private: 'Only you see this. Your teammates each fill in their own.',
  save: 'Save',
  saved: 'Saved. The AI knows this about you from now on.',
  cleared: 'Cleared. The AI knows nothing personal about you now.',
  /** Under the phone's row on Settings. */
  rowDetail: 'What the AI that writes as you knows about you',
  /** The phone reads and saves it with signal: it's never kept in the phone's copy. */
  needsSignal: 'About you needs signal to open. Try again when you’re back online.',
  retry: 'Try again',
  tooLong: `Keep it under ${ABOUT_YOU_MOST.toLocaleString('en-US')} characters.`,
} as const;
