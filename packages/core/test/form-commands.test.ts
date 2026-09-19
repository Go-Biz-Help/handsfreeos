/**
 * Form commands on the local database: creating one and the link it gets, draft saves (revision
 * conflicts, a bad op's index), the publish gate, opening and closing, links that keep working after a
 * rename, duplicating, archiving and putting an old version back.
 */
import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { forms, formVersions } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formArchive,
  formCreate,
  formDuplicate,
  formPublish,
  formRename,
  formRestore,
  formRestoreVersion,
  formSaveDraft,
  formSetDelivery,
  formSetSlug,
  formSetStatus,
  organizationCreate,
} from '../src/server';
import { admin, expectHfos, run } from './calendar-helpers';

let owner: TestUser, member: TestUser;
let wsId: string;

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('form-cmd-owner', { fullName: 'Dale Owner' }),
    createTestUser('form-cmd-member', { fullName: 'Mike Member' }),
  ]);
  const org = await run(organizationCreate, { businessName: 'Form Commands Co' }, owner);
  wsId = org.workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

// ---- Helpers ----

const qid = (name: string) => `q_${name.padEnd(8, '0').slice(0, 8)}`;

const askName = (id = qid('name'), extra: Record<string, unknown> = {}) => ({
  id,
  type: 'short_text',
  title: 'Your name',
  required: true,
  config: {},
  ...extra,
});

const addQuestion = (pageId: string, question: Record<string, unknown>) => ({
  op: 'add_question',
  pageId,
  index: null,
  question,
});

const row = async (formId: string) => {
  const [r] = await admin().select().from(forms).where(eq(forms.id, formId));
  return r!;
};

const firstPageId = async (formId: string) =>
  ((await row(formId)).definition as { pages: { id: string }[] }).pages[0]!.id;

/** A form with one question on it, saved but not published (revision 2). */
async function withQuestion(name: string) {
  const created = await run(formCreate, { workspaceId: wsId, name }, owner);
  const pageId = await firstPageId(created.formId);
  const saved = await run(
    formSaveDraft,
    {
      workspaceId: wsId,
      formId: created.formId,
      baseRevision: 1,
      ops: [addQuestion(pageId, askName())],
    },
    owner,
  );
  return { formId: created.formId, slug: created.slug, revision: saved.revision, pageId };
}

// ---- Tests ----

describe('starting one', () => {
  it('makes a draft with an empty page, a thank-you screen and its own link', async () => {
    const created = await run(
      formCreate,
      { workspaceId: wsId, name: 'Get a Quote!', mode: 'form' },
      owner,
    );
    expect(created.slug).toBe('get-a-quote');
    expect(created.revision).toBe(1);
    const saved = await row(created.formId);
    expect(saved.status).toBe('draft');
    expect(saved.activeVersionId).toBe(null);
    const definition = saved.definition as {
      pages: { questions: unknown[] }[];
      results: { headline: string }[];
      title: string;
    };
    expect(definition.pages).toHaveLength(1);
    expect(definition.pages[0]!.questions).toHaveLength(0);
    expect(definition.results).toHaveLength(1);
    expect(definition.title).toBe('Get a Quote!');
  });

  it('gives the next form of the same name a link of its own', async () => {
    const again = await run(formCreate, { workspaceId: wsId, name: 'Get a Quote!' }, owner);
    expect(again.slug).toBe('get-a-quote-2');
  });

  it('can start from one of the built-in forms', async () => {
    const created = await run(
      formCreate,
      { workspaceId: wsId, name: 'Quote request', starter: 'quote' },
      owner,
    );
    const saved = await row(created.formId);
    const definition = saved.definition as {
      pages: { questions: { type: string }[] }[];
      calculations: unknown[];
    };
    expect(definition.pages[0]!.questions.map((q) => q.type)).toContain('number');
    expect(definition.calculations).toHaveLength(1);
    // Ready to publish straight away, which is the point of a starter.
    const published = await run(
      formPublish,
      { workspaceId: wsId, formId: created.formId, baseRevision: created.revision },
      owner,
    );
    expect(published.version).toBe(1);
  });

  it('is not something a member can do', async () => {
    await expectHfos(
      () => run(formCreate, { workspaceId: wsId, name: 'Members only' }, member),
      'forbidden',
      403,
    );
  });
});

