/**
 * Stopped partway (funnels), with the real worker loop: somebody gives their details on a funnel's second page and
 * goes quiet on its third. Half an hour on, the sweep marks that page, and the workflow that starts on
 * "Somebody stops partway through a form" for that page starts for them; one for another page doesn't.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  formCreate,
  formPublish,
  formResponseSave,
  formResponseSaveContact,
  formResponseStart,
  formSaveDraft,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formsStoppedSweep } from '../src/forms/stopped';
import type { JobContext } from '../src/jobs';
import {
  addWorkflow,
  admin,
  drain,
  flowWorld,
  run,
  runsOf,
  sid,
  type World,
} from './workflow-world';

let w: World;
beforeAll(async () => {
  w = await flowWorld('fstop');
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const system = () => ({
  type: 'system' as const,
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

/** Name and phone on a page that saves them, then "The overview" with one question. */
async function funnel(): Promise<string> {
  const created = await run(w, formCreate, { workspaceId: w.workspaceId, name: 'Meet the team' });
  const [first] = await rows<{ id: string }>(
    admin(),
    sql`select definition->'pages'->0->>'id' as id from app.forms where id = ${created.formId}`,
  );
  const add = (pageId: string, question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question,
  });
  const saved = await run(w, formSaveDraft, {
    workspaceId: w.workspaceId,
    formId: created.formId,
    baseRevision: created.revision,
    ops: [
      { op: 'set_settings', patch: { onePageAtATime: true } },
      { op: 'update_page', pageId: first!.id, patch: { savesContact: true } },
      add(first!.id, {
        id: 'q_name0000',
        type: 'short_text',
        title: 'Your name',
        required: true,
        mapTo: 'person.first_name',
        config: {},
      }),
      add(first!.id, {
        id: 'q_phone000',
        type: 'phone',
        title: 'Your phone',
        mapTo: 'person.phone',
        config: {},
      }),
      {
        op: 'add_page',
        index: null,
        page: { id: 'p_overview', title: 'The overview', questions: [] },
      },
      add('p_overview', { id: 'q_goals000', type: 'long_text', title: 'Your goals', config: {} }),
    ],
  });
  await run(w, formPublish, {
    workspaceId: w.workspaceId,
    formId: created.formId,
    baseRevision: saved.revision,
  });
  return created.formId;
}

const stoppedOn = (pageTitle: string, tag: string) => ({
  version: 1 as const,
  trigger: {
    kind: 'event' as const,
    event: 'form.stopped' as const,
    filters: {
      match: 'all' as const,
      conditions: [{ field: 'trigger.page_title', op: 'eq', value: pageTitle }],
    },
  },
  steps: [
    {
      id: sid(tag),
      type: 'action' as const,
      action: 'add_note' as const,
      config: { body: `Stopped on {{trigger.page_title}}` },
    },
  ],
});

describe('stopped partway', () => {
  it('starts the workflow for the page they went quiet on', async () => {
    const formId = await funnel();
    const onOverview = await addWorkflow(
      w,
      'Nudge after the overview',
      stoppedOn('The overview', 'nudge'),
    );
    const onOther = await addWorkflow(w, 'Some other page', stoppedOn('Something else', 'other'));

    const { output: started } = await executeCommand(
      w.s.db,
      formResponseStart,
      { workspaceId: w.workspaceId, formId, source: 'link' },
      system(),
      meta(),
    );
    const { output: saved } = await executeCommand(
      w.s.db,
      formResponseSaveContact,
      {
        workspaceId: w.workspaceId,
        responseId: started.responseId,
        token: started.token,
        answers: { q_name0000: 'Morgan', q_phone000: '(512) 555-0611' },
      },
      system(),
      meta(),
    );
    await executeCommand(
      w.s.db,
      formResponseSave,
      {
        workspaceId: w.workspaceId,
        responseId: started.responseId,
        token: started.token,
        answers: {},
        pageId: 'p_overview',
      },
      system(),
      meta(),
    );
    await rows(
      admin(),
      sql`update app.form_responses set last_active_at = now() - interval '45 minutes'
          where id = ${started.responseId}`,
    );

    await formsStoppedSweep({ ...w.s, now: Date.now() } as unknown as JobContext);
    await drain(w);

    const runs = await runsOf(onOverview.id);
    expect(runs.map((r) => r.person_id)).toEqual([saved.personId]);
    expect(await runsOf(onOther.id)).toEqual([]);
    const notes = await rows<{ body: string }>(
      admin(),
      sql`select body from app.activities where person_id = ${saved.personId} and kind = 'note'`,
    );
    expect(notes.map((n) => n.body)).toContain('Stopped on The overview');
  });
});
