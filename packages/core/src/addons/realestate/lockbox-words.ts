/**
 * A listing's lockboxes, in words (round seven; boards 94-95 and 98): the same on the web and the phone. Browser-safe.
 * The code itself is never here: the web shows it again only through the worker, and phones never have it.
 */

export const LOCKBOX_KIND_KEYS = ['sentrilock', 'supra', 'combination', 'keypad', 'other'] as const;
export type LockboxKindKey = (typeof LOCKBOX_KIND_KEYS)[number];

export const LOCKBOX_KIND_LABELS: Readonly<Record<LockboxKindKey, string>> = {
  sentrilock: 'SentriLock',
  supra: 'Supra',
  combination: 'Combination lockbox',
  keypad: 'Keypad',
  other: 'Lockbox',
};

/** The kinds as the picker names them, shorter than the labels. */
export const LOCKBOX_KIND_CHOICES: Readonly<Record<LockboxKindKey, string>> = {
  sentrilock: 'SentriLock',
  supra: 'Supra',
  combination: 'Combination',
  keypad: 'Keypad',
  other: 'Other',
};

export const LOCKBOX_WORDS = {
  title: 'Lockboxes',
  none: 'None yet. Add the listing’s lockbox and its code goes to the confirmed agent, just before each showing.',
  add: 'Add a lockbox',
  edit: 'Change',
  remove: 'Remove',
  removed: 'Removed. Its code won’t go out again.',
  saved: 'Saved. The code is locked.',
  savedNoCode: 'Saved.',
  kind: 'Kind',
  place: 'Where it is',
  placeHint: 'Front door, side gate…',
  serial: 'Serial number',
  serialHint: (kind: string) => `How ${kind}’s emails are matched to this listing.`,
  code: 'Code',
  codeKeep: 'Leave empty to keep the code it has.',
  codeHelp:
    'Locked as you save it: nobody can read it back but someone on this listing, and each time is kept in the history. It goes only into the access email to the confirmed agent, just before a showing.',
  keptLocked: 'Kept locked',
  noCode: 'No code',
  showCode: 'Show code',
  hide: 'Hide',
  shownAt: (time: string) => `Shown to you at ${time}. It’s in the deal’s history.`,
  openingsTitle: 'Who opened them',
  openingsFrom: 'From SentriLock’s and Supra’s emails',
  noOpenings: 'No openings read yet. SentriLock’s and Supra’s emails show here once they arrive.',
  fits: 'Fits a showing',
  noShowing: 'No showing booked',
  /** Phones never have the code. */
  phoneNever:
    'The code never comes onto phones. It goes to the confirmed agent by itself, just before a showing; to see it, use the web.',
  needsSignal: 'Lockboxes load with signal.',
  emailsTitle: 'Lockbox emails',
  emailsOn:
    'SentriLock’s and Supra’s “opened” emails are read from the Inbox into the listing they’re about, by serial, then address. An opening with no showing booked alerts the listing’s agents.',
  emailsOff: 'Their emails stay in the Inbox, and nothing is read from them.',
  emailsTurnedOn: 'Their emails are read into your listings now.',
  emailsTurnedOff: 'Their emails stay in the Inbox now.',
} as const;

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const VENDOR: Readonly<Record<'sentrilock' | 'supra', string>> = {
  sentrilock: 'SentriLock',
  supra: 'Supra',
};

/** "SentriLock’s email". */
export const openingSource = (vendor: 'sentrilock' | 'supra'): string =>
  `${VENDOR[vendor]}’s email`;

/** "Ana Ruiz · Compass", "Someone" when the email didn't say. */
export function openingWho(o: { openedBy: string | null; company: string | null }): string {
  return [o.openedBy, o.company].filter(Boolean).join(' · ') || 'Someone';
}

/** "SentriLock · front door · serial 31-118204" for a lockbox's line on the phone. */
export function lockboxLine(l: {
  kindLabel: string;
  place: string | null;
  serial: string | null;
  hasCode: boolean;
}): { title: string; detail: string } {
  return {
    title: [l.kindLabel, l.place?.toLowerCase()].filter(Boolean).join(' · '),
    detail: capitalize(
      [l.serial ? `Serial ${l.serial}` : null, l.hasCode ? 'code kept locked' : 'no code']
        .filter(Boolean)
        .join(' · '),
    ),
  };
}

/** "Ana Ruiz" over "Compass · fits a showing", for an opening's line on the phone. */
export function openingLine(o: {
  openedBy: string | null;
  company: string | null;
  booked: boolean;
}): { who: string; detail: string } {
  return {
    who: o.openedBy || o.company || 'Someone',
    detail: capitalize(
      [o.openedBy ? o.company : null, o.booked ? 'fits a showing' : 'no showing booked']
        .filter(Boolean)
        .join(' · '),
    ),
  };
}
