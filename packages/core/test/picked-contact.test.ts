/**
 * A customer picked from the phone's own contacts (onboarding plan §8, call 8): the card an iPhone hands over and the
 * name and number an Android phone hands over each make a customer `person.create` takes as it is; what the server
 * would refuse is left out rather than refusing the customer; a contact with no name says how to fix it; and someone
 * already a customer, by any of their numbers or emails, is found rather than added twice.
 */
import { describe, expect, it } from 'vitest';
import {
  alreadyACustomer,
  PersonCreateInput,
  personFromContact,
  PICKED_CONTACT_SOURCE,
  PICKED_CONTACT_WORDS,
  type CustomerContactRow,
  type PersonFromContact,
  type PickedContact,
} from '../src';

const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** An iPhone's card for a customer: a home number first, the cell second, two emails and two addresses. */
const ROSA: PickedContact = {
  firstName: ' Rosa ',
  lastName: 'Delgado',
  company: 'Delgado Dental',
  phones: [
    { number: '(512) 555-0100', label: 'home' },
    { number: '512.555.0134', label: 'mobile' },
    { number: '555', label: 'work' },
    { number: '+1 512 555 0134', label: 'iPhone' },
  ],
  emails: [
    { email: 'Rosa@DelgadoDental.com ', label: 'work' },
    { email: 'not an email', label: 'home' },
    { email: 'rosa.d@example.com', label: 'iCloud' },
  ],
  addresses: [
    {
      street: '12 Oak St\nSuite 4',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'us',
      label: 'work',
    },
    { street: '', city: '', postalCode: '', label: 'home' },
    {
      street: '880 Elm Rd',
      city: 'Round Rock',
      state: 'TX',
      postalCode: '78664',
      country: 'United States',
      label: 'home',
    },
  ],
};

function made(contact: PickedContact): { name: string; person: PersonFromContact } {
  const result = personFromContact(contact);
  if (!result.ok) throw new Error(`Expected a customer, got ${result.rule}`);
  return result;
}

describe('a picked contact as a customer', () => {
  it('keeps an iPhone card: names, the cell as the main number, and the rest as other numbers', () => {
    const { name, person } = made(ROSA);
    expect(name).toBe('Rosa Delgado');
    expect(person.firstName).toBe('Rosa');
    expect(person.lastName).toBe('Delgado');
    expect(person.phone).toBe('+15125550134');
    // The cell's twin (+1 512 555 0134) is the same number, so it's kept once; "555" isn't a number at all.
    expect(person.otherPhones).toEqual([{ phone: '+15125550100', label: 'Home' }]);
    expect(person.email).toBe('rosa@delgadodental.com');
    expect(person.otherEmails).toEqual([{ email: 'rosa.d@example.com', label: 'Personal' }]);
    expect(person.address).toEqual({
      line1: '12 Oak St',
      line2: 'Suite 4',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'US',
    });
    expect(person.otherAddresses).toEqual([
      { label: 'Home', line1: '880 Elm Rd', city: 'Round Rock', state: 'TX', postalCode: '78664' },
    ]);
    expect(person.source).toBe(PICKED_CONTACT_SOURCE);
  });

  it('is what person.create takes, as it is', () => {
    const parsed = PersonCreateInput.parse({
      workspaceId: LONE_STAR,
      id: NEW_ID,
      ...made(ROSA).person,
    });
    expect(parsed).toMatchObject({
      firstName: 'Rosa',
      phone: '+15125550134',
      email: 'rosa@delgadodental.com',
      source: 'Phone contacts',
      address: { line1: '12 Oak St', city: 'Austin', country: 'US' },
    });
  });

  it('takes an Android phone’s name and the one number picked, its own reading of the number first', () => {
    const { name, person } = made({
      name: 'Mike  Alvarez Jr',
      phones: [{ number: '512-555-0177', e164: '+15125550177', label: 'Mobile' }],
    });
    expect(name).toBe('Mike Alvarez Jr');
    expect(person).toMatchObject({
      firstName: 'Mike',
      lastName: 'Alvarez Jr',
      phone: '+15125550177',
    });
    expect(person.otherPhones).toEqual([]);
    expect(person.email).toBeNull();
    expect(person.address).toBeUndefined();
    expect(PersonCreateInput.safeParse({ workspaceId: LONE_STAR, ...person }).success).toBe(true);
  });

  it('names a company card after the company, and keeps a label it doesn’t know in its own words', () => {
    const { name, person } = made({
      company: 'Hill Country Roofing',
      phones: [{ number: '512 555 0199', label: 'dispatch desk' }],
    });
    expect(name).toBe('Hill Country Roofing');
    expect(person.phone).toBe('+15125550199');
    expect(
      made({
        name: 'Ann',
        phones: [{ number: '5125550111', label: 'pager' }, { number: '5125550112' }],
      }).person.otherPhones,
    ).toEqual([{ phone: '+15125550112' }]);
    expect(
      made({
        name: 'Ann',
        phones: [{ number: '5125550112' }, { number: '5125550111', label: 'dispatch desk' }],
      }).person.otherPhones,
    ).toEqual([{ phone: '+15125550111', label: 'Dispatch desk' }]);
  });

  it('says how to fix a contact with no name, even one the phone shows by its number', () => {
    for (const contact of [
      {},
      { name: '(512) 555-0134', phones: [{ number: '(512) 555-0134' }] },
    ]) {
      const result = personFromContact(contact);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rule).toBe('no_name');
        expect(result.message).toBe(PICKED_CONTACT_WORDS.noName);
      }
    }
  });
});

describe('a picked contact already a customer', () => {
  const rows: CustomerContactRow[] = [
    {
      id: 'p-1',
      first_name: 'Dale',
      last_name: 'Porter',
      email: 'dale@lonestar.test',
      phone_e164: '+15125550001',
      other_phones: null,
      other_emails: null,
    },
    {
      id: 'p-2',
      first_name: 'Rosa',
      last_name: 'D.',
      email: null,
      phone_e164: null,
      other_phones: '[{"phone":"+15125550134","label":"Mobile"}]',
      other_emails: '[]',
    },
    {
      id: 'p-3',
      first_name: '',
      last_name: '',
      email: 'Billing@Delgado.test',
      phone_e164: null,
      other_phones: null,
      other_emails: [{ email: 'front@delgado.test' }],
    },
  ];

  it('is found by any of their numbers, main or other', () => {
    expect(alreadyACustomer(rows, made(ROSA).person)).toEqual({ id: 'p-2', name: 'Rosa D.' });
  });

  it('is found by any of their emails, whatever the case, named by email when they have no name', () => {
    const { person } = made({ name: 'Front desk', emails: [{ email: 'FRONT@delgado.test' }] });
    expect(alreadyACustomer(rows, person)).toEqual({ id: 'p-3', name: 'Billing@Delgado.test' });
  });

  it('is nobody when nothing matches', () => {
    const { person } = made({ name: 'Sam Lee', phones: [{ number: '5125550999' }] });
    expect(alreadyACustomer(rows, person)).toBeNull();
  });
});
