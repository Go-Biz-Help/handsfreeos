/**
 * Changing the customer from inside their conversation (M10 step 15, continued): the panel edits their name as the
 * one line it shows, so the splitting has to land the same way `fullName` joined it.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTACT_EDIT_WORDS,
  joinName,
  nameFromSender,
  nameProblem,
  notCustomerBanner,
  noteProblem,
  SENDER_WORDS,
  splitName,
} from '../src/index';

describe('a name edited as one line', () => {
  it('splits on the first space: everything after it is the last name', () => {
    expect(splitName('Mike Alvarez')).toEqual({ firstName: 'Mike', lastName: 'Alvarez' });
    expect(splitName('Mary Jane Smith')).toEqual({ firstName: 'Mary', lastName: 'Jane Smith' });
  });

  it('takes one word as a first name, which person.create accepts', () => {
    expect(splitName('Mike')).toEqual({ firstName: 'Mike', lastName: '' });
  });

  it('tidies the spacing somebody types', () => {
    expect(splitName('  Mike   Alvarez  ')).toEqual({ firstName: 'Mike', lastName: 'Alvarez' });
  });

  it('has nothing to split when the field was cleared', () => {
    expect(splitName('   ')).toEqual({ firstName: '', lastName: '' });
  });

  /**
   * The round trip is what the merge base depends on: `conversation.get` carries both halves precisely because
   * splitting a joined name back guesses wrong, and this is the guess it would have made.
   */
  it('joins back to what the panel showed', () => {
    for (const name of ['Mike Alvarez', 'Mike', 'Mary Jane Smith'])
      expect(joinName(splitName(name))).toBe(name);
  });

  it('does not recover a two-word first name, which is why both halves travel', () => {
    expect(splitName(joinName({ firstName: 'Mary Jane', lastName: 'Smith' }))).toEqual({
      firstName: 'Mary',
      lastName: 'Jane Smith',
    });
  });
});

describe('what cannot be saved', () => {
  it('refuses a name with nothing in it, before the command is sent', () => {
    expect(nameProblem('')).toBe(CONTACT_EDIT_WORDS.nameEmpty);
    expect(nameProblem('   ')).toBe(CONTACT_EDIT_WORDS.nameEmpty);
  });

  it('accepts one word', () => {
    expect(nameProblem('Mike')).toBeNull();
  });

  it('refuses an empty note and accepts one with anything in it', () => {
    expect(noteProblem('  ')).toBe(CONTACT_EDIT_WORDS.noteEmpty);
    expect(noteProblem('Gate code 4821')).toBeNull();
  });
});

describe('adding whoever emailed (2026-10-29)', () => {
  it('starts with the name their From line gave', () => {
    expect(nameFromSender('Gregory Lyons')).toBe('Gregory Lyons');
    expect(nameFromSender('"Gregory  Lyons" ')).toBe('Gregory Lyons');
    expect(nameFromSender('“José Peña”')).toBe('José Peña');
  });

  it('starts empty when the "name" is the address again, or none at all', () => {
    expect(nameFromSender('grlyons1010@gmail.com')).toBeNull();
    expect(nameFromSender('"grlyons1010@gmail.com"')).toBeNull();
    expect(nameFromSender('  ')).toBeNull();
    expect(nameFromSender('1010')).toBeNull();
    expect(nameFromSender(null)).toBeNull();
  });

  it('names the address, not a number, for email', () => {
    expect(notCustomerBanner('grlyons1010@gmail.com', 'email').parts).toEqual([
      { strong: 'grlyons1010@gmail.com isn’t a customer yet.' },
      ' Add them, or link the address to someone you already have.',
    ]);
  });

  it('names who already has the address, so linking them is one tap', () => {
    expect(SENDER_WORDS.known('Gregory Lyons')).toBe(
      'Gregory Lyons already has this email address.',
    );
    expect(SENDER_WORDS.linkTo('Gregory Lyons')).toBe('Link to Gregory Lyons');
    expect(SENDER_WORDS.linked('Gregory Lyons')).toBe('Linked to Gregory Lyons.');
  });
});
