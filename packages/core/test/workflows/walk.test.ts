import { describe, expect, it } from 'vitest';
import {
  canMove,
  findStep,
  insertionPoints,
  nextStep,
  pathTo,
  variablesAt,
  type StepInput,
} from '../../src/workflows/index';
import { bid, def, end, goto, ifElse, SALES, sid, STAGE_NEW, text, waitDays } from './fixtures';

// main:  text1, wait1, outer[yes: text2, inner[yes: text3, goto1→wait1 | no: (empty)] | no: wait2], appr1[rejected: task1], text4
const tree = () =>
  def({
    trigger: { kind: 'event', event: 'lead.created' },
    steps: [
      text(sid('text1')),
      waitDays(sid('wait1')),
      ifElse(
        sid('outer1'),
        [
          text(sid('text2')),
          ifElse(sid('inner1'), [text(sid('text3')), goto(sid('goto1'), sid('wait1'), 2)], []),
        ],
        [waitDays(sid('wait2'))],
      ),
      {
        id: sid('appr1'),
        type: 'approval',
        rejected: {
          steps: [
            { id: sid('task1'), type: 'action', action: 'create_task', config: { title: 'Call' } },
          ],
        },
      },
      text(sid('text4')),
    ],
  });
const OUTER_YES = bid('outeyes');
const OUTER_NO = bid('outeno');
const INNER_YES = bid('inneyes');
const INNER_NO = bid('inneno');

describe('nextStep', () => {
  const d = tree();
  const step = (id: string) => ({ kind: 'step', stepId: id });

  it('walks the main path and ends at the bottom', () => {
    expect(nextStep(d, sid('text1'))).toEqual(step(sid('wait1')));
    expect(nextStep(d, sid('text4'))).toEqual({ kind: 'end', reason: 'finished' });
  });

  it('enters the chosen path, and after it continues with the step after the block', () => {
    expect(nextStep(d, sid('outer1'), { branchId: OUTER_YES })).toEqual(step(sid('text2')));
    expect(nextStep(d, sid('outer1'), { branchId: OUTER_NO })).toEqual(step(sid('wait2')));
    expect(nextStep(d, sid('wait2'))).toEqual(step(sid('appr1')));
  });

  it('goes straight past an empty path, climbing out of nested blocks', () => {
    expect(nextStep(d, sid('inner1'), { branchId: INNER_NO })).toEqual(step(sid('appr1')));
  });

  it('refuses an unknown path', () => {
    expect(() => nextStep(d, sid('outer1'), { branchId: bid('nope') })).toThrow(RangeError);
  });

  it('jumps back with a go-to until its visits are used, then carries on past the block', () => {
    expect(nextStep(d, sid('goto1'), { visits: 0 })).toEqual(step(sid('wait1')));
    expect(nextStep(d, sid('goto1'), { visits: 1 })).toEqual(step(sid('wait1')));
    expect(nextStep(d, sid('goto1'), { visits: 2 })).toEqual(step(sid('appr1')));
  });

  it('follows an approval, or its rejected path and then ends', () => {
    expect(nextStep(d, sid('appr1'), { approved: true })).toEqual(step(sid('text4')));
    expect(nextStep(d, sid('appr1'), { approved: false })).toEqual(step(sid('task1')));
    expect(nextStep(d, sid('task1'))).toEqual({ kind: 'end', reason: 'rejected' });
  });

  it('stops at an end step', () => {
    const d2 = def({ steps: [end(sid('end1')), text(sid('text1'))] });
    expect(nextStep(d2, sid('end1'))).toEqual({ kind: 'end', reason: 'end_step' });
  });
});

describe('finding and placing steps', () => {
  const d = tree();

  it('finds a step and the path to it', () => {
    expect(findStep(d, sid('text3'))).toMatchObject({
      index: 0,
      depth: 2,
      lane: { parentId: sid('inner1'), branchId: INNER_YES },
    });
    expect(pathTo(d, sid('text3'))).toEqual([
      { stepId: sid('outer1'), branchId: OUTER_YES },
      { stepId: sid('inner1'), branchId: INNER_YES },
    ]);
    expect(pathTo(d, sid('nope'))).toBeNull();
  });

  it('offers no slot after a go-to or an end, and go-tos only at the end of a nested path', () => {
    const points = insertionPoints(d);
    const innerYes = points.filter((p) => p.parentId === sid('inner1') && p.branchId === INNER_YES);
    expect(innerYes.map((p) => p.index)).toEqual([0, 1]);
    const gotoSlots = insertionPoints(d, 'goto');
    expect(gotoSlots.every((p) => p.parentId !== null)).toBe(true);
    expect(gotoSlots.some((p) => p.parentId === sid('inner1') && p.branchId === INNER_YES)).toBe(
      false,
    );
    const withEnd = def({ steps: [text(sid('a')), end(sid('b')), text(sid('c'))] });
    expect(insertionPoints(withEnd).map((p) => p.index)).toEqual([0, 1]);
  });

  it('says whether a move is allowed', () => {
    expect(
      canMove(d, sid('outer1'), { parentId: sid('inner1'), branchId: INNER_NO, index: 0 }),
    ).toBe(false);
    expect(canMove(d, sid('goto1'), { parentId: null, branchId: null, index: 5 })).toBe(false);
    expect(
      canMove(d, sid('goto1'), { parentId: sid('outer1'), branchId: OUTER_NO, index: 0 }),
    ).toBe(false);
    expect(
      canMove(d, sid('goto1'), { parentId: sid('outer1'), branchId: OUTER_NO, index: 1 }),
    ).toBe(true);
    expect(
      canMove(d, sid('text1'), { parentId: sid('inner1'), branchId: INNER_YES, index: 2 }),
    ).toBe(false);
    expect(
      canMove(d, sid('text1'), { parentId: sid('appr1'), branchId: 'rejected', index: 1 }),
    ).toBe(true);
  });
});

describe('variablesAt', () => {
  const paths = (d: ReturnType<typeof def>, id: string | null) =>
    variablesAt(d, id).map((v) => v.path);

  it('offers the trigger’s records', () => {
    expect(paths(tree(), sid('text1'))).toContain('lead.title');
    expect(paths(def({ steps: [text(sid('a'))] }), sid('a'))).not.toContain('lead.title');
    expect(paths(def({ trigger: { kind: 'event', event: 'appointment.booked' } }), null)).toContain(
      'appointment.starts_at',
    );
  });

  it('adds a lead created earlier, and AI results only from steps that surely ran', () => {
    const ai: StepInput = { id: sid('ai1'), type: 'ai', task: 'write', prompt: 'Say hi' };
    const lead: StepInput = {
      id: sid('lead1'),
      type: 'action',
      action: 'create_lead',
      config: { title: 'New', pipelineId: SALES, stageId: STAGE_NEW },
    };
    const d = def({
      steps: [
        lead,
        ai,
        ifElse(sid('br1'), [{ ...ai, id: sid('ai2'), outputKey: 'draft' }], [text(sid('t1'))]),
        text(sid('t2')),
      ],
    });
    expect(paths(d, sid('ai1'))).toContain('lead.title');
    expect(paths(d, sid('ai1'))).not.toContain('ai.message');
    expect(paths(d, sid('t2'))).toContain('ai.message');
    expect(paths(d, sid('t2'))).not.toContain('ai.draft');
    expect(paths(d, sid('t1'))).not.toContain('ai.draft');
  });
});
