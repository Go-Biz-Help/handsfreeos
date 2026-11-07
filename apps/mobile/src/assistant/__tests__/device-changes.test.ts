import { AssistantDeviceChanges } from '@hfos/core';

import type { ChangeItem, ChangeList } from '@/changes/list';
import type { OutboxRow } from '@/changes/outbox';

import { deviceChangesOf } from '../device-changes';

/**
 * Changes on this phone never reached HandsFreeOS, so a question asked on the phone carries what that screen shows:
 * how many wait, each one that needs the person and why, and what went just now. Never what was written.
 */

const row = (over: Partial<OutboxRow>): OutboxRow =>
  ({
    id: 'c1',
    command_id: 'c1',
    name: 'message.send',
    workspace_id: 'ws',
    input: '{"body":"Running late, be there at 9"}',
    made_at: '2026-11-07T14:00:00.000Z',
    depends_on: '[]',
    track: 'queue',
    state: 'waiting',
    reason: null,
    disposition: null,
    rule: null,
    answer: null,
    attempts: 0,
    revision: 0,
    confirmed_at: null,
    seq: 1,
    queued_at: '2026-11-07T14:00:00.000Z',
    settled_at: '2026-11-07T14:00:00.000Z',
    sent_at: null,
    ...over,
  }) as OutboxRow;

const item = (
  title: string,
  over: Partial<OutboxRow>,
  ask: ChangeItem['ask'] = null,
): ChangeItem => ({
  row: row(over),
  photo: null,
  words: {
    title,
    part: 'a text',
    quote: 'Running late, be there at 9',
    icon: 'text',
    about: null,
    heldUntil: '',
  },
  ask,
  held: null,
});

describe('what the phone tells the Assistant about its changes', () => {
  it('says how many wait, what needs the person and why, and what went, without what was written', () => {
    const list: ChangeList = {
      needsYou: [
        item('Text to Dana Reyes', { state: 'refused', reason: 'Dana texted STOP.' }),
        item('Text to Mike Johnson', { state: 'ask', rule: 'quiet_hours' }, 'quiet-hours'),
      ],
      waiting: [item('Note for Rosa Diaz', {})],
      sent: [
        {
          key: 'p1',
          workspaceId: 'ws',
          title: '2 changes for Maria Lopez',
          line: 'A note · moved to Won',
          count: 2,
          lastSentAt: 1,
        },
      ],
      unsent: 3,
    };
    const said = deviceChangesOf(list, 'ws');
    expect(said).toEqual({
      waiting: 1,
      needsYou: [
        { title: 'Text to Dana Reyes', why: 'Refused: Dana texted STOP.' },
        {
          title: 'Text to Mike Johnson',
          why: 'Quiet hours: it asks whether to send it now or once they end.',
        },
      ],
      moreNeedYou: 0,
      sentJustNow: ['2 changes for Maria Lopez · A note · moved to Won'],
    });
    expect(JSON.stringify(said)).not.toContain('Running late');
    // It's what the worker takes.
    expect(AssistantDeviceChanges.parse(said)).toEqual(said);
  });

  it('lists ten that need the person and counts the rest, and cuts long words to fit', () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      item(`Text ${n} ${'x'.repeat(400)}`, { state: 'refused', reason: null }),
    );
    const said = deviceChangesOf({ needsYou: many, waiting: [], sent: [], unsent: 12 }, 'ws');
    expect(said.needsYou).toHaveLength(10);
    expect(said.moreNeedYou).toBe(2);
    expect(said.needsYou[0]!.why).toBe('Refused: HandsFreeOS couldn’t do this.');
    expect(said.needsYou[0]!.title.endsWith('…')).toBe(true);
    expect(() => AssistantDeviceChanges.parse(said)).not.toThrow();
  });

  it('keeps to the business the question is asked in, never another one the phone also holds', () => {
    const list: ChangeList = {
      needsYou: [
        item('Text to Dana Reyes', { state: 'refused', reason: 'Dana texted STOP.' }),
        item('Text to Sam Ortiz', {
          workspace_id: 'other',
          state: 'refused',
          reason: 'Sam texted STOP.',
        }),
      ],
      waiting: [
        item('Note for Rosa Diaz', {}),
        item('Note for Lee Park', { workspace_id: 'other' }),
      ],
      sent: [
        {
          key: 'p1',
          workspaceId: 'ws',
          title: 'A note for Maria Lopez',
          line: '',
          count: 1,
          lastSentAt: 2,
        },
        {
          key: 'p2',
          workspaceId: 'other',
          title: 'A note for Ann Fox',
          line: '',
          count: 1,
          lastSentAt: 1,
        },
      ],
      unsent: 4,
    };
    const said = deviceChangesOf(list, 'ws');
    expect(said).toEqual({
      waiting: 1,
      needsYou: [{ title: 'Text to Dana Reyes', why: 'Refused: Dana texted STOP.' }],
      moreNeedYou: 0,
      sentJustNow: ['A note for Maria Lopez'],
    });
    expect(JSON.stringify(said)).not.toMatch(/Sam Ortiz|Lee Park|Ann Fox/);
  });
});
