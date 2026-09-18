/**
 * The customer's notes inside their conversation (M10 step 15). The phone put them in the thread in step 14 and Chris
 * decided on 2026-09-17 to keep them there and let the web catch up, so the merge and the line above a note live in
 * core and both apps read them.
 */
import { describe, expect, it } from 'vitest';
import { noteHeading, noteLine, threadWithNotes, type NoteEntry } from '../src/index';

const note = (id: string, at: string, author: string | null = 'Dale'): NoteEntry => ({
  id,
  body: `note ${id}`,
  occurredAt: at,
  author,
  waiting: false,
});

const item = (id: string, at: string) => ({ id, occurredAt: at });

describe('a thread with its customer’s notes', () => {
  it('folds notes in by time, oldest first', () => {
    const pieces = threadWithNotes(
      [item('m1', '2026-09-17T13:00:00.000Z'), item('m2', '2026-09-17T15:00:00.000Z')],
      [note('n1', '2026-09-17T14:00:00.000Z')],
    );
    expect(pieces.map((p) => [p.kind, p.id])).toEqual([
      ['item', 'm1'],
      ['note', 'n1'],
      ['item', 'm2'],
    ]);
  });

  it('breaks a tie by id, so two things at the same moment never swap between renders', () => {
    const once = threadWithNotes(
      [item('b', '2026-09-17T13:00:00.000Z')],
      [note('a', '2026-09-17T13:00:00.000Z')],
    );
    const again = threadWithNotes(
      [item('b', '2026-09-17T13:00:00.000Z')],
      [note('a', '2026-09-17T13:00:00.000Z')],
    );
    expect(once.map((p) => p.id)).toEqual(['a', 'b']);
    expect(again.map((p) => p.id)).toEqual(once.map((p) => p.id));
  });

  it('leaves a thread alone when the customer has no notes', () => {
    const pieces = threadWithNotes([item('m1', '2026-09-17T13:00:00.000Z')], []);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.kind).toBe('item');
  });

  it('words the line over a note, with or without whoever wrote it', () => {
    expect(noteLine(note('n1', '2026-09-17T14:24:00.000Z'), '9:24 AM')).toBe(
      'Note · Dale · 9:24 AM',
    );
    expect(noteLine(note('n1', '2026-09-17T14:24:00.000Z', null), '9:24 AM')).toBe(
      'Note · 9:24 AM',
    );
    expect(noteHeading({ author: 'Dale' })).toBe('Dale added a note');
    expect(noteHeading({ author: null })).toBe('A note');
  });
});
