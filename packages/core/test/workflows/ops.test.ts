import { describe, expect, it } from 'vitest';
import {
  allLanes,
  allSteps,
  applyWorkflowOps,
  diffWorkflows,
  newBranchId,
  newStepId,
  structureProblems,
  WorkflowDefinition,
  WorkflowOpError,
  type StepInput,
  type WorkflowOp,
} from '../../src/workflows/index';
import type { Rng } from '../calendar/random';
import { bid, def, end, forWorkflowSeeds, goto, ifElse, sid, text, waitDays } from './fixtures';

const base = () =>
  def({
    trigger: { kind: 'event', event: 'lead.created' },
    steps: [
      text(sid('text1')),
      waitDays(sid('wait1')),
      ifElse(
        sid('branch1'),
        [text(sid('text2')), goto(sid('goto1'), sid('wait1'))],
        [waitDays(sid('wait2'), 2)],
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
    ],
  });

function roundTrip(start: WorkflowDefinition, ops: WorkflowOp[]) {
  const { definition, inverse } = applyWorkflowOps(start, ops);
  expect(applyWorkflowOps(definition, inverse).definition).toEqual(start);
  return definition;
}

function opError(fn: () => unknown): WorkflowOpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof WorkflowOpError) return error;
    throw error;
  }
  throw new Error('expected a WorkflowOpError');
}

