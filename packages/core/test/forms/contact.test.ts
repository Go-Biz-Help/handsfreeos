/**
 * Who a sent form says this is (`contactFromAnswers`). Shop Your Solar's contact form (2026-11-11) asked "First Name"
 * and "Last Name" in short answers that saved to nowhere, so a new customer came through with no name and sending
 * failed. A short answer whose words ask for nothing but a name is that name, the way an email question is their
 * email; the business's own mapping still comes first.
 */
import { describe, expect, it } from 'vitest';
import type { QuestionInput } from '../../src/forms/index';
import { contactFromAnswers } from '../../src/forms/submit';
import { def, page, qid, shortText } from './fixtures';

const email = (name: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({ id: qid(name), type: 'email', title: name, config: {}, ...extra }) as QuestionInput;
const phone = (name: string, extra: Partial<QuestionInput> = {}): QuestionInput =>
  ({ id: qid(name), type: 'phone', title: name, config: {}, ...extra }) as QuestionInput;

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
