import { stripText, lineText, needsYouWord } from '@/lib/sync-status';
import type { OutboxRow } from '@/changes/outbox';

import { aboutOf, inputOf, recordChangeOf, stateOf } from '../outbox';

/**
 * The record screens' own logic on the phone: which changes on this phone belong to which record, what a refusal says
 * over it, and the strip's words once a refused change is counted apart from the ones on their way (step 13,
 * finding 2). The words themselves are core's, and tested there.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-09-17T15:12:00.000Z');

let seq = 0;
function row(
  name: string,
  input: Record<string, unknown>,
  extra: Partial<OutboxRow> = {},
): OutboxRow {
  seq += 1;
  return {
    id: `change-${seq}`,
    command_id: `cmd-${seq}`,
    name,
    workspace_id: WS,
    input: JSON.stringify({ workspaceId: WS, ...input }),
    made_at: new Date(T0 + seq * 1000).toISOString(),
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
    seq,
    queued_at: new Date(T0).toISOString(),
    settled_at: new Date(T0).toISOString(),
    sent_at: null,
    ...extra,
  } as OutboxRow;
}

describe('which record a change on this phone is about', () => {
  it('reads every id a CRM command names', () => {
    expect(aboutOf(row('person.update', { personId: PERSON }), { personId: PERSON })).toEqual([
      PERSON,
    ]);
    expect(
      aboutOf(row('activity.log', { id: 'note-1', personId: PERSON }), {
        id: 'note-1',
        personId: PERSON,
      }),
    ).toEqual(['note-1', PERSON]);
    expect(
      aboutOf(row('lead.move_stage', { leadId: LEAD, stageId: 's2' }), { leadId: LEAD }),
    ).toEqual([LEAD]);
  });

  it('counts what waits on a record, and hands back the first refusal with the API’s words', () => {
    const changes = [
      recordChangeOf(row('person.update', { personId: PERSON })),
      recordChangeOf(row('activity.log', { id: 'note-1', personId: PERSON })),
      recordChangeOf(row('lead.move_stage', { leadId: LEAD })),
    ];
    expect(stateOf(changes, PERSON).waiting).toBe(2);
    expect(stateOf(changes, PERSON).refused).toBeNull();
    expect(stateOf(changes, LEAD).waiting).toBe(1);
    expect(stateOf(changes, 'someone-else').waiting).toBe(0);
  });

  it('a refused change never counts as waiting, and says why', () => {
    const refused = recordChangeOf(
      row(
        'person.update',
        { personId: PERSON },
        {
          state: 'refused',
          answer: JSON.stringify({
            error: { code: 'validation', message: 'Enter a valid email address.' },
          }),
        },
      ),
    );
    expect(refused.waiting).toBe(false);
    expect(refused.refused).toBe(true);
    expect(refused.why).toBe('Enter a valid email address.');
    const state = stateOf([refused], PERSON);
    expect(state.waiting).toBe(0);
    expect(state.refused?.why).toBe('Enter a valid email address.');
  });

  it('reads a change’s input, and survives one that isn’t JSON', () => {
    expect(inputOf({ input: '{"personId":"p1"}' }).personId).toBe('p1');
    expect(inputOf({ input: 'not json' })).toEqual({});
  });
});

describe('the strip counts a change that needs the person apart (step 13, finding 2)', () => {
  it('never calls a refusal "waiting to send", because nothing will send it', () => {
    expect(stripText({ connection: 'inStep', waiting: 1, needsYou: 1 })).toBe('1 change needs you');
    expect(stripText({ connection: 'offline', waiting: 1, needsYou: 1 })).toBe(
      'Offline — 1 change needs you',
    );
    expect(stripText({ connection: 'unreachable', waiting: 2, needsYou: 2 })).toBe(
      'Can’t connect — 2 changes need you',
    );
  });

  it('says both when some are on their way and some are not', () => {
    expect(stripText({ connection: 'inStep', waiting: 3, needsYou: 1 })).toBe(
      '2 changes waiting to send, 1 needs you',
    );
    expect(stripText({ connection: 'offline', waiting: 4, needsYou: 2 })).toBe(
      'Offline — 2 changes waiting, 2 need you',
    );
  });

  it('says exactly what it said before when nothing needs the person', () => {
    expect(stripText({ connection: 'offline', waiting: 2, needsYou: 0 })).toBe(
      'Offline — 2 changes waiting',
    );
    expect(stripText({ connection: 'offline', waiting: 0, needsYou: 0 })).toBe('Offline');
    expect(stripText({ connection: 'inStep', waiting: 4, needsYou: 0 })).toBe(
      '4 changes waiting to send',
    );
    expect(stripText({ connection: 'inStep', waiting: 0, needsYou: 0 })).toBeNull();
    expect(stripText({ connection: 'unreachable', waiting: 0, needsYou: 0 })).toBe(
      'Can’t connect to HandsFreeOS',
    );
  });

  it('a status from before this change still reads, with nothing needing the person', () => {
    expect(stripText({ connection: 'offline', waiting: 2 })).toBe('Offline — 2 changes waiting');
  });

  it('the quiet line on Home and More says the same', () => {
    const now = Date.parse('2026-09-17T15:12:00.000Z');
    expect(lineText({ connection: 'inStep', waiting: 1, needsYou: 1, asOf: now }, now)).toBe(
      '1 change needs you',
    );
    expect(lineText({ connection: 'inStep', waiting: 3, needsYou: 1, asOf: now }, now)).toBe(
      '2 changes to send',
    );
    expect(lineText({ connection: 'inStep', waiting: 0, needsYou: 0, asOf: now }, now)).toBe(
      'Up to date',
    );
    expect(lineText({ connection: 'inStep', waiting: 2, needsYou: 2, asOf: now }, now, true)).toBe(
      '2 need you',
    );
  });

  it('words the count itself', () => {
    expect(needsYouWord(1)).toBe('1 change needs you');
    expect(needsYouWord(3)).toBe('3 changes need you');
  });
});
