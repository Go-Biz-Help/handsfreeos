import { describe, expect, it } from 'vitest';
import {
  guessMapping,
  mapCompanyRow,
  mapPersonRow,
  readCallConsent,
} from '../src/crm/import-mapping';

describe('the import’s “Agreed to calls” column', () => {
  it('reads yes and no words the way spreadsheets write them', () => {
    for (const yes of ['Yes', 'y', 'TRUE', '1', 'x', '✓', 'Opted-in', 'opt_in', 'Agreed', 'OK'])
      expect(readCallConsent(yes)?.answer, yes).toBe('opted_in');
    for (const no of [
      'No',
      'n',
      'false',
      '0',
      'Opted out',
      'DNC',
      'Do not call',
      'Don’t call',
      'STOP',
    ])
      expect(readCallConsent(no)?.answer, no).toBe('opted_out');
  });

  it('takes a date as a yes given that day, and keeps the day', () => {
    for (const day of [
      '2026-10-01',
      '10/1/2026',
      '10-01-26',
      'Oct 1, 2026',
      '1 Oct 2026',
      '2026-10-01T14:05:00Z',
    ])
      expect(readCallConsent(day), day).toEqual({ answer: 'opted_in', value: day, on: day });
  });

  it('leaves an empty cell alone and never guesses at anything else', () => {
    expect(readCallConsent('')).toBeNull();
    expect(readCallConsent('   ')).toBeNull();
    expect(readCallConsent(null)).toBeNull();
    for (const unclear of ['maybe', 'pending', '?', 'yes please call after 5', 'unknown', '2'])
      expect(readCallConsent(unclear)?.answer, unclear).toBe('unclear');
  });

  it('guesses only headers plainly about calls, and maps the row’s own where', () => {
    const mapping = guessMapping(
      ['Name', 'Phone', 'Agreed to calls', 'Where they agreed', 'Consent'],
      'people',
    );
    expect(mapping).toMatchObject({
      'Agreed to calls': 'call_consent',
      'Where they agreed': 'call_consent_source',
      // A bare "consent" may be about texts: the importer picks it themselves.
      Consent: 'skip',
    });
    expect(guessMapping(['TCPA consent', 'Opt in source'], 'people')).toEqual({
      'TCPA consent': 'call_consent',
      'Opt in source': 'call_consent_source',
    });
    expect(
      mapPersonRow(
        { Name: 'Ann Lee', 'Agreed to calls': 'Yes', 'Where they agreed': 'Website form' },
        mapping,
      ).callConsent,
    ).toEqual({ answer: 'opted_in', value: 'Yes', on: null, where: 'Website form' });
    expect(
      mapPersonRow({ Name: 'Ann Lee', 'Agreed to calls': '' }, mapping).callConsent,
    ).toBeNull();
    expect(mapPersonRow({ Name: 'Ann Lee' }, { Name: 'full_name' }).callConsent).toBeNull();
  });

  it('is a people column only', () => {
    const mapping = guessMapping(['Company name', 'Agreed to calls'], 'companies');
    expect(mapping['Agreed to calls']).toBe('skip');
    expect(mapCompanyRow({ 'Company name': 'ABC' }, mapping)).not.toHaveProperty('callConsent');
  });
});
