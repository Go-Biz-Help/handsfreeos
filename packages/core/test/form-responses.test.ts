/**
 * Filling a form in, on the local database: what a half-finished one keeps, what a sent one does to the
 * customer, the lead and the invented fields, what it refuses, and the answers a hidden question never
 * gets to record.
 */
import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { randomUUID } from 'node:crypto';
import {
  customFields,
  formAnswers,
  formDays,
  formResponses,
  forms,
  leads,
  people,
  tasks,
  workspaceMemberships,
} from '@hfos/db/schema';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formCreate,
  formPublish,
  formSaveDraft,
  organizationCreate,
  formResponseDelete,
  formResponseExport,
  formResponseList,
  formResponseRecord,
  formResponseSave,
  formResponseStart,
  formResponseSubmit,
} from '../src/server';
import { admin, ask, expectHfos, run, runSystem, type Scope } from './calendar-helpers';

let owner: TestUser;
let wsId: string, orgId: string;
let scope: Scope;
let pipelineId: string, stageId: string;
let gateCodeFieldId: string;

beforeAll(async () => {
  owner = await createTestUser('form-resp-owner', { fullName: 'Dale Owner' });
  const org = await run(organizationCreate, { businessName: 'Form Responses Co' }, owner);
  wsId = org.workspaceId;
  orgId = org.organizationId;
  scope = { workspaceId: wsId, organizationId: orgId };
  const [pipeline] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.pipelines where workspace_id = ${wsId} order by position limit 1`,
  );
  pipelineId = pipeline!.id;
  const [stage] = await rows<{ id: string }>(
    admin(),
    sql`select id from app.pipeline_stages where pipeline_id = ${pipelineId} order by position limit 1`,
  );
  stageId = stage!.id;
  const [field] = await admin()
    .insert(customFields)
    .values({
      workspaceId: wsId,
      entity: 'person',
      key: 'gate_code',
      label: 'Gate code',
      type: 'text',
    })
    .returning({ id: customFields.id });
  gateCodeFieldId = field!.id;
});
afterAll(closeTestDbs);

// ---- Helpers ----

const qid = (name: string) => `q_${name.padEnd(8, '0').slice(0, 8)}`;

const question = (name: string, extra: Record<string, unknown>) => ({
  id: qid(name),
  title: name,
  config: {},
  ...extra,
});

const addQuestion = (pageId: string, q: Record<string, unknown>) => ({
  op: 'add_question',
  pageId,
  index: null,
  question: q,
});

const formRow = async (formId: string) => {
  const [r] = await admin().select().from(forms).where(eq(forms.id, formId));
  return r!;
};

const responseRow = async (responseId: string) => {
  const [r] = await admin().select().from(formResponses).where(eq(formResponses.id, responseId));
  return r!;
};

/** A published form: name, email, phone, a hidden follow-up, and a gate code that fills the invented field. */
async function publishedForm(
  name: string,
  extraOps: Record<string, unknown>[] = [],
  settings: Record<string, unknown> = {},
) {
  const created = await run(formCreate, { workspaceId: wsId, name }, owner);
  const pageId = ((await formRow(created.formId)).definition as { pages: { id: string }[] })
    .pages[0]!.id;
  const saved = await run(
    formSaveDraft,
    {
      workspaceId: wsId,
      formId: created.formId,
      baseRevision: 1,
      ops: [
        addQuestion(
          pageId,
          question('Your name', {
            id: qid('name'),
            type: 'short_text',
            required: true,
            mapTo: 'person.first_name',
          }),
        ),
        addQuestion(
          pageId,
          question('Your email', { id: qid('email'), type: 'email', mapTo: 'person.email' }),
        ),
        addQuestion(
          pageId,
          question('Your phone', { id: qid('phone'), type: 'phone', mapTo: 'person.phone' }),
        ),
        ...(Object.keys(settings).length ? [{ op: 'set_settings', patch: settings }] : []),
        ...extraOps.map((op) => ({ ...op, pageId: op.pageId ?? pageId })),
      ],
    },
    owner,
  );
  await run(
    formPublish,
    { workspaceId: wsId, formId: created.formId, baseRevision: saved.revision },
    owner,
  );
  return { formId: created.formId, pageId };
}

const start = (formId: string, source = 'link') =>
  runSystem(formResponseStart, { workspaceId: wsId, formId, source }, scope);

interface Started {
  readonly responseId: string;
  readonly token: string;
}

const submit = (started: Started, answers: Record<string, unknown>, smsConsent = false) =>
  runSystem(
    formResponseSubmit,
    {
      workspaceId: wsId,
      responseId: started.responseId,
      token: started.token,
      answers,
      smsConsent,
    },
    scope,
  );

// ---- Tests ----

describe('starting one', () => {
  it('hands back a token to come back with, and counts the start', async () => {
    const form = await publishedForm('Quote request');
    const started = await start(form.formId);
    expect(started.token).toBeTruthy();
    expect(started.canResume).toBe(true);
    expect((await responseRow(started.responseId)).status).toBe('in_progress');
    const [day] = await rows<{ starts: number }>(
      admin(),
      sql`select starts from app.form_days where form_id = ${form.formId} and day = current_date`,
    );
    expect(Number(day!.starts)).toBe(1);
  });

  it('keeps no way back into an anonymous form', async () => {
    const form = await publishedForm('Honest feedback', [], { identity: 'anonymous' });
    // The key still exists — the page needs it — but no "carry on later" link is offered.
    const started = await start(form.formId);
    expect(started.token).toBeTruthy();
    expect(started.canResume).toBe(false);
  });

  it('will not start on a form that is closed', async () => {
    const form = await publishedForm('Closed for the season');
    await admin().update(forms).set({ status: 'closed' }).where(eq(forms.id, form.formId));
    await expectHfos(() => start(form.formId), 'form_closed', 409);
  });
});

describe('saving as they go', () => {
  it('keeps the answers without touching the business’s records', async () => {
    const form = await publishedForm('Half done');
    const started = await start(form.formId);
    const saved = await runSystem(
      formResponseSave,
      {
        workspaceId: wsId,
        responseId: started.responseId,
        token: started.token,
        answers: { [qid('name')]: 'Dale' },
      },
      scope,
    );
    expect(saved.progress).toBeGreaterThan(0);
    const row = await responseRow(started.responseId);
    expect(row.status).toBe('in_progress');
    expect(row.personId).toBe(null);
  });
});

describe('sending it', () => {
  it('makes the customer, fills in what they said, and records every answer', async () => {
    const form = await publishedForm('New customer');
    const started = await start(form.formId);
    const sent = await submit(started, {
      [qid('name')]: 'Rosa Herrera',
      [qid('email')]: 'rosa@example.com',
      [qid('phone')]: '(512) 555-0134',
    });
    expect(sent.personId).toBeTruthy();
    const [person] = await admin().select().from(people).where(eq(people.id, sent.personId!));
    expect(person!.firstName).toBe('Rosa');
    expect(person!.lastName).toBe('Herrera');
    expect(person!.email).toBe('rosa@example.com');
    const answers = await admin()
      .select()
      .from(formAnswers)
      .where(eq(formAnswers.responseId, started.responseId));
    expect(answers).toHaveLength(3);
    expect(answers.find((a) => a.questionId === qid('name'))!.questionTitle).toBe('Your name');
    const row = await responseRow(started.responseId);
    expect(row.status).toBe('completed');
    expect(row.resultId).toMatch(/^r_/);
    expect(Number((await formRow(form.formId)).responseCount)).toBe(1);
  });

  it('finds the customer again next time instead of making a second one', async () => {
    const form = await publishedForm('Second visit');
    const first = await submit(await start(form.formId), {
      [qid('name')]: 'Dale',
      [qid('phone')]: '(512) 555-0199',
    });
    const second = await submit(await start(form.formId), {
      [qid('name')]: 'Dale',
      [qid('phone')]: '(512) 555-0199',
    });
    expect(second.personId).toBe(first.personId);
  });

  it('never rubs out what the business already knows', async () => {
    const form = await publishedForm('Careful with that');
    const first = await submit(await start(form.formId), {
      [qid('name')]: 'Mina',
      [qid('email')]: 'mina@example.com',
      [qid('phone')]: '(512) 555-0111',
    });
    await submit(await start(form.formId), {
      [qid('name')]: 'Mina',
      [qid('phone')]: '(512) 555-0111',
    });
    const [person] = await admin().select().from(people).where(eq(people.id, first.personId!));
    expect(person!.email).toBe('mina@example.com');
  });

  it('fills in a field the business invented', async () => {
    const form = await publishedForm('Gate code', [
      {
        op: 'add_question',
        index: null,
        question: question('Gate code', {
          id: qid('gate'),
          type: 'short_text',
          mapTo: `custom:${gateCodeFieldId}`,
        }),
      },
    ]);
    const sent = await submit(await start(form.formId), {
      [qid('name')]: 'Ivan',
      [qid('phone')]: '(512) 555-0122',
      [qid('gate')]: '1234#',
    });
    const [person] = await admin().select().from(people).where(eq(people.id, sent.personId!));
    expect((person!.custom as Record<string, unknown>)[gateCodeFieldId]).toBe('1234#');
  });

  it('opens a lead where the form says, with the calculation as its value', async () => {
    const form = await publishedForm('Instant quote', [
      {
        op: 'add_question',
        index: null,
        question: question('Square feet', {
          id: qid('sqft'),
          type: 'number',
          config: { min: null, max: null, decimals: 0, unit: 'sq ft', placeholder: '' },
        }),
      },
      {
        op: 'add_calculation',
        index: null,
        calculation: {
          id: 'k_quote000',
          name: 'Quote',
          terms: [
            {
              factors: [
                { kind: 'question', questionId: qid('sqft') },
                { kind: 'number', value: 3.5 },
              ],
            },
            { factors: [{ kind: 'number', value: 75 }] },
          ],
          format: 'money',
        },
      },
      {
        op: 'set_on_submit',
        patch: {
          lead: { pipelineId, stageId, title: 'Quote', valueFrom: 'k_quote000' },
        },
      },
    ]);
    const sent = await submit(await start(form.formId), {
      [qid('name')]: 'Nadia',
      [qid('phone')]: '(512) 555-0177',
      [qid('sqft')]: 1200,
    });
    expect(sent.calculations['k_quote000']).toBe(4275);
    expect(sent.leadId).toBeTruthy();
    const [lead] = await admin().select().from(leads).where(eq(leads.id, sent.leadId!));
    expect(Number(lead!.valueCents)).toBe(427_500);
  });

  it('opens a lead where Lead intake points forms, when the form names no pipeline (M14)', async () => {
    // The row every form built here files under: nothing has touched it, so it runs on the defaults.
    const form = await publishedForm('Ask us anything');
    const sent = await submit(await start(form.formId), {
      [qid('name')]: 'Wes',
      [qid('phone')]: '(512) 555-0161',
    });
    expect(sent.leadId).toBeTruthy();
    const [lead] = await admin().select().from(leads).where(eq(leads.id, sent.leadId!));
    // lead.create's own fallback: the business's first pipeline, its first open stage.
    expect(lead!.pipelineId).toBe(pipelineId);
    const [source] = await rows<{ day_count: number; kind: string }>(
      admin(),
      sql`select day_count, kind::text as kind from app.intake_sources
          where workspace_id = ${wsId} and kind = 'website_form' and public_key is null`,
    );
    expect(source).toMatchObject({ kind: 'website_form' });
    expect(Number(source!.day_count)).toBeGreaterThan(0);
  });

  it('opens no lead at all once website forms are turned off in Lead intake (M14)', async () => {
    await rows(
      admin(),
      sql`update app.intake_sources set active = false
          where workspace_id = ${wsId} and kind = 'website_form' and public_key is null`,
    );
    const form = await publishedForm('Quiet form');
    const sent = await submit(await start(form.formId), {
      [qid('name')]: 'Quiet',
      [qid('phone')]: '(512) 555-0162',
    });
    // The answers are still recorded and the customer still made; only the lead waits for a person.
    expect(sent.leadId).toBeNull();
    expect(sent.personId).toBeTruthy();
    await rows(
      admin(),
      sql`update app.intake_sources set active = true
          where workspace_id = ${wsId} and kind = 'website_form' and public_key is null`,
    );
  });

  it('drops an answer to a question they were never shown', async () => {
    const form = await publishedForm('Dogs', [
      {
        op: 'add_question',
        index: null,
        question: question('Do you have a dog?', { id: qid('dog'), type: 'yes_no' }),
      },
      {
        op: 'add_question',
        index: null,
        question: question('What breed?', {
          id: qid('breed'),
          type: 'short_text',
          showIf: {
            conditions: [
              { source: { kind: 'question', questionId: qid('dog') }, op: 'is', value: 'yes' },
            ],
          },
        }),
      },
    ]);
    const started = await start(form.formId);
    await submit(started, {
      [qid('name')]: 'Pat',
      [qid('phone')]: '(512) 555-0188',
      [qid('dog')]: 'no',
      [qid('breed')]: 'Collie',
    });
    const row = await responseRow(started.responseId);
    expect((row.answers as Record<string, unknown>)[qid('breed')]).toBeUndefined();
    const answers = await admin()
      .select()
      .from(formAnswers)
      .where(
        and(
          eq(formAnswers.responseId, started.responseId),
          eq(formAnswers.questionId, qid('breed')),
        ),
      );
    expect(answers).toHaveLength(0);
  });

  it('refuses answers that do not stand up, naming the question', async () => {
    const form = await publishedForm('Picky');
    const started = await start(form.formId);
    const error = await expectHfos(
      () => submit(started, { [qid('email')]: 'not-an-email' }),
      'form_answers_invalid',
      400,
    );
    const problems = (error.details as { problems: { questionId: string; message: string }[] })
      .problems;
    expect(problems.map((p) => p.questionId)).toContain(qid('email'));
    expect(problems.map((p) => p.questionId)).toContain(qid('name'));
  });

  it('insists on a way to reach them when the form says it must', async () => {
    const form = await publishedForm('Who are you');
    const started = await start(form.formId);
    await expectHfos(() => submit(started, { [qid('name')]: 'Anon' }), 'form_needs_identity', 400);
  });

  it('records nobody at all on an anonymous form', async () => {
    const form = await publishedForm('Anonymous survey', [], { identity: 'anonymous' });
    const sent = await submit(await start(form.formId), {
      [qid('name')]: 'Whoever',
      [qid('email')]: 'whoever@example.com',
    });
    expect(sent.personId).toBe(null);
    expect((await responseRow(sent.responseId)).personId).toBe(null);
  });

  it('lets a customer answer again, unless the form says once only', async () => {
    const open = await publishedForm('Book us again');
    const answer = (formId: string) =>
      start(formId).then((s) =>
        submit(s, { [qid('name')]: 'Ada', [qid('phone')]: '(512) 555-0222' }),
      );
    await answer(open.formId);
    await answer(open.formId);
    expect(Number((await formRow(open.formId)).responseCount)).toBe(2);

    const once = await publishedForm('One each', [], { oneResponsePerPerson: true });
    await answer(once.formId);
    await expectHfos(() => answer(once.formId), 'already_answered', 409);
  });

  it('will not take the same sheet twice', async () => {
    const form = await publishedForm('Once only');
    const started = await start(form.formId);
    await submit(started, { [qid('name')]: 'Sam', [qid('phone')]: '(512) 555-0155' });
    await expectHfos(() => submit(started, { [qid('name')]: 'Sam again' }), 'response_sent', 409);
  });

  it('scores a quiz and lands them on the result their score earns', async () => {
    const form = await publishedForm('Safety quiz', [
      {
        op: 'add_question',
        index: null,
        question: question('Which is the shut-off?', {
          id: qid('shutoff'),
          type: 'choice',
          config: {
            choices: [
              { id: 'c_red00000', label: 'The red one', correct: true, points: 1 },
              { id: 'c_blue0000', label: 'The blue one' },
            ],
          },
        }),
      },
      { op: 'set_form', patch: { mode: 'quiz' } },
      { op: 'set_scoring', patch: { enabled: true, passPercent: 100 } },
      {
        op: 'add_result',
        index: 0,
        result: {
          id: 'r_passed00',
          name: 'Passed',
          headline: 'You passed',
          showIf: { conditions: [{ source: { kind: 'percent' }, op: 'gte', value: 100 }] },
        },
      },
    ]);
    const passed = await submit(await start(form.formId), {
      [qid('name')]: 'Quiz taker',
      [qid('phone')]: '(512) 555-0166',
      [qid('shutoff')]: 'c_red00000',
    });
    expect(passed.scorePercent).toBe(100);
    expect(passed.passed).toBe(true);
    expect(passed.resultId).toBe('r_passed00');
    const failed = await submit(await start(form.formId), {
      [qid('name')]: 'Quiz taker',
      [qid('phone')]: '(512) 555-0166',
      [qid('shutoff')]: 'c_blue0000',
    });
    expect(failed.passed).toBe(false);
    expect(failed.resultId).not.toBe('r_passed00');
    // Reading them back, a wrong answer is 0%, not "no score": there was a point on offer.
    const { items } = await ask(
      formResponseList,
      { workspaceId: wsId, formId: form.formId },
      owner,
    );
    expect(items.map((r) => r.scorePercent)).toEqual([0, 100]);
    const sheet = await ask(formResponseExport, { workspaceId: wsId, formId: form.formId }, owner);
    expect(sheet.rows.map((r) => [r.scorePercent, r.passed])).toEqual([
      [0, false],
      [100, true],
    ]);
  });

  it('ticks the texting box only when they ticked it', async () => {
    const form = await publishedForm('Texts please');
    const sent = await submit(
      await start(form.formId),
      { [qid('name')]: 'Tess', [qid('phone')]: '(512) 555-0144' },
      true,
    );
    const [person] = await admin().select().from(people).where(eq(people.id, sent.personId!));
    expect(person!.smsConsent).toBe('opted_in');
    expect(person!.smsConsentSource).toContain('Texts please');
  });
});

describe('filled in on the phone', () => {
  /**
   * `form_response.record` runs as the person holding the phone, not as the worker, so every write it and
   * `form_response.submit` make has to be one a teammate's own session may make. Nothing ran it against a
   * database until the phone app's flows did, and every one was refused.
   */
  let teammate: TestUser;
  beforeAll(async () => {
    teammate = await createTestUser('form-resp-member', { fullName: 'Priya Member' });
    await admin()
      .insert(workspaceMemberships)
      .values({ workspaceId: wsId, userId: teammate.id, role: 'member' });
  });

  const record = (formId: string, answers: Record<string, unknown>, id = randomUUID()) =>
    run(formResponseRecord, { workspaceId: wsId, id, formId, answers, smsConsent: true }, teammate);

  it('a teammate sends one for a customer, and it does everything a sent form does', async () => {
    const form = await publishedForm(
      'Walk-in',
      [
        {
          op: 'add_question',
          index: null,
          question: question('Gate code', {
            id: qid('gate'),
            type: 'short_text',
            mapTo: `custom:${gateCodeFieldId}`,
          }),
        },
        {
          op: 'set_on_submit',
          patch: { task: { title: 'Call them back', dueInDays: 1 } },
        },
      ],
      { oneResponsePerPerson: true },
    );
    const id = randomUUID();
    const sent = await record(
      form.formId,
      { [qid('name')]: 'Lupe', [qid('phone')]: '(512) 555-0241', [qid('gate')]: '4455' },
      id,
    );
    expect(sent.responseId).toBe(id);

    const row = await responseRow(id);
    expect(row.status).toBe('completed');
    expect(row.source).toBe('app');
    // Nobody comes back to it on a link, so it has no key.
    expect(row.resumeTokenHash).toBeNull();
    expect(row.personId).toBe(sent.personId);

    // The customer, what they told us, and the texting box they ticked.
    const [person] = await admin().select().from(people).where(eq(people.id, sent.personId!));
    expect(person!.firstName).toBe('Lupe');
    expect((person!.custom as Record<string, unknown>)[gateCodeFieldId]).toBe('4455');
    expect(person!.smsConsent).toBe('opted_in');
    // A plain form opens a lead where Lead intake points it, and the task the form asks for.
    expect(sent.leadId).toBeTruthy();
    const [task] = await admin().select().from(tasks).where(eq(tasks.personId, sent.personId!));
    expect(task!.title).toBe('Call them back');

    // Every answer, and the form's own counts.
    const answers = await admin().select().from(formAnswers).where(eq(formAnswers.responseId, id));
    expect(answers).toHaveLength(3);
    expect(Number((await formRow(form.formId)).responseCount)).toBe(1);
    const [day] = await admin().select().from(formDays).where(eq(formDays.formId, form.formId));
    expect(day!.completions).toBe(1);
  });

  it('sent twice with the same id, it is still one answer sheet', async () => {
    const form = await publishedForm('Sent twice');
    const id = randomUUID();
    const answers = { [qid('name')]: 'Theo', [qid('phone')]: '(512) 555-0242' };
    const first = await record(form.formId, answers, id);
    const again = await record(form.formId, answers, id);
    expect(again.responseId).toBe(first.responseId);
    expect(again.personId).toBe(first.personId);
    expect(Number((await formRow(form.formId)).responseCount)).toBe(1);
  });

  it('an anonymous survey keeps nobody', async () => {
    const form = await publishedForm('Rate the visit', [], { identity: 'anonymous' });
    const sent = await record(form.formId, { [qid('name')]: 'Whoever' });
    expect(sent.personId).toBeNull();
    expect((await responseRow(sent.responseId)).status).toBe('completed');
  });
});

describe('a form that asks for money', () => {
  it('raises an invoice for what it asks, and points at it', async () => {
    const form = await publishedForm('Booking deposit', [
      {
        op: 'add_question',
        index: null,
        question: {
          id: qid('pay'),
          type: 'payment',
          title: 'Deposit',
          config: {
            amount: { kind: 'fixed', cents: 7500 },
            description: 'Booking deposit',
          },
        },
      },
    ]);
    const sent = await submit(await start(form.formId), {
      [qid('name')]: 'Wendy',
      [qid('phone')]: '(512) 555-0211',
    });
    expect(sent.dueCents).toBe(7500);
    expect(sent.invoiceId).toBeTruthy();
    const [invoice] = await rows<{ total_cents: number; status: string }>(
      admin(),
      sql`select total_cents, status::text as status from app.invoices where id = ${sent.invoiceId!}`,
    );
    expect(Number(invoice!.total_cents)).toBe(7500);
    // A draft: nobody is charged until the business sends it and they pay on the money page.
    expect(invoice!.status).toBe('draft');
  });

  it('asks for nothing when the form has no payment question', async () => {
    const form = await publishedForm('No money here');
    const sent = await submit(await start(form.formId), {
      [qid('name')]: 'Free',
      [qid('phone')]: '(512) 555-0212',
    });
    expect(sent.dueCents).toBe(0);
    expect(sent.invoiceId).toBe(null);
  });
});

describe('afterwards', () => {
  it('deletes one when somebody asks to be forgotten', async () => {
    const form = await publishedForm('Forget me');
    const started = await start(form.formId);
    await submit(started, { [qid('name')]: 'Gone', [qid('phone')]: '(512) 555-0133' });
    await run(formResponseDelete, { workspaceId: wsId, responseId: started.responseId }, owner);
    expect(
      await admin().select().from(formResponses).where(eq(formResponses.id, started.responseId)),
    ).toHaveLength(0);
    expect(Number((await formRow(form.formId)).responseCount)).toBe(0);
  });
});
