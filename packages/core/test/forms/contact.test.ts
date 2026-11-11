/**
 * Who a sent form says this is (`contactFromAnswers`). Shop Your Solar's contact form (2026-11-11) asked "First Name"
 * and "Last Name" in short answers that saved to nowhere, so a new customer came through with no name and sending
 * failed. A short answer whose words ask for nothing but a name is that name, the way an email question is their
 * email; the business's own mapping still comes first.
 */
import { describe, expect, it } from 'vitest';
import type { QuestionInput } from '../../src/forms/index';
import { answerProblem } from '../../src/forms/render';
import { allQuestions } from '../../src/forms/definition';
import { ANSWER_TARGETS } from '../../src/forms/questions';
import { contactFromAnswers, patchesFromAnswers } from '../../src/forms/submit';
import { PersonCreateInput, PersonUpdateInput } from '../../src/schemas/person';
import { choice, cid, def, number, page, pickOne, qid, shortText } from './fixtures';

const WS = '00000000-0000-4000-8000-000000000001';
const PERSON = '00000000-0000-4000-8000-000000000002';

const email = (name: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({ id: qid(name), type: 'email', title: name, config: {}, ...extra }) as QuestionInput;
const phone = (name: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({ id: qid(name), type: 'phone', title: name, config: {}, ...extra }) as QuestionInput;
const longText = (name: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({ id: qid(name), type: 'long_text', title: name, config: {}, ...extra }) as QuestionInput;
const address = (name: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({ id: qid(name), type: 'address', title: name, config: {}, ...extra }) as QuestionInput;

describe('who a sent form says this is', () => {
  it('reads "First Name" and "Last Name" boxes that save to nowhere as their name', () => {
    const form = def({
      pages: [
        page('main', [
          shortText('First Name'),
          shortText('Last Name'),
          email('Your email'),
          phone('Your phone'),
          shortText('Please share your energy goals'),
        ]),
      ],
    });
    const contact = contactFromAnswers(form, {
      [qid('First Name')]: ' Rosa ',
      [qid('Last Name')]: 'Herrera',
      [qid('Your email')]: 'rosa@example.com',
      [qid('Please share your energy goals')]: 'Lower bills',
    });
    expect(contact).toMatchObject({
      firstName: 'Rosa',
      lastName: 'Herrera',
      email: 'rosa@example.com',
      phone: null,
    });
  });

  it('splits one "Your name" or "Full name:" box into a first and a last name', () => {
    for (const title of ['Your name', 'Full name:', 'Name']) {
      const form = def({ pages: [page('main', [shortText(title), email('Email')])] });
      const contact = contactFromAnswers(form, {
        [qid(title)]: 'Dale Rivera',
        [qid('Email')]: 'dale@example.com',
      });
      expect([contact.firstName, contact.lastName]).toEqual(['Dale', 'Rivera']);
    }
  });

  it('keeps the business’s own mapping first, and never guesses from other questions', () => {
    const form = def({
      pages: [
        page('main', [
          shortText('Preferred name', { mapTo: 'person.first_name' }),
          shortText('First name'),
          shortText('Company name'),
          shortText('Name of your dog'),
          email('Email'),
        ]),
      ],
    });
    const contact = contactFromAnswers(form, {
      [qid('Preferred name')]: 'Dee',
      [qid('First name')]: 'Deandra',
      [qid('Company name')]: 'Rivera Roofing',
      [qid('Name of your dog')]: 'Biscuit',
      [qid('Email')]: 'dee@example.com',
    });
    expect([contact.firstName, contact.lastName]).toEqual(['Dee', '']);

    const unnamed = def({
      pages: [page('main', [shortText('Company name'), shortText('Name of your dog')])],
    });
    expect(
      contactFromAnswers(unnamed, {
        [qid('Company name')]: 'Rivera Roofing',
        [qid('Name of your dog')]: 'Biscuit',
      }),
    ).toMatchObject({ firstName: '', lastName: '' });
  });
});

/**
 * The other half of the same day's question: is every box a form can save to a customer safe to send? Each
 * answer below is the longest or oddest the page lets through, and what the form would write has to pass the
 * customer's own rules, or sending fails with "Something went wrong on our side".
 */
describe('every answer a form saves fits the customer it goes on', () => {
  const long = (n: number) => 'Abcdefghij'.repeat(Math.ceil(n / 10)).slice(0, n);
  const form = def({
    pages: [
      page('main', [
        shortText('First', { mapTo: 'person.first_name', config: { maxLength: 500 } }),
        shortText('Last', { mapTo: 'person.last_name', config: { maxLength: 500 } }),
        shortText('Mail', { mapTo: 'person.email' }),
        shortText('Cell', { mapTo: 'person.phone' }),
        shortText('Other', { mapTo: 'person.phone_alt' }),
        address('Home', { mapTo: 'person.address' }),
        shortText('Town', { mapTo: 'person.city', config: { maxLength: 500 } }),
        longText('Notes', { mapTo: 'person.notes', config: { maxLength: 5000 } }),
        pickOne('Heard', [choice('Google'), choice('A friend')], { mapTo: 'person.source' }),
        pickOne('Need', [choice('New roof'), choice('Repair')], { mapTo: 'lead.title' }),
        number('Budget', { mapTo: 'lead.value', config: { min: -1000 } }),
      ]),
    ],
  });
  const answers = {
    [qid('First')]: long(500),
    [qid('Last')]: long(500),
    [qid('Mail')]: 'Rosa.Herrera@Example.com',
    [qid('Cell')]: '(214) 555-0143',
    [qid('Other')]: 'not a number',
    [qid('Home')]: {
      line1: long(200),
      line2: '',
      city: long(120),
      state: long(60),
      postalCode: '75201',
    },
    [qid('Town')]: long(500),
    [qid('Notes')]: long(5000),
    [qid('Heard')]: cid('Google'),
    [qid('Need')]: cid('New roof'),
    [qid('Budget')]: -500,
  };

  it('covers every field a form can fill in', () => {
    const mapped = new Set(allQuestions(form).map((q) => q.mapTo));
    for (const target of Object.keys(ANSWER_TARGETS)) expect(mapped).toContain(target);
  });

  it('makes a new customer the record takes', () => {
    const contact = contactFromAnswers(form, answers);
    const made = PersonCreateInput.safeParse({
      workspaceId: WS,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      address: contact.address ?? undefined,
    });
    expect(made.error?.issues ?? []).toEqual([]);
    expect(contact.firstName).toHaveLength(80);
    expect(contact.address?.city).toHaveLength(100);
  });

  it('fills in a customer the record takes, with words not ids', () => {
    const { person, lead } = patchesFromAnswers(form, answers);
    const filled = PersonUpdateInput.safeParse({
      workspaceId: WS,
      personId: PERSON,
      ...person.fields,
      // A stray second number is left out by the caller (it only joins when it reads as one).
      phoneAlt: undefined,
    });
    expect(filled.error?.issues ?? []).toEqual([]);
    expect(person.fields).toMatchObject({ source: 'Google', email: 'Rosa.Herrera@Example.com' });
    expect(lead.fields).toMatchObject({ title: 'New roof', value: -500 });
  });

  it('keeps a town on its own in their address', () => {
    const townOnly = def({
      pages: [page('main', [shortText('Town', { mapTo: 'person.city' }), email('Email')])],
    });
    const sent = { [qid('Town')]: 'Plano', [qid('Email')]: 'pat@example.com' };
    expect(contactFromAnswers(townOnly, sent).address).toMatchObject({ city: 'Plano', line1: '' });
    expect(patchesFromAnswers(townOnly, sent).person.fields.address).toMatchObject({
      city: 'Plano',
    });
  });

  it('asks again on the page for an email or phone the record would refuse', () => {
    const [emailBox, mailBox, cellBox, anyBox] = allQuestions(
      def({
        pages: [
          page('main', [
            email('Email'),
            shortText('Mail', { mapTo: 'person.email' }),
            shortText('Cell', { mapTo: 'person.phone' }),
            shortText('Anything'),
          ]),
        ],
      }),
    );
    // Passed the page's old test, and failed when it was saved.
    expect(answerProblem(emailBox!, 'josé@example.com')).toBe('Enter an email address.');
    expect(answerProblem(emailBox!, 'rosa,h@example.com')).toBe('Enter an email address.');
    expect(answerProblem(emailBox!, 'rosa@example.com')).toBeNull();
    expect(answerProblem(mailBox!, 'rosa at gmail')).toBe('Enter an email address.');
    expect(answerProblem(cellBox!, 'call me after 5')).toBe('Enter a phone number.');
    expect(answerProblem(cellBox!, '214-555-0143')).toBeNull();
    // A short answer that saves nowhere takes whatever they write.
    expect(answerProblem(anyBox!, 'call me after 5')).toBeNull();
  });
});
