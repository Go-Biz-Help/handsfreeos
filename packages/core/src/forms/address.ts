/**
 * An address question with Google's address search on (`config.search`): the address Google hands back for the
 * suggestion somebody picked, turned into the boxes the question asks for. Browser-safe, and the same for every
 * screen that shows an address question, so a picked address reads the same everywhere.
 */
import type { AddressAnswer } from './questions';

/** One part of an address as Google's Places API (New) gives it: "Dallas", or "TX" and "Texas". */
export interface PlaceAddressPart {
  readonly longText?: string | null;
  readonly shortText?: string | null;
  readonly types: readonly string[];
}

/** The most each box of an address answer holds (`AddressAnswer`). */
const MAX = { line1: 200, city: 120, state: 60, postalCode: 20 } as const;

const cut = (value: string, max: number) => value.slice(0, max).trim();

/**
 * The street, town, state and ZIP out of a picked address. The street is the number and the road ("1500 Marilla
 * St", Google's short road name as its own suggestions show it), or the building's name when there's no road, with
 * an apartment or suite on the end ("#4"). The town is the city, or the nearest thing to one Google has. The state is
 * its short form ("TX"). Whatever Google leaves out comes back empty, for them to type.
 */
export function addressFromPlace(parts: readonly PlaceAddressPart[]): Omit<AddressAnswer, 'line2'> {
  const find = (type: string) => parts.find((p) => p.types.includes(type));
  const long = (type: string) => (find(type)?.longText ?? '').trim();
  const short = (type: string) => {
    const part = find(type);
    return (part?.shortText ?? part?.longText ?? '').trim();
  };
  const road = short('route');
  const number = long('street_number');
  let line1 = road ? [number, road].filter(Boolean).join(' ') : long('premise');
  const unit = long('subpremise');
  if (line1 && unit) line1 = `${line1} ${/^[0-9a-z-]+$/i.test(unit) ? `#${unit}` : unit}`;
  const city =
    long('locality') ||
    long('postal_town') ||
    long('sublocality_level_1') ||
    long('sublocality') ||
    long('administrative_area_level_3') ||
    long('neighborhood');
  return {
    line1: cut(line1, MAX.line1),
    city: cut(city, MAX.city),
    state: cut(short('administrative_area_level_1'), MAX.state),
    postalCode: cut(long('postal_code'), MAX.postalCode),
  };
}

/** Whether an address question suggests addresses from Google: it's turned on, and the question asks for the street. */
export function searchesAddresses(question: { type: string; config?: unknown }): boolean {
  if (question.type !== 'address') return false;
  const config = (question.config ?? {}) as { search?: boolean; detail?: string };
  return config.search === true && (config.detail ?? 'full') === 'full';
}
