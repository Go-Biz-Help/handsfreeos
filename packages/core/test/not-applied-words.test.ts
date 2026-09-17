/** How a "not applied" timeline entry reads after who made it, the same on the web and the phone (M10: newest wins). */
import { describe, expect, it } from 'vitest';
import { notAppliedWords } from '../src/index';

describe('a change of state a later change overtook', () => {
  it('says what the person tried, and why it stays as it is', () => {
    expect(
      notAppliedWords({
        tried: 'close the conversation',
        because: 'Maria wrote again after that',
        field: 'status',
      }),
    ).toBe('tried to close the conversation, but Maria wrote again after that');
    expect(
      notAppliedWords({
        tried: 'move AC replacement to Won',
        because: 'Sam Admin moved it to Quoted after that',
      }),
    ).toBe('tried to move AC replacement to Won, but Sam Admin moved it to Quoted after that');
  });

  it('needs both halves; with one missing it reads as an edit to a detail', () => {
    expect(notAppliedWords({ tried: 'close the conversation' })).toBe(
      'tried to change a detail, but a later change was kept',
    );
    expect(notAppliedWords({ because: 'Maria wrote again after that', label: 'stage' })).toBe(
      'tried to change the stage, but a later change was kept',
    );
  });
});

describe('an edit to a detail a later edit beat', () => {
  it('shows both values and whose change stayed, when it can', () => {
    expect(
      notAppliedWords({
        label: 'phone number',
        wanted: '(713) 555-0199',
        stays: '(713) 555-0142',
        keptBy: 'Sam Admin',
      }),
    ).toBe(
      'tried to change the phone number to “(713) 555-0199”, but Sam Admin’s later change to “(713) 555-0142” was kept',
    );
    expect(
      notAppliedWords({ label: 'email', wanted: 'a@example.com', stays: 'b@example.com' }),
    ).toBe(
      'tried to change the email to “a@example.com”, but a later change to “b@example.com” was kept',
    );
  });

  it('says cleared for an empty value, and leaves values out when a detail has no words', () => {
    expect(notAppliedWords({ label: 'notes', wanted: '', stays: 'Gate code 4411' })).toBe(
      'tried to clear the notes, but a later change to “Gate code 4411” was kept',
    );
    expect(notAppliedWords({ label: 'notes', wanted: 'Call first', stays: '' })).toBe(
      'tried to change the notes to “Call first”, but a later change, which cleared it, was kept',
    );
    expect(notAppliedWords({ label: 'company', wanted: null, stays: null, keptBy: 'Sam' })).toBe(
      'tried to change the company, but Sam’s later change was kept',
    );
    expect(notAppliedWords({})).toBe('tried to change a detail, but a later change was kept');
  });
});
