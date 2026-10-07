import { PHONE_GUIDE_WORDS } from '@hfos/core';

/**
 * The onboarding setup's words that only the phone says (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8).
 * Everything the web's screens also say is core's (onboarding-setup/words.ts, and the AI quick setup's for its
 * screens); the phone adds only what comes of working without signal, the sheets a phone draws in place of a menu,
 * the number search it does in place of Settings → Texting & calls, and the parts it leaves to a computer.
 */
export const ONBOARDING_SETUP_PHONE_WORDS = {
  needsSignal: 'Setting up needs signal. It picks up where you are once you’re back online.',
  tryAgain: 'Try again',
  notAllowed: 'Only people who manage this business can set it up.',
  notAllowedHint: 'Ask an owner of this business.',
  signOut: 'Sign out',
  /** Under the first screen, for someone in no business yet who was invited to one. */
  invited: 'Invited to someone else’s business? Open the invitation they emailed you to join it.',
  /** The address's state, and the time zone, each on a sheet. */
  pickState: 'Pick the state',
  searchStates: 'Search, like Texas or TX',
  pickTimeZone: 'Pick the time zone',
  /** "See the summary": the summary of the setup so far, on a sheet. */
  close: 'Close',

  // The number, found near the address and bought right here
  numbersNear: (city: string) => `Numbers near ${city}`,
  tollFreeNumbers: 'Toll-free numbers',
  pickNumber: 'Pick a number',
  searching: 'Looking for numbers…',
  nothingNear: (city: string) =>
    `Nothing free near ${city} right now. Try an area code, or numbers anywhere.`,
  nothingFree: 'No numbers are free there right now. Try another area code.',
  anywhere: 'Show numbers anywhere',
  areaCode: 'Area code',
  areaCodeHint: 'Three digits, like 512.',
  search: 'Search',
  getNumber: (display: string) => `Get ${display}`,
  bought: (display: string) => `${display} is yours. Calls ring now.`,
  /** The carriers' registration: a long form, easier on a computer. */
  registerOnComputer:
    'Texting needs your business details checked for the phone carriers. That form is easier on a computer.',
  haveNumber: 'Keeping a number you already have is easier on a computer.',
  numberOnComputer: 'Picking a number isn’t in this build of the app. It’s easier on a computer.',

  // Customers
  customersOnComputer:
    'Bringing customers in from GoHighLevel, a spreadsheet or another CRM is easier on a computer.',
  /** Under "My phone’s contacts": the picking is right here (the web points at the phone app). */
  phoneHint: 'Pick them one by one, right here. Personal contacts stay out.',

  // Booking
  share: 'Share the link',
  calendarOnComputer: 'Connecting Google or Outlook is easier on a computer.',

  // Payments
  payOnComputer: 'Connecting payments isn’t in this build of the app. It’s easier on a computer.',
  payBack: 'Come back here once you’ve signed in. Your setup waits where it is.',

  openSettings: PHONE_GUIDE_WORDS.openSettings,
} as const;
