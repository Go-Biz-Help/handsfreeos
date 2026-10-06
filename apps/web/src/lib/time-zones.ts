import { US_TIME_ZONES } from '@hfos/core';

/** The time zones a business picks from in Settings and when adding a business: "Central (Chicago)". */
export const TIMEZONES = US_TIME_ZONES.map((z) => [z.id, `${z.label} (${z.example})`] as const);