describe('applyWorkflowOps', () => {
  it('adds, and its inverse removes', () => {
    const next = roundTrip(base(), [
      {
        op: 'add_step',
        parentId: sid('branch1'),
        branchId: bid('branyes'),
        index: 0,
        step: waitDays(sid('new1')),
      },
    ]);
    const lane = next.steps[2]!.type === 'branch' ? next.steps[2]!.branches[0]!.steps : [];
    expect(lane.map((s) => s.id)).toEqual([sid('new1'), sid('text2'), sid('goto1')]);
  });

  it('fills defaults, so the stored tree is canonical', () => {
    const next = roundTrip(base(), [
      { op: 'add_step', parentId: null, branchId: null, index: null, step: text(sid('new1')) },
    ]);
    const added = next.steps.at(-1)!;
    expect(added).toMatchObject({ onError: 'stop', config: { bookingCalendarId: null } });
    expect(WorkflowDefinition.parse(next)).toEqual(next);
  });

  it('deletes a step with its subtree, and the inverse puts it back in place', () => {
    const next = roundTrip(base(), [{ op: 'delete_step', stepId: sid('branch1') }]);
    expect(allSteps(next).map((l) => l.step.id)).not.toContain(sid('text2'));
  });

  it('moves between lanes and within a lane', () => {
    roundTrip(base(), [
      {
        op: 'move_step',
        stepId: sid('text1'),
        parentId: sid('branch1'),
        branchId: bid('branno'),
        index: 1,
      },
    ]);
    const next = roundTrip(base(), [
      { op: 'move_step', stepId: sid('text1'), parentId: null, branchId: null, index: 2 },
    ]);
    expect(next.steps.map((s) => s.id).slice(0, 3)).toEqual([
      sid('wait1'),
      sid('branch1'),
      sid('text1'),
    ]);
  });

  it('merges an update, and replaces the config when the action changes', () => {
    const next = roundTrip(base(), [
      { op: 'update_step', stepId: sid('wait1'), patch: { until: { duration: { amount: 2 } } } },
      {
        op: 'update_step',
        stepId: sid('text1'),
        patch: { action: 'add_note', config: { body: 'Called' } },
      },
    ]);
    expect(next.steps[1]).toMatchObject({
      until: { kind: 'duration', duration: { amount: 2, unit: 'days' } },
    });
    expect(next.steps[0]).toMatchObject({ action: 'add_note', config: { body: 'Called' } });
  });

  it('renames and reorders paths through update_step', () => {
    const next = roundTrip(base(), [
      { op: 'update_step', stepId: sid('branch1'), patch: { mode: 'multi' } },
      {
        op: 'update_step',
        stepId: sid('branch1'),
        patch: { branches: [{ id: bid('branyes'), name: 'Won' }] },
      },
    ]);
    const step = next.steps[2]!;
    expect(step.type === 'branch' && step.branches.map((b) => b.name)).toEqual(['Won', 'No']);
  });

  it('adds and deletes paths, keeping their steps for Undo', () => {
    let next = roundTrip(base(), [
      { op: 'update_step', stepId: sid('branch1'), patch: { mode: 'multi' } },
    ]);
    next = roundTrip(next, [
      {
        op: 'add_branch',
        stepId: sid('branch1'),
        index: 1,
        branch: { id: bid('extra'), name: 'Maybe', condition: won() },
      },
    ]);
    roundTrip(next, [{ op: 'delete_branch', stepId: sid('branch1'), branchId: bid('branyes') }]);
  });

  it('points a go-to elsewhere, and sets the trigger and settings', () => {
    roundTrip(base(), [
      { op: 'set_goto', stepId: sid('goto1'), target: sid('text1'), maxVisits: 5 },
      { op: 'set_trigger', trigger: { kind: 'event', event: 'call.missed' } },
      { op: 'set_settings', patch: { quietHours: 'skip', reentry: { mode: 'always' } } },
    ]);
  });

  it('is all or nothing, naming the op that failed', () => {
    const start = base();
    const snapshot = structuredClone(start);
    const error = opError(() =>
      applyWorkflowOps(start, [
        { op: 'add_step', parentId: null, branchId: null, index: 0, step: waitDays(sid('ok1')) },
        { op: 'move_step', stepId: sid('nope'), parentId: null, branchId: null, index: 0 },
      ]),
    );
    expect([error.opIndex, error.code]).toEqual([1, 'step_not_found']);
    expect(start).toEqual(snapshot);
  });

  it('refuses a move into its own subtree', () => {
    const error = opError(() =>
      applyWorkflowOps(base(), [
        {
          op: 'move_step',
          stepId: sid('branch1'),
          parentId: sid('branch1'),
          branchId: bid('branno'),
          index: 0,
        },
      ]),
    );
    expect(error.code).toBe('move_into_self');
  });

  it('keeps a go-to last in a branch, and out of the main path', () => {
    const after = opError(() =>
      applyWorkflowOps(base(), [
        {
          op: 'add_step',
          parentId: sid('branch1'),
          branchId: bid('branyes'),
          index: null,
          step: waitDays(sid('late')),
        },
      ]),
    );
    expect([after.code, after.opIndex, after.stepId]).toEqual(['goto_not_last', 0, sid('goto1')]);
    const root = opError(() =>
      applyWorkflowOps(base(), [
        {
          op: 'add_step',
          parentId: null,
          branchId: null,
          index: null,
          step: goto(sid('g2'), sid('text1')),
        },
      ]),
    );
    expect(root.code).toBe('goto_not_last');
  });

  it('refuses duplicate ids, id and type changes, and invalid fields', () => {
    expect(
      opError(() =>
        applyWorkflowOps(base(), [
          { op: 'add_step', parentId: null, branchId: null, index: 0, step: text(sid('text1')) },
        ]),
      ).code,
    ).toBe('duplicate_id');
    expect(
      opError(() =>
        applyWorkflowOps(base(), [
          { op: 'update_step', stepId: sid('wait1'), patch: { type: 'end' } },
        ]),
      ).code,
    ).toBe('bad_patch');
    const invalid = opError(() =>
      applyWorkflowOps(base(), [
        { op: 'set_settings', patch: { maxRunDays: 30 } },
        { op: 'update_step', stepId: sid('text1'), patch: { config: { body: '' } } },
      ]),
    );
    expect([invalid.code, invalid.opIndex, invalid.stepId]).toEqual(['invalid', 1, sid('text1')]);
    expect(
      opError(() =>
        applyWorkflowOps(base(), [
          { op: 'delete_branch', stepId: sid('branch1'), branchId: bid('branno') },
        ]),
      ).code,
    ).toBe('invalid');
  });
});

// ---- The property test ----

function randomStep(r: Rng, id: string): StepInput {
  switch (r.int(0, 5)) {
    case 0:
      return text(id, r.pick(['Hi!', 'Hello {{person.first_name}}', 'On our way']));
    case 1:
      return waitDays(id, r.int(1, 5));
    case 2:
      return { id, type: 'ai', task: 'classify', prompt: 'Sort it', categories: ['yes', 'no'] };
    case 3:
      return {
        id,
        type: 'branch',
        mode: r.pick(['if_else', 'multi', 'ai'] as const),
        branches: [
          { id: newBranchId(r.float), name: 'A', condition: won(), description: 'first' },
          { id: newBranchId(r.float), name: 'B', condition: null, description: 'second' },
        ],
      };
    case 4:
      return { id, type: 'approval', message: 'Check it' };
    default:
      return end(id);
  }
}

