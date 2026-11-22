import { describe, expect, it } from 'vitest';
import type { ContactAiDecision } from '../src/contact-ai/rules';
import {
  CONTACT_AI_PREVIOUS_LABEL,
  detailReason,
  foundInWords,
  planChanges,
  planContactChanges,
  type ContactAiSnapshot,
} from '../src/contact-ai/rules';

const TAGS = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'VIP' },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Solar interest' },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Commercial' },
];
const [VIP, SOLAR, COMMERCIAL] = TAGS;

const mike = (over: Partial<ContactAiSnapshot> = {}): ContactAiSnapshot => ({
  firstName: 'Mike',
  lastName: 'Johnson',
  email: 'mike@old.test',
  phoneE164: '+15125550101',
  otherEmails: [],
  otherPhones: [],
  address: { line1: '1 Oak St', line2: null, city: 'Austin', state: 'TX', postalCode: '78701' },
  tags: [],
  ...over,
});

const decision = (over: Partial<ContactAiDecision>): ContactAiDecision => ({
  addTags: [],
  removeTags: [],
  details: [],
  ...over,
});

const said =
  'Hi, my new email is Mike.J@new.test and my cell is (512) 555-0199. We moved to 9 Elm Rd.';

describe('the AI’s tags', () => {
  it('puts on only the business’s own tags, matched by name, and never one already on', () => {
    const plan = planContactChanges(
      decision({
        addTags: [
          { tag: 'vip', reason: 'Spent $9,000' },
          { tag: 'Solar interest', reason: 'Asked about panels' },
          { tag: 'Made up', reason: 'Seemed nice' },
        ],
      }),
      mike({ tags: [{ id: SOLAR!.id, name: SOLAR!.name, byPerson: false }] }),
      { tags: TAGS, details: false, trustedText: '' },
    );
    expect(plan.addTags).toEqual([{ id: VIP!.id, name: 'VIP', reason: 'Spent $9,000' }]);
    expect(plan.skipped).toEqual([
      { what: 'the tag “Made up”', why: 'it isn’t one of the tags it may use' },
    ]);
  });

  it('takes off only tags HandsFreeOS put on; a person’s stay', () => {
    const plan = planContactChanges(
      decision({
        removeTags: [
          { tag: 'VIP', reason: 'No longer spending' },
          { tag: 'Commercial', reason: 'Closed their shop' },
        ],
      }),
      mike({
        tags: [
          { id: VIP!.id, name: 'VIP', byPerson: true },
          { id: COMMERCIAL!.id, name: 'Commercial', byPerson: false },
        ],
      }),
      { tags: TAGS, details: false, trustedText: '' },
    );
    expect(plan.removeTags).toEqual([
      { id: COMMERCIAL!.id, name: 'Commercial', reason: 'Closed their shop' },
    ]);
    expect(plan.skipped).toEqual([
      { what: 'taking off “VIP”', why: 'someone on the team put it on' },
    ]);
  });

  it('does neither when it says a tag both on and off', () => {
    const plan = planContactChanges(
      decision({
        addTags: [{ tag: 'VIP', reason: 'a' }],
        removeTags: [{ tag: 'vip', reason: 'b' }],
      }),
      mike(),
      { tags: TAGS, details: false, trustedText: '' },
    );
    expect(planChanges(plan)).toBe(false);
    expect(plan.skipped[0]!.why).toBe('it said both on and off');
  });

  it('uses only the tags a pass was given', () => {
    const plan = planContactChanges(decision({ addTags: [{ tag: 'VIP', reason: 'a' }] }), mike(), {
      tags: [SOLAR!],
      details: false,
      trustedText: '',
    });
    expect(plan.addTags).toEqual([]);
  });
});

