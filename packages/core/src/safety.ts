/**
 * Check-ins (round six): the limits, the business's default times, and the words both apps use. Browser-safe, so the
 * web and the phone say the same thing (packages/core/src/commands/safety.ts does the work).
 */

export const SAFETY_LIMITS = {
  /** A check-in lasts up to 12 hours (the database holds it too). */
  longestMinutes: 12 * 60,
  /** Contacts a person may keep. */
  contacts: 5,
} as const;

/** The business's times unless it sets its own (Settings → Safety). */
export const SAFETY_DEFAULTS = {
  /** Minutes after the planned end before the person is asked "Still there?". */
  askAfterMinutes: 0,
  /** Minutes after asking, with no answer, before the contacts are told. */
  alertAfterMinutes: 10,
  /** Minutes between telling them again, until someone answers. */
  repeatMinutes: 10,
} as const;

export type SafetyContactStatus = 'teammate' | 'asked' | 'agreed' | 'stopped';

export function contactStatus(c: {
  readonly teammate: boolean;
  readonly agreed: boolean;
  readonly stopped: boolean;
}): SafetyContactStatus {
  if (c.teammate) return 'teammate';
  if (c.stopped) return 'stopped';
  return c.agreed ? 'agreed' : 'asked';
}

/** How a contact's state reads under their name on My safety. */
export const SAFETY_CONTACT_WORDS: Readonly<Record<SafetyContactStatus, string>> = {
  teammate: 'Teammate · an alert only they see',
  asked: 'Asked by text · hasn’t agreed yet',
  agreed: 'Text and email · agreed',
  stopped: 'Said STOP · gets nothing',
};

/** The business's times for its ladder (Settings → Safety): each a whole number of minutes. */
export interface SafetyTimes {
  readonly askAfterMinutes: number;
  readonly alertAfterMinutes: number;
  readonly repeatMinutes: number;
}

const minutesWords = (n: number) => (n === 1 ? '1 minute' : `${n} minutes`);

/**
 * The business's times as each person reads them (board 91, My safety's "When"; the web's Safety page): "Ask me
 * after 0 minutes", "Then tell them after 10 more minutes", "Tell them again every 10 minutes".
 */
export function safetyTimesLines(t: SafetyTimes): { label: string; value: string }[] {
  return [
    { label: 'Ask me after', value: minutesWords(t.askAfterMinutes) },
    {
      label: 'Then tell them after',
      value: t.alertAfterMinutes === 1 ? '1 more minute' : `${t.alertAfterMinutes} more minutes`,
    },
    { label: 'Tell them again every', value: `${minutesWords(t.repeatMinutes)}, for an hour` },
  ];
}

/** Under the times, for everyone: who's told with no contacts, and where the times are set. */
export const SAFETY_TIMES_NOTE =
  'Nobody set? The business’s safety person is told. Owners set the business’s times in Settings → Safety on the web.';

/**
 * What an outside contact replies to agree. Never YES: that's one of the carriers' own keywords (START, YES,
 * UNSTOP), answered by the carrier before HandsFreeOS sees it.
 */
export const SAFETY_AGREE_WORDS: ReadonlySet<string> = new Set(['OK', 'OKAY', 'AGREE', 'I AGREE']);

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "Sam", "Sam and Marcus", "Sam, Jo and Marcus". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The push at the planned end, to the person: "Still at 2207 Juniper Trail?". */
export function safetyAskWords(c: {
  readonly place: string;
  /** "4:45 PM", in the business's time zone. */
  readonly plannedEnd: string;
  readonly alertAfterMinutes: number;
  /** First names of the contacts who'd be told; none: the business's safety person is. */
  readonly contacts: readonly string[];
}): { title: string; body: string } {
  const who = c.contacts.length
    ? `${namesList(c.contacts)} ${c.contacts.length === 1 ? 'is' : 'are'} told`
    : 'the business’s safety person is told';
  return {
    title: `Still at ${c.place}?`,
    body: `You planned to check out at ${c.plannedEnd}. If you don’t answer in ${c.alertAfterMinutes} minutes, ${who}.`,
  };
}

/** The push to a teammate who's told: "Dana hasn’t checked out". */
export function safetyAlertPushWords(c: {
  readonly person: string;
  readonly place: string;
  readonly plannedEnd: string;
  readonly phone: string | null;
  readonly help: boolean;
}): { title: string; body: string } {
  const first = firstOf(c.person);
  const call = c.phone ? ` Call ${first}: ${c.phone}.` : '';
  return c.help
    ? { title: `${first} asked for help`, body: `At ${c.place}.${call}` }
    : {
        title: `${first} hasn’t checked out`,
        body: `Planned to leave ${c.place} by ${c.plannedEnd}.${call}`,
      };
}

/** The one text asking someone outside to be a contact. Straight apostrophes: it's a text. */
export function safetyConsentText(c: {
  readonly person: string;
  readonly business: string;
}): string {
  const first = firstOf(c.person);
  return `${c.person} added you as a safety contact at ${c.business}. If ${first} doesn't check out of a visit, we'll text you where they were. Reply OK to agree, or STOP to never get these.`;
}

/** The answer to OK. */
export function safetyAgreedText(c: { readonly people: readonly string[] }): string {
  const names = namesList(c.people.map(firstOf)) || 'they';
  return `Thanks. You'll only hear from us if ${names} doesn't check out.`;
}

/** The alert text to someone outside, with their own link. */
export function safetyAlertText(c: {
  readonly person: string;
  readonly place: string;
  readonly plannedEnd: string;
  readonly phone: string | null;
  readonly help: boolean;
  readonly link: string;
}): string {
  const first = firstOf(c.person);
  const what = c.help
    ? `${c.person} asked for help at ${c.place}.`
    : `${c.person} hasn't checked out of ${c.place} (planned end ${c.plannedEnd}).`;
  const call = c.phone ? ` Call ${first}: ${c.phone}.` : '';
  return `${what}${call} Tell us you reached them: ${c.link}`;
}

/** The all-clear, to whoever was told. */
export function safetyOkText(c: { readonly person: string }): string {
  return `${c.person} is OK. Nothing more to do. Thanks for looking out.`;
}
