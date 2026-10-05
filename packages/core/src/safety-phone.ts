import { namesList } from './safety';

/**
 * Check-ins on the phone (round six, boards 90–91): checking in, the banner on every screen while checked in, +15 min,
 * Help with or without signal, and My safety. Browser-safe; the texts and pushes are in `safety.ts`.
 */

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "Sam is told", "Sam and Marcus are told"; nobody set: the business's safety person. */
export function safetyWhoIsTold(firstNames: readonly string[]): string {
  if (firstNames.length === 0) return 'the business’s safety person is told';
  return `${namesList(firstNames)} ${firstNames.length === 1 ? 'is' : 'are'} told`;
}

export const SAFETY_PHONE_WORDS = {
  // Checking in.
  checkIn: 'Check in',
  checkInTitle: 'Check in',
  whereLabel: 'Where',
  wherePlaceholder: 'The address, or what it is',
  needsPlace: 'Say where you are, so the people you chose know where to look.',
  checkOutBy: 'Check out by',
  other: 'Other',
  ifYouDont: 'If you don’t, HandsFreeOS tells',
  nobodySet:
    'Nobody set yet, so the business’s safety person is told. Choose your own in More → Settings → My safety.',
  shareWhere: 'Share where I am until I check out',
  // Following the phone while checked in (round seven): Android's notification, and the banner's line.
  followingTitle: 'Sharing where you are',
  followingBody: (place: string) =>
    `Until you check out of ${place}. Only the people told if you don’t check out see it.`,
  checkedInToast: (time: string) => `Checked in until ${time}.`,
  // The banner.
  checkedIn: 'Checked in',
  until: (time: string, firstNames: readonly string[]) =>
    `Until ${time} · ${capitalize(safetyWhoIsTold(firstNames))} if you don’t check out`,
  overdue: (time: string) => `It’s past ${time}. Are you OK?`,
  checkOut: 'Check out',
  imOk: 'I’m OK',
  add15: '+15 min',
  checkedOut: 'Checked out. Glad you’re OK.',
  added: (time: string) => `You’re checked in until ${time}.`,
  // Help.
  help: 'Help',
  helpTitle: 'Help',
  helpNoSignal: 'No signal for HandsFreeOS. Your phone can still call and text.',
  helpSent: (firstNames: readonly string[]) =>
    firstNames.length
      ? `${namesList(firstNames)} ${firstNames.length === 1 ? 'is' : 'are'} being told now, with where you are.`
      : 'The business’s safety person is being told now, with where you are.',
  helpNote: (firstNames: readonly string[]) =>
    `With signal, Help also alerts ${firstNames.length ? namesList(firstNames) : 'the business’s safety person'} at once with where you are. HandsFreeOS never calls 911 for you.`,
  call911: 'Call 911',
  textFromPhone: (name: string) => `Text ${firstOf(name)} from your phone`,
  call: (name: string) => `Call ${firstOf(name)}`,
  /** The text the person's own phone writes for them. Straight apostrophes: it's a text. */
  helpText: (place: string) => `I need help. I'm at ${place}.`,
  // My safety.
  mySafety: 'My safety',
  mySafetyDetail: 'Who’s told if you don’t check out',
  whoIsTold: 'Who’s told if you don’t check out',
  addSomeone: 'Add someone',
  addTitle: 'Add someone',
  aTeammate: 'A teammate',
  someoneOutside: 'Someone outside',
  pickTeammate: 'Pick a teammate',
  nameLabel: 'Name',
  phoneLabel: 'Phone',
  emailLabel: 'Email',
  outsideNote:
    'They get one text asking them to agree, and nothing until they reply OK. Reply STOP and they never get these.',
  save: 'Save',
  remove: 'Remove',
  removeAsk: (name: string) =>
    `Remove ${firstOf(name)}? They won’t be told if you don’t check out.`,
  when: 'When',
  askMeAfter: 'Ask me after',
  thenTell: 'Then tell them after',
  minutes: (n: number) => (n === 1 ? '1 minute' : `${n} minutes`),
  moreMinutes: (n: number) => (n === 1 ? '1 more minute' : `${n} more minutes`),
  whenNote:
    'Nobody set? The business’s safety person is told. Owners set the business’s times in Settings → Safety on the web.',
  onlyYou: 'Only you see your contacts. Owners see neither your contacts nor the places.',
  noContacts: 'Nobody yet. Add a teammate or someone you trust.',
  needsSignal: 'Changing who’s told needs signal. Try again when you have signal.',
} as const;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
