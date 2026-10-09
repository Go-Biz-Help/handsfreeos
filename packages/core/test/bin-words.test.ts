/**
 * What deleting for good says (bin-words.ts), on the web and the phone alike: the delete box, its toasts, and the
 * lines in Settings → Deleted bin. Plain words, the counts that matter, and nothing that isn't so.
 */
import { describe, expect, it } from 'vitest';
import {
  binContentsTotal,
  binContentsWords,
  binDeleteBox,
  binDeletedWords,
  binItemDetail,
  binItemWhen,
  binRestoredWords,
} from '../src';

const CHI = 'America/Chicago';

describe('the delete box', () => {
  it('names what goes with a customer, what is cancelled first, what stays, and for how long', () => {
    const box = binDeleteBox('person', ['Dana Lopez'], {
      conversations: 2,
      messages: 14,
      bookings: 1,
      upcoming: 1,
      bills: 3,
    });
    expect(box.title).toBe('Delete Dana Lopez for good?');
    expect(box.lines).toEqual([
      'This also deletes everything only about them: 2 conversations, 14 messages and 1 booking.',
      'Their booking still to come is cancelled first, without telling them. To tell them, cancel it on the calendar first.',
      'Their 3 bills stay, with just their name on them.',
      'They wait 30 days in Settings → Deleted bin, where you can bring them back. Then they’re gone for good.',
    ]);
  });

  it('adds several up', () => {
    const total = binContentsTotal([
      { messages: 3, bills: 1 },
      { messages: 1, upcoming: 2, channel: 'sms' },
    ]);
    expect(total).toEqual({ messages: 4, bills: 1, upcoming: 2 });
    const box = binDeleteBox('person', ['Ann', 'Bo'], total);
    expect(box.title).toBe('Delete 2 customers for good?');
    expect(box.lines).toContain(
      'Their 2 bookings still to come are cancelled first, without telling them. To tell them, cancel them on the calendar first.',
    );
    expect(box.lines).toContain('Their bill stays, with just the name on it.');
  });

  it('says a conversation leaves the customer, and one person’s lanes as theirs', () => {
    expect(binDeleteBox('conversation', ['Lou'], { messages: 1 })).toEqual({
      title: 'Delete the conversation with Lou for good?',
      lines: [
        'This also deletes 1 message.',
        'It doesn’t delete anyone from Contacts.',
        'It waits 30 days in Settings → Deleted bin, where you can bring it back. Then it’s gone for good.',
      ],
    });
    expect(binDeleteBox('conversation', ['Lou', 'Lou'], {}).title).toBe(
      'Delete the 2 conversations with Lou for good?',
    );
    expect(binDeleteBox('conversation', ['Lou', 'Kim', 'Al'], {}).title).toBe(
      'Delete 3 conversations for good?',
    );
  });

  it('says a booking still to come is cancelled first', () => {
    const box = binDeleteBox('appointment', ['AC tune-up'], { notes: 1, upcoming: 1 });
    expect(box.title).toBe('Delete this booking for good?');
    expect(box.lines.slice(0, 2)).toEqual([
      'This also deletes 1 note.',
      'It’s still to come, so it’s cancelled first.',
    ]);
  });

  it('counts only what there is', () => {
    expect(binContentsWords({})).toBeNull();
    expect(binContentsWords({ files: 2, forms: 1, calls: 1 })).toBe(
      '1 call, 2 files and 1 form response',
    );
  });
});

describe('the toasts', () => {
  it('say where it went, and where it came back to', () => {
    expect(binDeletedWords('person', ['Dana Lopez'])).toBe(
      'Dana Lopez deleted. Bring them back from Settings → Deleted bin within 30 days.',
    );
    expect(binDeletedWords('conversation', ['a', 'b'])).toBe(
      '2 conversations deleted. Bring them back from Settings → Deleted bin within 30 days.',
    );
    expect(binRestoredWords({ kind: 'person', name: 'Dana Lopez', joined: 0 })).toBe(
      'Dana Lopez is back in Contacts.',
    );
    expect(binRestoredWords({ kind: 'conversation', name: 'Lou', joined: 1 })).toBe(
      'The conversation with Lou is back in the Inbox. It joined their newer conversation on the same line.',
    );
  });
});

describe('the bin’s lines', () => {
  const item = {
    deletedBy: { name: 'Dale Owner' },
    deletedAt: '2026-10-08T17:00:00Z',
    purgeAfter: '2026-11-07T17:00:00Z',
    emptying: false,
  };
  const now = Date.parse('2026-10-09T12:00:00Z');

  it('says what each thing was', () => {
    expect(
      binItemDetail(
        { ...item, kind: 'conversation', contents: { channel: 'sms', messages: 12 } },
        CHI,
      ),
    ).toBe('Text · 12 messages');
    expect(
      binItemDetail(
        {
          ...item,
          kind: 'appointment',
          contents: { startsAt: '2026-10-12T14:00:00.000Z', who: ['Dana Lopez', null] },
        },
        CHI,
      ),
    ).toBe('Mon, Oct 12 at 9:00 AM · Dana Lopez');
    expect(binItemDetail({ ...item, kind: 'person', contents: {} }, CHI)).toBeNull();
  });

  it('says who deleted it, and when it goes for good', () => {
    expect(binItemWhen({ ...item, kind: 'person', contents: {} }, CHI, now)).toBe(
      'Deleted by Dale Owner on Oct 8 · Gone for good on Nov 7',
    );
    expect(
      binItemWhen(
        { ...item, kind: 'person', contents: {}, deletedBy: null, emptying: true },
        CHI,
        now,
      ),
    ).toBe('Deleted on Oct 8 · Being deleted now');
  });
});