describe('the AI’s contact details', () => {
  const opts = { tags: TAGS, details: true, trustedText: said };

  it('writes what the customer said, keeping the old email and number as Previous', () => {
    const plan = planContactChanges(
      decision({
        details: [
          { field: 'email', action: 'set', value: 'mike.j@new.test', reason: 'Gave a new email' },
          { field: 'phone', action: 'set', value: '512-555-0199', reason: 'Gave a new cell' },
          { field: 'addressLine1', action: 'set', value: '9 Elm Rd', reason: 'Moved' },
        ],
      }),
      mike(),
      opts,
    );
    expect(plan.personPatch).toEqual({
      email: 'mike.j@new.test',
      phone: '+15125550199',
      address: { line1: '9 Elm Rd' },
      otherEmails: [{ email: 'mike@old.test', label: CONTACT_AI_PREVIOUS_LABEL }],
      otherPhones: [{ phone: '+15125550101', label: CONTACT_AI_PREVIOUS_LABEL }],
    });
    expect(plan.details.map((d) => [d.field, d.from, d.to])).toEqual([
      ['email', 'mike@old.test', 'mike.j@new.test'],
      ['phone', '+15125550101', '+15125550199'],
      ['addressLine1', '1 Oak St', '9 Elm Rd'],
    ]);
    expect(detailReason(plan.details)).toBe(
      'email: Gave a new email; phone number: Gave a new cell; street address: Moved',
    );
  });

  it('never writes a value nobody wrote or said', () => {
    const plan = planContactChanges(
      decision({
        details: [
          { field: 'email', action: 'set', value: 'guess@new.test', reason: 'Probably' },
          { field: 'phone', action: 'set', value: '512-555-0000', reason: 'Probably' },
        ],
      }),
      mike(),
      opts,
    );
    expect(plan.personPatch).toBeNull();
    expect(plan.skipped.map((s) => s.why)).toEqual([
      'it isn’t in anything the customer or the team wrote or said',
      'it isn’t in anything the customer or the team wrote or said',
    ]);
  });

  it('changes no details with only a chat, public form or notes on file to go on, or with the switch off', () => {
    const change = decision({
      details: [{ field: 'email', action: 'set', value: 'mike.j@new.test', reason: 'x' }],
    });
    expect(planContactChanges(change, mike(), { ...opts, trustedText: '' }).skipped[0]!.why).toBe(
      'there’s nothing the customer or the team is known to have written to go on',
    );
    expect(planContactChanges(change, mike(), { ...opts, details: false }).skipped[0]!.why).toBe(
      'keeping contact details up to date is switched off',
    );
  });

  // AI3: this used to take the number and the city off with nothing the customer wrote about them, so a chat
  // visitor's say-so could wipe a customer's details. A detail taken off must now be in what they wrote or said.
  it('adds other emails and numbers, takes one off only when they said so, and never takes a name away', () => {
    const plan = planContactChanges(
      decision({
        details: [
          { field: 'otherEmail', action: 'set', value: 'mike.j@new.test', reason: 'Work email' },
          { field: 'otherPhone', action: 'remove', value: '+15125550111', reason: 'Not theirs' },
          { field: 'lastName', action: 'remove', value: null, reason: 'x' },
          { field: 'city', action: 'remove', value: null, reason: 'Wrong city' },
        ],
      }),
      mike({ otherPhones: [{ phone: '+15125550111', label: 'Work' }] }),
      {
        ...opts,
        trustedText: `${said}\nPlease stop calling 512-555-0111, that line is gone. And we were never in Austin.`,
      },
    );
    expect(plan.personPatch).toEqual({
      otherEmails: [{ email: 'mike.j@new.test' }],
      otherPhones: [],
      address: { city: null },
    });
    expect(plan.skipped).toEqual([
      { what: 'the last name', why: 'a customer always keeps their name' },
    ]);
  });

  it('takes off nothing that isn’t in what the customer or the team wrote or said (AI3)', () => {
    // Somebody in an unverified chat asked for these to go: none of it is in the trusted text.
    const plan = planContactChanges(
      decision({
        details: [
          { field: 'otherPhone', action: 'remove', value: '+15125550111', reason: 'Not theirs' },
          { field: 'otherEmail', action: 'remove', value: 'mike@work.test', reason: 'Old job' },
          { field: 'city', action: 'remove', value: null, reason: 'Wrong city' },
        ],
      }),
      mike({
        otherPhones: [{ phone: '+15125550111', label: 'Work' }],
        otherEmails: [{ email: 'mike@work.test' }],
      }),
      opts,
    );
    expect(plan.personPatch).toBeNull();
    expect(plan.skipped.map((s) => s.why)).toEqual([
      'it isn’t in anything the customer or the team wrote or said',
      'it isn’t in anything the customer or the team wrote or said',
      'it isn’t in anything the customer or the team wrote or said',
    ]);
  });

  it('never takes off a main email or number, even when they said so: only a new one replaces it', () => {
    const plan = planContactChanges(
      decision({
        details: [
          { field: 'email', action: 'remove', value: null, reason: 'Not theirs anymore' },
          { field: 'phone', action: 'remove', value: null, reason: 'Not theirs anymore' },
        ],
      }),
      mike(),
      { ...opts, trustedText: 'mike@old.test and (512) 555-0101 aren’t mine anymore' },
    );
    expect(plan.personPatch).toBeNull();
    expect(plan.skipped).toEqual([
      {
        what: 'the email',
        why: 'it never takes off a main email or number, only replaces it with a new one',
      },
      {
        what: 'the phone number',
        why: 'it never takes off a main email or number, only replaces it with a new one',
      },
    ]);
  });

  it('keeps the number it replaces as Previous, beside the other numbers already on file', () => {
    const plan = planContactChanges(
      decision({
        details: [{ field: 'phone', action: 'set', value: '(512) 555-0199', reason: 'New cell' }],
      }),
      mike({ otherPhones: [{ phone: '+15125550111', label: 'Work' }] }),
      opts,
    );
    expect(plan.personPatch).toEqual({
      phone: '+15125550199',
      otherPhones: [
        { phone: '+15125550111', label: 'Work' },
        { phone: '+15125550101', label: CONTACT_AI_PREVIOUS_LABEL },
      ],
    });
  });

  it('finds a number however it was typed, and words whatever their case', () => {
    expect(foundInWords('phone', '+1 512 555 0199', said)).toBe(true);
    expect(foundInWords('otherPhone', '5125550100', said)).toBe(false);
    expect(foundInWords('addressLine1', '9 ELM RD', said)).toBe(true);
    expect(foundInWords('email', 'x@y.test', '')).toBe(false);
  });
});
