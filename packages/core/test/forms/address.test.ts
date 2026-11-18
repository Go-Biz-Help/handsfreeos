/**
 * An address question with Google's address search on: the address Google hands back for a picked suggestion fills
 * the street, town, state and ZIP boxes (`addressFromPlace`), and only a question that asks for the street searches.
 */
import { describe, expect, it } from 'vitest';
import {
  addressFromPlace,
  QUESTION_CONFIGS,
  searchesAddresses,
  type PlaceAddressPart,
} from '../../src/forms/index';

const part = (types: string[], longText: string, shortText = longText): PlaceAddressPart => ({
  types,
  longText,
  shortText,
});

/** 1500 Marilla St, Dallas, TX 75201, as Places API (New) gives it. */
const DALLAS: PlaceAddressPart[] = [
  part(['street_number'], '1500'),
  part(['route'], 'Marilla Street', 'Marilla St'),
  part(['neighborhood', 'political'], 'Government District'),
  part(['locality', 'political'], 'Dallas'),
  part(['administrative_area_level_2', 'political'], 'Dallas County'),
  part(['administrative_area_level_1', 'political'], 'Texas', 'TX'),
  part(['country', 'political'], 'United States', 'US'),
  part(['postal_code'], '75201'),
  part(['postal_code_suffix'], '6318'),
];

describe('Google address search on a form', () => {
  it('fills the street, town, state and ZIP from the picked address', () => {
    expect(addressFromPlace(DALLAS)).toEqual({
      line1: '1500 Marilla St',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
    });
  });

  it('puts an apartment on the end of the street', () => {
    expect(addressFromPlace([...DALLAS, part(['subpremise'], '4B')]).line1).toBe(
      '1500 Marilla St #4B',
    );
    expect(addressFromPlace([...DALLAS, part(['subpremise'], 'Suite 200')]).line1).toBe(
      '1500 Marilla St Suite 200',
    );
  });

  it('takes the nearest thing to a town when Google has no city', () => {
    const brooklyn = [
      part(['street_number'], '200'),
      part(['route'], 'Eastern Parkway', 'Eastern Pkwy'),
      part(['sublocality_level_1', 'sublocality', 'political'], 'Brooklyn'),
      part(['administrative_area_level_1', 'political'], 'New York', 'NY'),
      part(['postal_code'], '11238'),
    ];
    expect(addressFromPlace(brooklyn)).toEqual({
      line1: '200 Eastern Pkwy',
      city: 'Brooklyn',
      state: 'NY',
      postalCode: '11238',
    });
  });

  it('leaves what Google left out empty, for them to type', () => {
    expect(addressFromPlace([part(['locality', 'political'], 'Austin')])).toEqual({
      line1: '',
      city: 'Austin',
      state: '',
      postalCode: '',
    });
  });

  it('searches only when it is turned on and the question asks for the street', () => {
    const config = (search: unknown, detail?: string) =>
      QUESTION_CONFIGS.address.parse({ search, ...(detail ? { detail } : {}) });
    // Off until the business turns it on, so forms saved before it keep their plain boxes.
    expect(QUESTION_CONFIGS.address.parse({}).search).toBe(false);
    expect(searchesAddresses({ type: 'address', config: config(true) })).toBe(true);
    expect(searchesAddresses({ type: 'address', config: config(false) })).toBe(false);
    expect(searchesAddresses({ type: 'address', config: config(true, 'city_postal') })).toBe(false);
    expect(searchesAddresses({ type: 'short_text', config: { search: true } })).toBe(false);
  });
});
