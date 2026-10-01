/**
 * The usage rate card on the support desk (M16, step 8), said once for the web's /admin/rates and the phone's. The
 * margin is the reason the page exists: the seeded prices are Twilio's and Anthropic's list prices, guesses until a
 * real week measures them, and a guess that is wrong loses money quietly for a month.
 */

import { money } from '../money/format';

/** The promise: at least one and a half times what it cost us. A line realising under this, somebody looks today. */
export const RATE_MARGIN_FLOOR = 1.2;

/** Our own cost, which only staff ever see: micro-dollars are unreadable, so it is shown per unit. */
export const rateCostWords = (micros: number): string =>
  micros >= 10_000 ? money(Math.round(micros / 10_000)) : `${(micros / 10_000).toFixed(3)}¢`;

/** "1.50×": a markup, as a ratio of what it costs us. */
export const rateMarkupWords = (markup: number): string => `${markup.toFixed(2)}×`;

/** "12 · $3.10 on $1.95": what a line did over the window. */
export const rateRealisedWords = (realised: {
  readonly events: number;
  readonly chargedCents: number;
  readonly costCents: number;
}): string =>
  `${realised.events} · ${money(realised.chargedCents)} on ${money(realised.costCents)}`;

/** Whether a line charged under the floor over the window. A line nothing happened on isn't thin. */
export const rateIsThin = (line: {
  readonly realised: { readonly markup: number } | null;
}): boolean => line.realised !== null && line.realised.markup < RATE_MARGIN_FLOOR;

/** The warning over the card, naming each thin line; null when every line is holding. */
export function rateThinWarning(
  lines: readonly { readonly key: string; readonly realised: { readonly markup: number } | null }[],
): string | null {
  const thin = lines.filter(rateIsThin);
  if (!thin.length) return null;
  const one = thin.length === 1;
  return `${one ? 'One line is' : `${thin.length} lines are`} charging under ${RATE_MARGIN_FLOOR}× what ${
    one ? 'it costs' : 'they cost'
  } us: ${thin.map((l) => l.key).join(', ')}. Either the cost moved or the price is wrong.`;
}

export const RATES_WORDS = {
  measured: (version: number, days: number) =>
    `Card version ${version} · measured over the last ${days} days`,
  what: 'What',
  costsUs: 'Costs us',
  charged: 'Charged',
  realised: 'Realised',
  /** A line nothing happened on over the window. */
  nothingYet: '—',
  notEditable:
    'Publishing a new version retires every live line at once, so a card is never half old and half new. It is not editable here yet: use',
  publishFunction: 'private.publish_usage_rates',
} as const;
