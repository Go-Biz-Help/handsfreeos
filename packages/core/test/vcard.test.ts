/**
 * Contacts files (.vcf) as phones and mail apps export them (the owner, 2026-11-25: "will this be able to add contacts
 * via a csv file or vcf file?"). The cards here are made up, in each app's own way of writing them.
 */
import { describe, expect, it } from 'vitest';
import { guessMapping, mapPersonRow } from '../src/crm/import-mapping';
import {
  looksLikeVcard,
  parseVcards,
  vcardBirthday,
  vcardName,
  vcardNote,
  vcardTable,
} from '../src/crm/vcard';

/** An iPhone's export: vCard 3.0, grouped labels, a folded photo, a birthday with no year. */
const IPHONE = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iPhone OS 18.1//EN',
  'N:Smith;Dana;Marie;;',
  'FN:Dana Marie Smith',
  'ORG:Smith Roofing;',
  'TITLE:Owner',
  'EMAIL;type=INTERNET;type=WORK:dana@smithroofing.example',
  'EMAIL;type=INTERNET;type=HOME;type=pref:dana.smith@mail.example',
  'TEL;type=WORK;type=VOICE:(512) 555-0100',
  'TEL;type=CELL;type=VOICE:(512) 555-0199',
  'item1.ADR;type=WORK:;Suite 4;12 Main St\\nBuilding B;Austin;TX;78701;United States',
  'item1.X-ABADR:us',
  'item2.URL;type=pref:https://smithroofing.example',
  'item2.X-ABLabel:_$!<HomePage>!$_',
  'BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-12',
  'NOTE:Met at the home show\\, wants a quote',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHR',
  ' ofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy',
  'END:VCARD',
].join('\r\n');

/** Google Contacts' export: vCard 3.0, one name only, a mobile with no other number. */
const GOOGLE = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Lee Park',
  'N:Park;Lee;;;',
  'TEL;TYPE=CELL:+1 737-555-0123',
  'CATEGORIES:myContacts',
  'END:VCARD',
].join('\n');

/** An Android export: vCard 2.1, bare types, a name in quoted-printable UTF-8 with a soft break. */
const ANDROID = [
  'BEGIN:VCARD',
  'VERSION:2.1',
  'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Ort=C3=ADz;Sof=C3=ADa;;;',
  'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Sof=C3=ADa Ort=C3=ADz',
  'TEL;HOME:512-555-0142',
  'TEL;CELL;PREF:512-555-0177',
  'NOTE;ENCODING=QUOTED-PRINTABLE:Prefers texts.=0D=0ASpanish is =',
  'fine.',
  'END:VCARD',
].join('\r\n');

/** vCard 4.0, as Outlook and newer apps write it: tel: links, a quoted type list, a full birthday. */
const OUTLOOK = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'FN:Sam Ortiz',
  'TEL;VALUE=uri;TYPE="voice,cell";PREF=1:tel:+1-512-555-0111',
  'EMAIL:sam@example.com',
  'BDAY:19850412',
  'END:VCARD',
].join('\n');

/** A business saved as a contact: a company and a number, no person's name. */
const BUSINESS = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'ORG:Joe’s Pizza',
  'TEL:512-555-0188',
  'END:VCARD',
].join('\n');