function randomOp(d: WorkflowDefinition, r: Rng): WorkflowOp {
  const steps = allSteps(d);
  const lanes = allLanes(d);
  const anyStep = () => r.pick(steps).step;
  const lane = r.pick(lanes);
  const kind = steps.length ? r.int(0, 9) : 0;
  switch (kind) {
    case 0: {
      const id = newStepId(r.float);
      const step =
        r.chance(0.15) && steps.length ? goto(id, anyStep().id, r.int(1, 4)) : randomStep(r, id);
      return {
        op: 'add_step',
        ...lane.ref,
        index: r.chance(0.3) ? null : r.int(0, lane.steps.length),
        step,
      };
    }
    case 1:
      return {
        op: 'move_step',
        stepId: anyStep().id,
        ...lane.ref,
        index: r.int(0, lane.steps.length),
      };
    case 2:
      return { op: 'delete_step', stepId: anyStep().id };
    case 3: {
      const step = anyStep();
      const patch: Record<string, unknown> =
        step.type === 'wait'
          ? { until: { duration: { amount: r.int(1, 9) } } }
          : step.type === 'action'
            ? r.chance(0.5)
              ? { config: { body: `Text ${r.int(1, 99)}` } }
              : { action: 'add_note', config: { body: 'A note' } }
            : step.type === 'branch'
              ? r.chance(0.5)
                ? { mode: r.pick(['if_else', 'multi', 'ai']) }
                : {
                    branches: [...step.branches]
                      .reverse()
                      .map((b) => ({ id: b.id, name: `P${r.int(1, 9)}` })),
                  }
              : step.type === 'goto'
                ? { maxVisits: r.int(1, 10) }
                : step.type === 'approval'
                  ? { message: `Look ${r.int(1, 9)}`, expiresAfter: { amount: r.int(1, 5) } }
                  : step.type === 'ai'
                    ? { prompt: `Prompt ${r.int(1, 9)}` }
                    : { id: step.id };
      return { op: 'update_step', stepId: step.id, patch };
    }
    case 4:
    case 5: {
      const branchSteps = steps.filter((l) => l.step.type === 'branch');
      const target = branchSteps.length ? r.pick(branchSteps).step : anyStep();
      if (kind === 4 || target.type !== 'branch')
        return {
          op: 'add_branch',
          stepId: target.id,
          index: null,
          branch: {
            id: newBranchId(r.float),
            name: 'New',
            condition: r.chance(0.5) ? won() : null,
            description: 'new',
          },
        };
      return { op: 'delete_branch', stepId: target.id, branchId: r.pick(target.branches).id };
    }
    case 6: {
      const gotos = steps.filter((l) => l.step.type === 'goto');
      return {
        op: 'set_goto',
        stepId: (gotos.length ? r.pick(gotos).step : anyStep()).id,
        target: anyStep().id,
        maxVisits: r.chance(0.5) ? null : r.int(1, 10),
      };
    }
    case 7:
      return {
        op: 'set_trigger',
        trigger: r.pick([
          { kind: 'manual' as const },
          { kind: 'event' as const, event: 'call.missed' as const },
          {
            kind: 'schedule' as const,
            cadence: { every: 'weekly' as const, days: [1, 3], at: '09:00' },
          },
        ]),
      };
    case 8:
      return {
        op: 'set_settings',
        patch: {
          quietHours: r.pick(['wait', 'skip', 'email_instead'] as const),
          maxRunDays: r.int(1, 365),
        },
      };
    default:
      return {
        op: 'move_step',
        stepId: anyStep().id,
        parentId: anyStep().id,
        branchId: r.pick([null, 'rejected', bid('nowhere')]),
        index: 0,
      };
  }
}

function won() {
  return {
    match: 'all' as const,
    conditions: [{ field: 'lead.status', op: 'eq' as const, value: 'won' }],
  };
}

describe('random ops (property)', () => {
  it('keep the tree valid, and the inverse and the diff both restore it', () => {
    let applied = 0;
    let refused = 0;
    forWorkflowSeeds(300, (r) => {
      let current = base();
      for (let round = 0; round < 8; round++) {
        const batch = Array.from({ length: r.int(1, 3) }, () => randomOp(current, r));
        const before = structuredClone(current);
        let result;
        try {
          result = applyWorkflowOps(current, batch);
        } catch (error) {
          if (!(error instanceof WorkflowOpError)) throw error;
          expect(error.opIndex).toBeGreaterThanOrEqual(0);
          expect(error.opIndex).toBeLessThan(batch.length);
          expect(current).toEqual(before);
          refused++;
          continue;
        }
        applied++;
        const next = result.definition;
        expect(structureProblems(next)).toEqual([]);
        expect(WorkflowDefinition.parse(next)).toEqual(next);
        expect(applyWorkflowOps(next, result.inverse).definition).toEqual(before);
        expect(applyWorkflowOps(before, diffWorkflows(before, next)).definition).toEqual(next);
        current = next;
      }
    });
    expect(applied).toBeGreaterThan(600);
    expect(refused).toBeGreaterThan(100);
  });
});
