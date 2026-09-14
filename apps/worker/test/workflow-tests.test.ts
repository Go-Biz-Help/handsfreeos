/**
 * Test runs of a draft. Simulate sends nothing, fast-forwards waits, approves automatically, and a pass opens
 * Publish (the worker is the only writer of tested_revision). A test of a revision the draft has since moved
 * past is recorded as outdated and opens nothing. "Send to me" reaches only the person testing, with waits cut
 * to 5 seconds. Every built-in recipe runs end to end in Simulate.
 */
import type { HfosError } from '@hfos/core/server';
import {
  recipeByKey,
  RECIPE_KEYS,
  workflowCreate,
  workflowPublish,
  workflowTest,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addWorkflow,
  admin,
  customerNamed,
  drain,
  emailsTo,
  flowWorld,
  makeCalendar,
  readyTexting,
  run,
  runJob,
  runOf,
  runsOf,
  sid,
  stepOf,
  stepsOf,
  textsTo,
  waitForMail,
  writeDraft,
  type World,
} from './workflow-world';

let w: World;
let calendarId: string;
beforeAll(async () => {
  w = await flowWorld('wftest');
  await readyTexting(w);
  calendarId = (await makeCalendar(w, 'Service calls')).id;
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

async function workflowRow(id: string) {
  const [r] = await rows<{ revision: number; tested_revision: number | null; status: string }>(
    admin(),
    sql`select revision, tested_revision, status::text as status from app.workflows where id = ${id}`,
  );
  return r!;
}

async function test(workflowId: string, mode: 'simulate' | 'send_to_me', personId: string | null) {
  await run(w, workflowTest, { workspaceId: w.workspaceId, workflowId, mode, personId });
}

async function testRun(workflowId: string) {
  const list = await runsOf(workflowId, { tests: true });
  return list.at(-1)!;
}

describe('Simulate', () => {
  it('sends nothing, fast-forwards waits, approves automatically, and a pass opens Publish', async () => {
    const ids = {
      text: sid('tstext'),
      wait: sid('tswait'),
      approval: sid('tsappr'),
      email: sid('tsmail'),
      note: sid('tsnote'),
      task: sid('tstask'),
    };
    const wf = await addWorkflow(
      w,
      'Simulated follow-up',
      {
        version: 1,
        trigger: { kind: 'manual' },
        steps: [
          {
            id: ids.text,
            type: 'action',
            action: 'send_text',
            config: { body: 'Hi {{person.first_name}}!' },
          },
          {
            id: ids.wait,
            type: 'wait',
            until: { kind: 'duration', duration: { amount: 2, unit: 'days' } },
          },
          { id: ids.approval, type: 'approval', message: 'OK?' },
          {
            id: ids.email,
            type: 'action',
            action: 'send_email',
            config: { subject: 'Your visit', body: 'See you soon, {{person.first_name}}.' },
          },
          { id: ids.note, type: 'action', action: 'add_note', config: { body: 'Noted' } },
          {
            id: ids.task,
            type: 'action',
            action: 'create_task',
            config: { title: 'Call {{person.first_name}}' },
          },
        ],
      },
      { publish: false },
    );
    const p = await customerNamed(w, 'Sim');
    await test(wf.id, 'simulate', p.id);
    await drain(w);
    const r = await testRun(wf.id);
    expect(r).toMatchObject({ status: 'completed', is_test: true, version_id: null });
    const step = (id: string) => stepOf(r.id, id);
    expect((await step(ids.text))!.output).toMatchObject({
      simulated: true,
      would: 'text',
      body: expect.stringContaining('Hi Sim!'),
    });
    expect((await step(ids.wait))!.output).toMatchObject({ fastForwarded: true });
    expect((await step(ids.approval))!.output).toMatchObject({ autoApproved: true });
    expect((await step(ids.email))!.output).toMatchObject({ simulated: true, would: 'email' });
    expect((await step(ids.note))!.output).toMatchObject({ simulated: true });
    expect((await step(ids.task))!.input).toMatchObject({ title: 'Call Sim' });
    // Nothing reached anyone.
    expect(textsTo(w, p.phone!)).toHaveLength(0);
    expect(await emailsTo(w, p.email!)).toEqual([]);
    const [touched] = await rows<{ n: number }>(
      admin(),
      sql`select (select count(*) from app.activities where person_id = ${p.id} and kind = 'note')::int
            + (select count(*) from app.tasks where person_id = ${p.id})::int as n`,
    );
    expect(touched!.n).toBe(0);
    expect(
      await rows(admin(), sql`select 1 from app.workflow_approvals where run_id = ${r.id}`),
    ).toEqual([]);

    // The pass opens Publish for exactly this revision.
    const row = await workflowRow(wf.id);
    expect(row.tested_revision).toBe(row.revision);
    const published = await run(w, workflowPublish, {
      workspaceId: w.workspaceId,
      workflowId: wf.id,
      baseRevision: row.revision,
    });
    expect(published.version).toBe(1);
  });

  it('records a test of a revision the draft moved past as outdated, which opens nothing', async () => {
    const def = {
      version: 1 as const,
      trigger: { kind: 'manual' as const },
      steps: [
        {
          id: sid('oonote'),
          type: 'action' as const,
          action: 'add_note' as const,
          config: { body: 'One' },
        },
      ],
    };
    const wf = await addWorkflow(w, 'Moving target', def, { publish: false });
    const before = await workflowRow(wf.id);
    await test(wf.id, 'simulate', null);
    // Someone saves again before the engine picks the test up.
    await writeDraft(wf.id, { ...def, steps: [{ ...def.steps[0]!, config: { body: 'Two' } }] });
    await drain(w);
    const r = await testRun(wf.id);
    expect(r).toMatchObject({ status: 'stopped', end_reason: 'outdated', is_test: true });
    expect(r.context).toMatchObject({
      requestedRevision: before.revision,
      currentRevision: before.revision + 1,
    });
    expect(await stepsOf(r.id)).toEqual([]);
    const after = await workflowRow(wf.id);
    expect(after.tested_revision).toBeNull();
    const refused = await run(w, workflowPublish, {
      workspaceId: w.workspaceId,
      workflowId: wf.id,
      baseRevision: after.revision,
    }).catch((e: unknown) => e);
    expect((refused as HfosError).rule).toBe('not_tested');
  });
});

describe('Send to me', () => {
  it('reaches only the person testing; everything else is simulated and waits shrink to 5 seconds', async () => {
    const ids = {
      text: sid('smtext'),
      wait: sid('smwait'),
      email: sid('smmail'),
      note: sid('smnote'),
    };
    const wf = await addWorkflow(
      w,
      'Tester only',
      {
        version: 1,
        trigger: { kind: 'manual' },
        steps: [
          {
            id: ids.text,
            type: 'action',
            action: 'send_text',
            config: { body: 'Hi {{person.first_name}}, it’s Lone Star.' },
          },
          {
            id: ids.wait,
            type: 'wait',
            until: { kind: 'duration', duration: { amount: 1, unit: 'days' } },
          },
          {
            id: ids.email,
            type: 'action',
            action: 'send_email',
            config: {
              subject: 'Your visit on Tuesday',
              body: 'See you soon, {{person.first_name}}.',
            },
          },
          { id: ids.note, type: 'action', action: 'add_note', config: { body: 'Noted' } },
        ],
      },
      { publish: false },
    );
    const p = await customerNamed(w, 'Customer');
    await test(wf.id, 'send_to_me', p.id);
    await drain(w);
    const r = await testRun(wf.id);
    expect(r.status).toBe('waiting');
    const wait = (await stepOf(r.id, ids.wait))!;
    const wakeAt = Date.parse(String(wait.output!['wakeAt']));
    expect(wakeAt - Date.now()).toBeLessThan(6_000);
    await runJob(w, r.id);
    expect((await runOf(r.id)).status).toBe('completed');

    expect((await stepOf(r.id, ids.text))!.output).toMatchObject({
      sentToTester: w.owner.email,
      channel: 'sms',
    });
    expect((await stepOf(r.id, ids.note))!.output).toMatchObject({ simulated: true });
    expect(textsTo(w, p.phone!)).toHaveLength(0);
    expect(await emailsTo(w, p.email!)).toEqual([]);
    const text = await waitForMail(w.owner.email, '[Test] A text from “Tester only”');
    expect(text.text).toContain('Hi Customer, it’s Lone Star.');
    const email = await waitForMail(w.owner.email, '[Test] Your visit on Tuesday');
    expect(email.text).toContain('See you soon, Customer.');
    const row = await workflowRow(wf.id);
    expect(row.tested_revision).toBe(row.revision);
  });
});

describe('the built-in recipes', () => {
  it.each(RECIPE_KEYS)('%s runs end to end in Simulate', async (key) => {
    const recipe = recipeByKey(key)!;
    const [stage] = await rows<{ id: string }>(
      admin(),
      sql`select s.id from app.pipeline_stages s join app.pipelines p on p.id = s.pipeline_id
          where p.workspace_id = ${w.workspaceId} and s.kind = 'open' order by p.position, s.position offset 1 limit 1`,
    );
    const mapping = Object.fromEntries(
      recipe.placeholders.map((ph) => [
        ph.key,
        ph.kind === 'user' ? w.owner.id : ph.kind === 'calendar' ? calendarId : stage!.id,
      ]),
    );
    const created = await run(w, workflowCreate, {
      workspaceId: w.workspaceId,
      name: recipe.name,
      from: 'recipe',
      recipeKey: key,
      ...(recipe.placeholders.length ? { mapping } : {}),
    });
    expect(created.placeholders).toEqual([]);
    const p = await customerNamed(w, 'Recipe');
    await test(created.workflowId, 'simulate', p.id);
    await drain(w);
    const r = await testRun(created.workflowId);
    expect(r.status).toBe('completed');
    const steps = await stepsOf(r.id);
    expect(steps.length).toBeGreaterThan(2);
    expect(steps.filter((s) => s.status === 'failed' || s.status === 'dead')).toEqual([]);
    const row = await workflowRow(created.workflowId);
    expect(row.tested_revision).toBe(row.revision);
    expect(textsTo(w, p.phone!)).toHaveLength(0);
  });
});