describe('reading a contacts file', () => {
  it('reads an iPhone’s export: names, the preferred email first, a mobile, the address, a note', () => {
    const [dana] = parseVcards(IPHONE);
    expect(dana).toEqual({
      firstName: 'Dana Marie',
      lastName: 'Smith',
      fullName: 'Dana Marie Smith',
      emails: ['dana.smith@mail.example', 'dana@smithroofing.example'],
      phones: ['(512) 555-0199', '(512) 555-0100'],
      company: 'Smith Roofing',
      jobTitle: 'Owner',
      website: 'https://smithroofing.example',
      address: {
        line1: '12 Main St',
        line2: 'Building B, Suite 4',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      },
      birthday: '1604-04-12',
      note: 'Met at the home show, wants a quote',
    });
    // The note leads with what a person has no box for, as a scanned card's does; Apple's no-year 1604 isn't a year.
    expect(vcardNote(dana!)).toBe(
      'Job title: Owner\nWebsite: https://smithroofing.example\nBirthday: Apr 12\nMet at the home show, wants a quote',
    );
  });

  it('reads Google’s, Android’s and vCard 4.0’s ways of writing them, in the file’s order', () => {
    const all = parseVcards([IPHONE, GOOGLE, ANDROID, OUTLOOK, BUSINESS].join('\r\n'));
    expect(all.map(vcardName)).toEqual([
      'Dana Marie Smith',
      'Lee Park',
      'Sofía Ortíz',
      'Sam Ortiz',
      'Joe’s Pizza',
    ]);
    const [, lee, sofia, sam, joes] = all;
    expect(lee!.phones).toEqual(['+1 737-555-0123']);
    // The preferred number first; quoted-printable decoded as UTF-8, its soft break joined.
    expect(sofia!.phones).toEqual(['512-555-0177', '512-555-0142']);
    expect(sofia!.note).toBe('Prefers texts.\r\nSpanish is fine.');
    expect(sam).toMatchObject({ phones: ['+1-512-555-0111'], emails: ['sam@example.com'] });
    expect(vcardBirthday(sam!.birthday!)).toBe('Apr 12, 1985');
    expect(joes).toMatchObject({
      firstName: '',
      lastName: '',
      fullName: '',
      company: 'Joe’s Pizza',
    });
  });

  it('passes over what isn’t a contact, and a card inside a card', () => {
    expect(parseVcards('Name,Phone\nDana,555')).toEqual([]);
    expect(parseVcards('BEGIN:VCARD\nVERSION:3.0\nEND:VCARD')).toEqual([]);
    const nested = [
      'BEGIN:VCARD',
      'FN:Boss',
      'AGENT:BEGIN:VCARD',
      'BEGIN:VCARD',
      'FN:Assistant',
      'END:VCARD',
      'TEL:555-0100',
      'END:VCARD',
    ].join('\n');
    expect(parseVcards(nested).map((c) => [c.fullName, c.phones])).toEqual([
      ['Boss', ['555-0100']],
    ]);
    expect(looksLikeVcard(IPHONE)).toBe(true);
    expect(looksLikeVcard('Name,Phone\nDana,555')).toBe(false);
  });

  it('says birthdays the way people do, and leaves one it can’t read as written', () => {
    expect(vcardBirthday('1985-04-12')).toBe('Apr 12, 1985');
    expect(vcardBirthday('--0412')).toBe('Apr 12');
    expect(vcardBirthday('1990-12-01T00:00:00Z')).toBe('Dec 1, 1990');
    expect(vcardBirthday('sometime in spring')).toBe('sometime in spring');
  });
});

describe('a contacts file as the import’s spreadsheet', () => {
  it('has a column each, extra numbers and emails in their own, and maps the way the import guesses', () => {
    const table = vcardTable(parseVcards([IPHONE, GOOGLE, BUSINESS].join('\n')));
    expect(table.headers).toEqual([
      'First name',
      'Last name',
      'Name',
      'Email',
      'Other email 1',
      'Phone',
      'Other phone 1',
      'Company',
      'Address',
      'Address line 2',
      'City',
      'State',
      'ZIP',
      'Notes',
    ]);
    // What the Assistant's card stages is read back on Confirm by the import's own guess, so the two must agree.
    expect(guessMapping(table.headers, 'people')).toEqual(table.mapping);
    const [dana, lee, joes] = table.rows.map((r) => mapPersonRow(r, table.mapping));
    expect(dana).toMatchObject({
      firstName: 'Dana Marie',
      lastName: 'Smith',
      email: 'dana.smith@mail.example',
      otherEmails: ['dana@smithroofing.example'],
      phone: '(512) 555-0199',
      otherPhones: ['(512) 555-0100'],
      company: 'Smith Roofing',
      address: { line1: '12 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
    });
    expect(dana!.notes).toMatch(/^Job title: Owner\n/);
    expect(lee).toMatchObject({ firstName: 'Lee', lastName: 'Park', otherPhones: [] });
    // A business saved as a contact is named for the business.
    expect(joes).toMatchObject({ firstName: 'Joe’s', lastName: 'Pizza', company: 'Joe’s Pizza' });
  });
});

describe('the import’s guess at a column', () => {
  it('reads numbered extras and hyphens, as lists exported elsewhere write them', () => {
    expect(
      guessMapping(
        ['Full Name', 'E-mail', 'Other email 2', 'Other phone 3', 'Phone 3', 'Zip-code'],
        'people',
      ),
    ).toEqual({
      'Full Name': 'full_name',
      'E-mail': 'email',
      'Other email 2': 'email_alt',
      'Other phone 3': 'phone_alt',
      // A bare number after a field that takes one column stays for the person to say.
      'Phone 3': 'skip',
      'Zip-code': 'postal_code',
    });
  });
});