describe('saving the draft', () => {
  it('applies the ops and raises the revision', async () => {
    const created = await run(formCreate, { workspaceId: wsId, name: 'Intake' }, owner);
    const pageId = await firstPageId(created.formId);
    const saved = await run(
      formSaveDraft,
      {
        workspaceId: wsId,
        formId: created.formId,
        baseRevision: 1,
        ops: [addQuestion(pageId, askName())],
      },
      owner,
    );
    expect(saved.revision).toBe(2);
    expect(saved.changed).toBe(true);
    expect(saved.changes).toEqual(['Added “Your name”']);
    expect(saved.issues).toEqual([]);
  });

  it('says nothing changed when nothing did', async () => {
    const form = await withQuestion('Nothing doing');
    const again = await run(
      formSaveDraft,
      {
        workspaceId: wsId,
        formId: form.formId,
        baseRevision: form.revision,
        ops: [{ op: 'update_question', questionId: qid('name'), patch: { title: 'Your name' } }],
      },
      owner,
    );
    expect(again.changed).toBe(false);
    expect(again.revision).toBe(form.revision);
  });

  it('refuses a save that started from an older revision', async () => {
    const form = await withQuestion('Two editors');
    await expectHfos(
      () =>
        run(
          formSaveDraft,
          {
            workspaceId: wsId,
            formId: form.formId,
            baseRevision: 1,
            ops: [{ op: 'set_form', patch: { title: 'Mine' } }],
          },
          owner,
        ),
      'revision_conflict',
      409,
    );
  });

  it('names the op that was wrong', async () => {
    const form = await withQuestion('Bad op');
    const error = await expectHfos(
      () =>
        run(
          formSaveDraft,
          {
            workspaceId: wsId,
            formId: form.formId,
            baseRevision: form.revision,
            ops: [
              { op: 'set_form', patch: { title: 'Fine' } },
              { op: 'delete_question', questionId: qid('ghost') },
            ],
          },
          owner,
        ),
      'form_op_invalid',
      400,
    );
    expect((error.details as { opIndex: number }).opIndex).toBe(1);
  });

  it('reports what is wrong without refusing the save', async () => {
    const form = await withQuestion('Half built');
    const saved = await run(
      formSaveDraft,
      {
        workspaceId: wsId,
        formId: form.formId,
        baseRevision: form.revision,
        ops: [
          addQuestion(form.pageId, {
            id: qid('budget'),
            type: 'short_text',
            title: 'Your budget',
            config: {},
            // A rule that reads an answer given later on: allowed in the draft, refused at publish.
            showIf: {
              conditions: [
                { source: { kind: 'question', questionId: qid('later') }, op: 'answered' },
              ],
            },
          }),
          addQuestion(form.pageId, {
            id: qid('later'),
            type: 'short_text',
            title: 'Later',
            config: {},
          }),
        ],
      },
      owner,
    );
    expect(saved.changed).toBe(true);
    expect(saved.issues.map((i) => i.message)).toContain(
      'The rule on “Your budget” reads an answer that hasn’t been given yet.',
    );
  });
});

describe('publishing', () => {
  it('will not publish a form that asks nothing', async () => {
    const created = await run(formCreate, { workspaceId: wsId, name: 'Empty' }, owner);
    await expectHfos(
      () => run(formPublish, { workspaceId: wsId, formId: created.formId, baseRevision: 1 }, owner),
      'form_empty',
      422,
    );
  });

  it('will not publish while something is wrong with it', async () => {
    const form = await withQuestion('Broken rules');
    const saved = await run(
      formSaveDraft,
      {
        workspaceId: wsId,
        formId: form.formId,
        baseRevision: form.revision,
        ops: [
          addQuestion(form.pageId, {
            id: qid('budget'),
            type: 'short_text',
            title: 'Your budget',
            config: {},
            showIf: {
              conditions: [
                { source: { kind: 'question', questionId: qid('later') }, op: 'answered' },
              ],
            },
          }),
          addQuestion(form.pageId, {
            id: qid('later'),
            type: 'short_text',
            title: 'Later',
            config: {},
          }),
        ],
      },
      owner,
    );
    await expectHfos(
      () =>
        run(
          formPublish,
          { workspaceId: wsId, formId: form.formId, baseRevision: saved.revision },
          owner,
        ),
      'form_issues',
      422,
    );
  });

  it('freezes the draft as version 1 and starts taking answers', async () => {
    const form = await withQuestion('Ready to go');
    const published = await run(
      formPublish,
      { workspaceId: wsId, formId: form.formId, baseRevision: form.revision },
      owner,
    );
    expect(published.version).toBe(1);
    expect(published.status).toBe('live');
    const after = await row(form.formId);
    expect(after.status).toBe('live');
    expect(after.activeVersionId).toBe(published.versionId);
    const [version] = await admin()
      .select()
      .from(formVersions)
      .where(eq(formVersions.id, published.versionId));
    expect(version!.revision).toBe(form.revision);
  });

  it('publishes again as version 2, and a closed form stays closed', async () => {
    const form = await withQuestion('Second thoughts');
    await run(
      formPublish,
      { workspaceId: wsId, formId: form.formId, baseRevision: form.revision },
      owner,
    );
    await run(formSetStatus, { workspaceId: wsId, formId: form.formId, status: 'closed' }, owner);
    const saved = await run(
      formSaveDraft,
      {
        workspaceId: wsId,
        formId: form.formId,
        baseRevision: form.revision,
        ops: [{ op: 'set_form', patch: { title: 'Now with more questions' } }],
      },
      owner,
    );
    const again = await run(
      formPublish,
      { workspaceId: wsId, formId: form.formId, baseRevision: saved.revision },
      owner,
    );
    expect(again.version).toBe(2);
    expect(again.status).toBe('closed');
  });

  it('will not open a form that has never been published', async () => {
    const created = await run(formCreate, { workspaceId: wsId, name: 'Never published' }, owner);
    await expectHfos(
      () =>
        run(formSetStatus, { workspaceId: wsId, formId: created.formId, status: 'live' }, owner),
      'form_unpublished',
      409,
    );
  });
});

