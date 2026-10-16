/**
 * The words only the phone's Add-on votes, Rates and Founding say: what the web's /admin needs none for, because a
 * browser page can simply 404, has room for a table and can copy to the clipboard. What both say is core's
 * `ADDON_VOTES_WORDS`, `RATES_WORDS` and `FOUNDING_WORDS`.
 */

/** How far back the rate card's margin can measure on the phone, where the web takes any number in its address. */
export const RATE_WINDOWS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
] as const;

export type RateWindow = (typeof RATE_WINDOWS)[number]['days'];

export const MONEY_DESK_WORDS = {
  /** A support person whose role doesn't open the section, here from an old link. */
  onlyAdmins: (section: string) =>
    `Only a support admin can open ${section}. Ask one if something here needs doing.`,
  measuredOver: 'Measured over',
  /** Under the claim link, where the web has a Copy button. */
  holdToCopy: 'Press and hold the link to copy it.',
  shareLink: 'Share the link',
  declined: (business: string) => `Declined ${business}.`,
  revoked: (business: string | null) =>
    `Took the seat back from ${business ?? 'that business'}. It’s free for somebody else.`,
  restored: (business: string | null) => `${business ?? 'That business'} has its seat back.`,
  /** A seat approved, given or turned on: on their workspace now, until somebody revokes it. */
  turnedOn: (business: string | null) =>
    `${business ?? 'That business'} has a founding seat. It stays on until you revoke it.`,
  capSaved: (name: string, seats: number) => `${name} now has ${seats} seats.`,
  opened: (name: string) => `${name} is open.`,
  closed: (name: string) => `${name} is closed.`,
  /** The cap box when what's typed isn't a whole number. */
  capNotNumber: 'Type a whole number of seats, like 25.',
} as const;
