/**
 * A run without the record its trigger would have brought: a lead-based workflow started for someone by hand
 * through the API (workflow.enrol takes any live workflow; the web and the Assistant offer only those that
 * start by hand). Nothing breaks: a step whose words need the missing lead is skipped as missing_variable, a
 * lead or conversation action with nothing to act on is skipped as no_lead or no_conversation, a wait on a
 * date that isn't there moves on, a check on a missing field is false, and the run finishes.
 */
import { workflowEnrol } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addWorkflow,
  admin,
  customerNamed,
  drain,
  flowWorld,
  run,
  runsOf,
  stepsOf,
  type StepView,
  type World,
} from './workflow-world';

let w: World;
beforeAll(async () => {
  w = await flowWorld('wfnorec');
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const note = (id: string, body: string) => ({
  id,
  type: 'action' as const,
  action: 'add_note' as const,
  config: { body },
});

describe('a run with no lead', () => {
  it('skips the steps that need the lead, and finishes', async () => {
    const [stage] = await rows<{ pipeline_id: string; id: string }>(
      admin(),
      sql`select pipeline_id, id from app.pipeline_stages
          where workspace_id = ${w.workspaceId} order by position limit 1`,
    );
    const wf = await addWorkflow(w, 'New lead follow-up', {
      version: 1,
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        note('s_nrnote01', 'About {{lead.title}}'),
        {
          id: 's_nrtask01',
          type: 'action',
          action: 'create_task',
          config: { title: 'Call about {{lead.title}}', assignTo: { kind: 'lead_assignee' } },
        },
        {
          id: 's_nrtask02',
          type: 'action',
          action: 'create_task',
          config: { title: 'Call {{person.first_name}}', assignTo: { kind: 'lead_assignee' } },
        },
        {
          id: 's_nrmove01',
          type: 'action',
          action: 'move_lead_stage',
          config: { pipelineId: stage!.pipeline_id, stageId: stage!.id },
        },
        {
          id: 's_nrasgn01',
          type: 'action',
          action: 'assign_lead',
          config: { assignTo: { kind: 'nobody' } },
        },
        {
          id: 's_nrnext01',
          type: 'action',
          action: 'set_next_action',
          config: { text: 'Call {{person.first_name}} back' },
        },
        {
          id: 's_nrwait01',
          type: 'wait',
          until: {
            kind: 'date_field',
            anchor: 'lead.next_action_at',
            offset: { amount: 0, unit: 'minutes' },
          },
        },
        {
          id: 's_nrbrch01',
          type: 'branch',
          mode: 'if_else',
          branches: [
            {
              id: 'b_nrbig000',
              name: 'Big job',
              condition: {
                match: 'all',
                conditions: [{ field: 'lead.value', op: 'gt', value: 1000 }],
              },
              steps: [note('s_nrnote02', 'A big job')],
            },
            { id: 'b_nrother0', name: 'Otherwise', steps: [note('s_nrnote03', 'Not a big job')] },
          ],
        },
        {
          id: 's_nrconv01',
          type: 'action',
          action: 'close_conversation',
          config: { channel: 'sms' },
        },
        note('s_nrnote04', 'Done with {{person.first_name}}'),
      ],
    });
    const nora = await customerNamed(w, 'Nora');
    await run(w, workflowEnrol, {
      workspaceId: w.workspaceId,
      workflowId: wf.id,
      personId: nora.id,
    });
    await drain(w);

    const [r] = await runsOf(wf.id);
    expect(r).toMatchObject({ status: 'completed', end_reason: 'finished' });
    const byStep = new Map<string, StepView>(
      (await stepsOf(r!.id)).map((s) => [s.step_key.split('#')[0]!, s]),
    );
    const skippedAs = (id: string) => byStep.get(id)?.output?.['skipped'];
    expect(skippedAs('s_nrnote01')).toBe('missing_variable');
    expect(skippedAs('s_nrtask01')).toBe('missing_variable');
    expect(byStep.get('s_nrtask02')).toMatchObject({ status: 'done' });
    expect(skippedAs('s_nrmove01')).toBe('no_lead');
    expect(skippedAs('s_nrasgn01')).toBe('no_lead');
    expect(skippedAs('s_nrnext01')).toBe('no_lead');
    expect(byStep.get('s_nrwait01')).toMatchObject({
      status: 'done',
      output: { anchorMissing: true },
    });
    expect(byStep.has('s_nrnote02')).toBe(false);
    expect(byStep.get('s_nrnote03')).toMatchObject({ status: 'done' });
    expect(skippedAs('s_nrconv01')).toBe('no_conversation');
    expect(byStep.get('s_nrnote04')).toMatchObject({ status: 'done' });
    expect(
      [...byStep.values()].filter((s) => s.status === 'failed' || s.status === 'dead'),
    ).toEqual([]);

    // The task for "the lead's assignee" went to no one, and the notes that could be written were.
    expect(
      await rows(
        admin(),
        sql`select title, assignee_user_id from app.tasks where person_id = ${nora.id}`,
      ),
    ).toEqual([{ title: 'Call Nora', assignee_user_id: null }]);
  });
});