describe('the link', () => {
  it('keeps the old one working after a change, and refuses one already taken', async () => {
    const form = await withQuestion('Spring special');
    await run(formSetSlug, { workspaceId: wsId, formId: form.formId, slug: 'spring-2027' }, owner);
    const retired = await rows<{ slug: string }>(
      admin(),
      sql`select slug from app.form_slugs where form_id = ${form.formId}`,
    );
    expect(retired.map((r) => r.slug)).toEqual([form.slug]);
    const other = await withQuestion('Somebody else');
    await expectHfos(
      () =>
        run(formSetSlug, { workspaceId: wsId, formId: other.formId, slug: 'spring-2027' }, owner),
      'form_slug_taken',
      409,
    );
    // The retired one is taken too: it still points at the form that used it.
    await expectHfos(
      () => run(formSetSlug, { workspaceId: wsId, formId: other.formId, slug: form.slug }, owner),
      'form_slug_taken',
      409,
    );
  });

  it('says where a form may appear', async () => {
    const form = await withQuestion('On the website');
    const delivery = await run(
      formSetDelivery,
      {
        workspaceId: wsId,
        formId: form.formId,
        embedOrigins: ['https://example.com', 'https://example.com'],
        inChat: true,
      },
      owner,
    );
    expect(delivery.embedOrigins).toEqual(['https://example.com']);
    expect(delivery.inChat).toBe(true);
  });
});

describe('copies, the archive and old versions', () => {
  it('copies the questions into a fresh draft with its own link', async () => {
    const form = await withQuestion('Worth copying');
    await run(
      formPublish,
      { workspaceId: wsId, formId: form.formId, baseRevision: form.revision },
      owner,
    );
    const copy = await run(formDuplicate, { workspaceId: wsId, formId: form.formId }, owner);
    const copied = await row(copy.formId);
    expect(copied.status).toBe('draft');
    expect(copied.activeVersionId).toBe(null);
    expect(copied.slug).not.toBe(form.slug);
    expect(copied.name).toBe('Worth copying copy');
    const definition = copied.definition as { pages: { questions: { id: string }[] }[] };
    expect(definition.pages[0]!.questions.map((q) => q.id)).toEqual([qid('name')]);
  });

  it('archives a form and brings it back closed', async () => {
    const form = await withQuestion('Out of season');
    await run(
      formPublish,
      { workspaceId: wsId, formId: form.formId, baseRevision: form.revision },
      owner,
    );
    expect((await run(formArchive, { workspaceId: wsId, formId: form.formId }, owner)).status).toBe(
      'archived',
    );
    await expectHfos(
      () => run(formRename, { workspaceId: wsId, formId: form.formId, name: 'Nope' }, owner),
      'form_archived',
      409,
    );
    expect((await run(formRestore, { workspaceId: wsId, formId: form.formId }, owner)).status).toBe(
      'closed',
    );
  });

  it('puts an old version back as the draft without making it live', async () => {
    const form = await withQuestion('Changed my mind');
    await run(
      formPublish,
      { workspaceId: wsId, formId: form.formId, baseRevision: form.revision },
      owner,
    );
    const saved = await run(
      formSaveDraft,
      {
        workspaceId: wsId,
        formId: form.formId,
        baseRevision: form.revision,
        ops: [{ op: 'delete_question', questionId: qid('name') }],
      },
      owner,
    );
    const restored = await run(
      formRestoreVersion,
      { workspaceId: wsId, formId: form.formId, version: 1, baseRevision: saved.revision },
      owner,
    );
    expect(restored.changed).toBe(true);
    expect(restored.changes).toEqual(['Put version 1 back']);
    const after = await row(form.formId);
    const definition = after.definition as { pages: { questions: { id: string }[] }[] };
    expect(definition.pages[0]!.questions.map((q) => q.id)).toEqual([qid('name')]);
    // Still on version 1 until somebody publishes again.
    expect(after.status).toBe('live');
  });
});
