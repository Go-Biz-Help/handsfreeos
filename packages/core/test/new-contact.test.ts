/**
 * A new contact started from a customer search that found nobody (New appointment, web and phone): what was typed
 * starts the form in the right box, and the phone's form is checked the way `person.create` checks it, so what the
 * phone adds with no signal is never refused later for a mistyped number.
 */
import { describe, expect, it } from 'vitest';
import { checkNewContact, contactFromSearch, NEW_CONTACT_WORDS, PersonCreateInput } from '../src';

const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('what was typed starts the new contact', () => {
  it('as the name, tidied', () => {
    expect(contactFromSearch('  Dana   Smith ')).toEqual({
      name: 'Dana Smith',
      phone: '',
      email: '',
    });
    expect(contactFromSearch('Zoë O’Brien')).toEqual({ name: 'Zoë O’Brien', phone: '', email: '' });
  });

  it('as the number, finished or not, however it was written', () => {
    expect(contactFromSearch('(713) 555-0142')).toEqual({
      name: '',
      phone: '(713) 555-0142',
      email: '',
    });
    expect(contactFromSearch('+1 713 555')).toEqual({ name: '', phone: '+1 713 555', email: '' });
  });

  it('as the email, finished or not', () => {
    expect(contactFromSearch('dana@smithroofing.com')).toEqual({
      name: '',
      phone: '',
      email: 'dana@smithroofing.com',
    });
    expect(contactFromSearch('dana@')).toEqual({ name: '', phone: '', email: 'dana@' });
  });

  it('as nothing for a street or anything else with a digit in it', () => {
    for (const typed of ['12 Oak St', 'Unit 4', '42', '…']) {
      expect(contactFromSearch(typed)).toEqual({ name: '', phone: '', email: '' });
    }
  });
});

describe('the phone’s New contact form', () => {
  it('takes a name alone, split as person.create takes it', () => {
    const check = checkNewContact({ name: ' Dana  Smith ', phone: '', email: '' });
    expect(check).toEqual({
      ok: true,
      name: 'Dana Smith',
      person: { firstName: 'Dana', lastName: 'Smith', phone: null, email: null },
    });
    // What the phone sends is what the server accepts, unchanged.
    if (!check.ok) throw new Error('refused');
    const input = PersonCreateInput.parse({ workspaceId: LONE_STAR, ...check.person });
    expect(input).toMatchObject({ firstName: 'Dana', lastName: 'Smith', phone: null, email: null });
  });

  it('keeps the number in E.164 and the email lower-cased, as the server keeps them', () => {
    const check = checkNewContact({
      name: 'Dana',
      phone: '(713) 555-0142',
      email: ' Dana@SmithRoofing.com ',
    });
    expect(check).toEqual({
      ok: true,
      name: 'Dana',
      person: {
        firstName: 'Dana',
        lastName: '',
        phone: '+17135550142',
        email: 'dana@smithroofing.com',
      },
    });
    if (!check.ok) throw new Error('refused');
    expect(PersonCreateInput.parse({ workspaceId: LONE_STAR, ...check.person })).toMatchObject({
      phone: '+17135550142',
      email: 'dana@smithroofing.com',
    });
  });

  it('asks for a name, then a real number, then a real email, by rule', () => {
    expect(checkNewContact({ name: '  ', phone: '7135550142', email: '' })).toMatchObject({
      ok: false,
      rule: 'no_name',
      field: 'name',
      message: 'Enter a name.',
    });
    expect(checkNewContact({ name: 'Dana', phone: '555-01', email: '' })).toMatchObject({
      ok: false,
      rule: 'bad_phone',
      field: 'phone',
    });
    expect(checkNewContact({ name: 'Dana', phone: '', email: 'dana@' })).toMatchObject({
      ok: false,
      rule: 'bad_email',
      field: 'email',
    });
  });
});

describe('the words', () => {
  it('say what was typed, and what an existing contact already has', () => {
    expect(NEW_CONTACT_WORDS.nobody('Dana Smith')).toBe('No one matches “Dana Smith”.');
    expect(NEW_CONTACT_WORDS.add('Dana Smith')).toBe('Add “Dana Smith” as a new contact');
    expect(NEW_CONTACT_WORDS.already('Mike Johnson', { phone: true, email: false })).toBe(
      'Mike Johnson already has this number.',
    );
    expect(NEW_CONTACT_WORDS.already('Mike Johnson', { phone: false, email: true })).toBe(
      'Mike Johnson already has this email.',
    );
    expect(NEW_CONTACT_WORDS.already('Mike Johnson', { phone: true, email: true })).toBe(
      'Mike Johnson already has this number or email.',
    );
  });
});
