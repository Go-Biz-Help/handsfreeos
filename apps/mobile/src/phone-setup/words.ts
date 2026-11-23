/**
 * The guided phone number setup's words that only the phone says. Everything the web's page also says is core's
 * (guided-setup/phone.ts, PHONE_SETUP_WORDS); the phone adds only the parts it leaves to a computer (moving a number
 * they already have, and getting approved to text, a long form) and what comes of working without signal.
 */
export const PHONE_SETUP_PHONE_WORDS = {
  notAllowed: 'Only someone who can change the business’s texting and calls can set up its number.',
  notAllowedHint: 'Ask an owner of this business.',
  /** "Yes, and I want to keep it" and "It's in Twilio or HighLevel": a few forms and a bill, done on a computer. */
  moveOnComputer:
    'Moving a number here takes a few forms and a recent bill from your phone company. That’s easier on a computer, so we email you a link to it.',
  /** Done, for those who want to text: the carriers' questions are a long form. */
  approveOnComputer:
    'It’s a longer form, so it’s easier on a computer. We email you a link that opens it there.',
  saved: 'Saved. Your number is set up the way you said.',
  /** The usual greeting, under the box, while it is left empty. */
  greetingEmpty: 'Leave it empty and callers hear the one shown.',
  pickTime: 'Pick a time',
  pickState: 'Pick the state',
  searchStates: 'Search, like Texas or TX',
  pickMiles: 'How far out',
  pickStart: 'How it starts',
  anyStart: 'Any',
  cityOnly: 'That city only',
  within: (miles: string) => `Within ${miles} miles`,
} as const;
