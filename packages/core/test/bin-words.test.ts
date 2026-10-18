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
  binKindLabel,
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

  it('says when a customer is a partner: their partner record goes with them', () => {
    expect(binDeleteBox('person', ['Gail Admin'], { partners: 1 }).lines[0]).toBe(
      'They’re one of your partners. Their partner record goes too: what they’ve earned, and which clients they sent you.',
    );
    const total = binContentsTotal([{ partners: 1 }, { messages: 2 }, { partners: 1 }]);
    expect(total).toEqual({ partners: 2, messages: 2 });
    expect(binDeleteBox('person', ['Gail', 'Hal', 'Ida'], total).lines).toContain(
      '2 of them are your partners. Their partner records go too: what they’ve earned, and which clients they sent you.',
    );
    expect(binDeleteBox('person', ['Gail', 'Hal'], { partners: 1 }).lines[0]).toMatch(
      /^One of them is your partner\./,
    );
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

  it('says a lead leaves its customer, and a company its people', () => {
    expect(
      binDeleteBox('lead', ['Heat pump'], { tasks: 1, files: 1, who: ['Dana Lopez'] }),
    ).toEqual({
      title: 'Delete this lead for good?',
      lines: [
        'This also deletes 1 task and 1 file.',
        'It doesn’t delete Dana Lopez from Contacts.',
        'It waits 30 days in Settings → Deleted bin, where you can bring it back. Then it’s gone for good.',
      ],
    });
    expect(
      binDeleteBox('company', ['Acme Plumbing'], {
        notes: 2,
        leads: 1,
        relationships: 1,
        people: 3,
      }).lines.slice(0, 2),
    ).toEqual([
      'This also deletes everything only about it: 2 notes, 1 lead and 1 relationship.',
      'The 3 people who work there stay in Contacts.',
    ]);
    expect(binDeleteBox('custom_record', ['Rex'], { tasks: 1, type: 'Pet' })).toEqual({
      title: 'Delete Rex for good?',
      lines: [
        'This also deletes everything only about it: 1 task.',
        'It doesn’t delete anyone from Contacts.',
        'It waits 30 days in Settings → Deleted bin, where you can bring it back. Then it’s gone for good.',
      ],
    });
    // One thing's contents pass through whole, so the box can name a lead's customer.
    expect(binContentsTotal([{ tasks: 1, who: ['Dana Lopez'] }])).toEqual({
      tasks: 1,
      who: ['Dana Lopez'],
    });
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
    expect(binDeletedWords('lead', ['Heat pump'])).toBe(
      'Lead deleted. Bring it back from Settings → Deleted bin within 30 days.',
    );
    expect(binDeletedWords('company', ['Acme Plumbing'])).toBe(
      'Acme Plumbing deleted. Bring it back from Settings → Deleted bin within 30 days.',
    );
    expect(binRestoredWords({ kind: 'lead', name: 'Heat pump', joined: 0 })).toBe(
      'Heat pump is back in the Pipeline.',
    );
    expect(binRestoredWords({ kind: 'custom_record', name: 'Rex', joined: 0 })).toBe(
      'Rex is back in Contacts.',
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
    expect(
      binItemDetail({ ...item, kind: 'lead', contents: { who: ['Dana Lopez'], tasks: 1 } }, CHI),
    ).toBe('Dana Lopez · 1 task');
    expect(
      binItemDetail({ ...item, kind: 'custom_record', contents: { type: 'Pet', notes: 2 } }, CHI),
    ).toBe('2 notes');
  });

  it('calls a record by its own kind', () => {
    expect(binKindLabel({ kind: 'custom_record', contents: { type: 'Pet' } })).toBe('Pet');
    expect(binKindLabel({ kind: 'custom_record', contents: {} })).toBe('Record');
    expect(binKindLabel({ kind: 'company', contents: {} })).toBe('Company');
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
