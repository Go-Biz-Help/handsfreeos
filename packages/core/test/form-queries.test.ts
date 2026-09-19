/**
 * Form reads on the local database: the list and what it counts, one form with its issues and versions,
 * the responses, and the results — four answers to one question becoming one bar chart.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formCatalogs,
  formCreate,
  formGet,
  formList,
  formPublish,
  formResponseGet,
  formResponseList,
  formResponseStart,
  formResponseSubmit,
  formResults,
  formSaveDraft,
  organizationCreate,
} from '../src/server';
import { admin, ask, run, runSystem, type Scope } from './calendar-helpers';

let owner: TestUser;
let wsId: string;
let scope: Scope;
let formId: string;

const qid = (name: string) => `q_${name.padEnd(8, '0').slice(0, 8)}`;
const cid = (name: string) => `c_${name.padEnd(8, '0').slice(0, 8)}`;

beforeAll(async () => {
  owner = await createTestUser('form-query-owner', { fullName: 'Dale Owner' });
  const org = await run(organizationCreate, { businessName: 'Form Queries Co' }, owner);
  wsId = org.workspaceId;
  scope = { workspaceId: wsId, organizationId: org.organizationId };

  const created = await run(formCreate, { workspaceId: wsId, name: 'Job feedback', mode: 'survey' }, owner);
  formId = created.formId;
  const [row] = await rows<{ definition: { pages: { id: string }[] } }>(
    admin(),
    sql`select definition from app.forms where id = ${formId}`,
  );
  const pageId = row!.definition.pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question,
  });
  const saved = await run(
    formSaveDraft,
    {
      workspaceId: wsId,
      formId,
      baseRevision: 1,
      ops: [
        add({
          id: qid('name'),
          type: 'short_text',
          title: 'Your name',
          required: true,
          mapTo: 'person.first_name',
          config: {},
        }),
        add({ id: qid('phone'), type: 'phone', title: 'Your phone', mapTo: 'person.phone', config: {} }),
        add({
          id: qid('rating'),
          type: 'rating',
          title: 'How did we do?',
          config: { max: 5, icon: 'star' },
        }),
        add({
          id: qid('again'),
          type: 'choice',
          title: 'Would you use us again?',
          config: {
            choices: [
              { id: cid('yes'), label: 'Yes' },
              { id: cid('maybe'), label: 'Maybe' },
            ],
          },
        }),
        add({ id: qid('notes'), type: 'long_text', title: 'Anything else?', config: {} }),
      ],
    },
    owner,
  );
  await run(formPublish, { workspaceId: wsId, formId, baseRevision: saved.revision }, owner);

  const answer = async (phone: string, rating: number, again: string, notes: string) => {
    const started = await runSystem(
      formResponseStart,
      { workspaceId: wsId, formId, source: 'link' },
      scope,
    );
    return runSystem(
      formResponseSubmit,
      {
        workspaceId: wsId,
        responseId: started.responseId,
        answers: {
          [qid('name')]: 'Customer ' + phone.slice(-4),
          [qid('phone')]: phone,
          [qid('rating')]: rating,
          [qid('again')]: again,
          [qid('notes')]: notes,
        },
        smsConsent: false,
      },
      scope,
    );
  };
  await answer('(512) 555-0301', 5, cid('yes'), 'On time and tidy');
  await answer('(512) 555-0302', 4, cid('yes'), 'Good work');
  await answer('(512) 555-0303', 2, cid('maybe'), 'Late, but fixed it');
});
afterAll(closeTestDbs);

describe('the list', () => {
  it('counts the answers and how many finished what they started', async () => {
    const { items } = await ask(formList, { workspaceId: wsId }, owner);
    const form = items.find((f) => f.formId === formId)!;
    expect(form.name).toBe('Job feedback');
    expect(form.mode).toBe('survey');
    expect(form.status).toBe('live');
    expect(form.questionCount).toBe(5);
    expect(form.responseCount).toBe(3);
    expect(form.completionRate).toBe(1);
    expect(form.version).toBe(1);
  });

  it('leaves the archive out unless it is asked for', async () => {
    const extra = await run(formCreate, { workspaceId: wsId, name: 'Old one' }, owner);
    await rows(admin(), sql`update app.forms set status = 'archived', archived_at = now() where id = ${extra.formId}`);
    const plain = await ask(formList, { workspaceId: wsId }, owner);
    expect(plain.items.map((f) => f.formId)).not.toContain(extra.formId);
    const all = await ask(formList, { workspaceId: wsId, includeArchived: true }, owner);
    expect(all.items.map((f) => f.formId)).toContain(extra.formId);
  });
});

describe('one form', () => {
  it('comes back with its draft, its versions and nothing wrong with it', async () => {
    const got = await ask(formGet, { workspaceId: wsId, formId }, owner);
    expect(got.issues).toEqual([]);
    expect(got.versions).toHaveLength(1);
    expect(got.versions[0]!.live).toBe(true);
    expect(got.versions[0]!.publishedBy).toBe('Dale Owner');
    expect(got.unpublishedChanges).toBe(false);
  });

  it('says when the draft has moved on since the last publish', async () => {
    const before = await ask(formGet, { workspaceId: wsId, formId }, owner);
    await run(
      formSaveDraft,
      {
        workspaceId: wsId,
        formId,
        baseRevision: before.revision,
        ops: [{ op: 'set_form', patch: { intro: 'Thanks for a minute of your time.' } }],
      },
      owner,
    );
    const after = await ask(formGet, { workspaceId: wsId, formId }, owner);
    expect(after.unpublishedChanges).toBe(true);
  });

  it('offers the editor its pickers', async () => {
    const catalogs = await ask(formCatalogs, { workspaceId: wsId }, owner);
    expect(catalogs.pipelines.length).toBeGreaterThan(0);
    expect(catalogs.pipelines[0]!.stages.length).toBeGreaterThan(0);
    expect(catalogs.team.map((t) => t.name)).toContain('Dale Owner');
  });
});

describe('the responses', () => {
  it('lists who answered, newest first', async () => {
    const { items } = await ask(formResponseList, { workspaceId: wsId, formId }, owner);
    expect(items).toHaveLength(3);
    expect(items[0]!.personName).toBeTruthy();
    expect(items[0]!.completedAt).toBeTruthy();
  });

  it('reads one in full, with the questions as they were worded', async () => {
    const { items } = await ask(formResponseList, { workspaceId: wsId, formId }, owner);
    const got = await ask(
      formResponseGet,
      { workspaceId: wsId, responseId: items[0]!.responseId },
      owner,
    );
    expect(got.answers.map((a) => a.questionId)).toContain(qid('rating'));
    const again = got.answers.find((a) => a.questionId === qid('again'))!;
    expect(again.labels.length).toBe(1);
    expect(again.questionTitle).toBe('Would you use us again?');
  });
});

describe('the results', () => {
  it('turns the answers into bars, an average and a few words to read', async () => {
    const results = await ask(formResults, { workspaceId: wsId, formId }, owner);
    expect(results.completions).toBe(3);
    const rating = results.questions.find((q) => q.questionId === qid('rating'))!;
    expect(rating.answered).toBe(3);
    expect(rating.average).toBeCloseTo(3.67, 1);
    const again = results.questions.find((q) => q.questionId === qid('again'))!;
    expect(again.choices).toEqual([
      { label: 'Yes', count: 2 },
      { label: 'Maybe', count: 1 },
    ]);
    const notes = results.questions.find((q) => q.questionId === qid('notes'))!;
    expect(notes.samples).toHaveLength(3);
    expect(notes.samples).toContain('Late, but fixed it');
    // A survey isn't scored, so there is nothing to average.
    expect(results.averagePercent).toBe(0);
    expect(results.passRate).toBe(null);
  });
});
