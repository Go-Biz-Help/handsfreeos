/**
 * The public form page, end to end through the worker: opening a form nobody is signed in for, filling it
 * in, sending it, and what a robot or a stranger gets instead.
 */
import {
  executeCommand,
  formCreate,
  formPublish,
  formSaveDraft,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { fakeBotCheck } from '../src/booking/bot-check';
import { buildHttpServer } from '../src/http/server';
import { admin, errorOf, get, makeWorld, post, type World } from './booking-world';

let w: World;
let slug: string;

const actorOf = (): HumanActor => ({
  type: 'human',
  userId: w.owner.id,
  email: w.owner.email,
  claims: w.owner.claims,
});

const run = <I extends z.ZodType, O extends z.ZodType>(cmd: CommandDef<I, O>, input: unknown) =>
  executeCommand(testDbs().api.db, cmd, input, actorOf(), {
    correlationId: randomUUID(),
    channel: 'test',
  }).then((r) => r.output);

const qid = (name: string) => `q_${name.padEnd(8, '0').slice(0, 8)}`;

beforeAll(async () => {
  w = await makeWorld('pubform');
  const created = await run(formCreate, { workspaceId: w.workspaceId, name: 'Quote request' });
  slug = created.slug;
  const [row] = await rows<{ definition: { pages: { id: string }[] } }>(
    admin(),
    sql`select definition from app.forms where id = ${created.formId}`,
  );
  const pageId = row!.definition.pages[0]!.id;
  const add = (question: Record<string, unknown>) => ({
    op: 'add_question',
    pageId,
    index: null,
    question,
  });
  const saved = await run(formSaveDraft, {
    workspaceId: w.workspaceId,
    formId: created.formId,
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
      add({
        id: qid('phone'),
        type: 'phone',
        title: 'Your phone',
        required: true,
        mapTo: 'person.phone',
        config: {},
      }),
      add({ id: qid('dog'), type: 'yes_no', title: 'Any dogs on the property?', config: {} }),
      add({
        id: qid('breed'),
        type: 'short_text',
        title: 'What breed?',
        config: {},
        showIf: {
          conditions: [
            { source: { kind: 'question', questionId: qid('dog') }, op: 'is', value: 'yes' },
          ],
        },
      }),
    ],
  });
  await run(formPublish, {
    workspaceId: w.workspaceId,
    formId: created.formId,
    baseRevision: saved.revision,
  });
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

const formUrl = (extra = '') => `/public/form/${w.site}/${slug}${extra}`;

describe('opening one', () => {
  it('hands the page the published form and counts the visit', async () => {
    const res = await get(w, formUrl());
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      definition: { title: string; pages: { questions: unknown[] }[] };
      closed: boolean;
    };
    expect(body.closed).toBe(false);
    expect(body.definition.pages[0]!.questions).toHaveLength(4);
    const [day] = await rows<{ views: number }>(
      admin(),
      sql`select views from app.form_days where day = current_date
          and form_id = (select id from app.forms
            where slug = ${slug} and workspace_id = ${w.workspaceId})`,
    );
    expect(Number(day!.views)).toBeGreaterThan(0);
  });

  it('is a plain 404 for an address with no form at it', async () => {
    expect((await get(w, `/public/form/${w.site}/nothing-here`)).statusCode).toBe(404);
  });

  /**
   * `private.form_route` left `embed_origins` out of its `returns table (…)`, so the page always read `undefined`
   * and its frame rule stayed at `frame-ancestors 'self'` — a business that listed its own website still had the
   * browser refuse the iframe. Nothing caught it because nothing asserted the value.
   */
  it('hands back the sites allowed to embed it', async () => {
    await admin().execute(
      sql`update app.forms set embed_origins = array['https://example.com']
          where slug = ${slug} and workspace_id = ${w.workspaceId}`,
    );
    const res = await get(w, formUrl());
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { embedOrigins: string[] }).embedOrigins).toEqual([
      'https://example.com',
    ]);
  });
});

describe('filling it in', () => {
  it('starts a sheet, saves as they go, and sends', async () => {
    const started = (await post(w, formUrl('/start'), {}).then((r) => r.json())) as {
      responseId: string;
      token: string;
      canResume: boolean;
    };
    expect(started.token).toBeTruthy();
    expect(started.canResume).toBe(true);

    const saved = await post(w, formUrl(`/${started.responseId}/save`), {
      token: started.token,
      answers: { [qid('name')]: 'Rosa' },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const sent = await post(w, formUrl(`/${started.responseId}/submit`), {
      token: started.token,
      answers: { [qid('name')]: 'Rosa Herrera', [qid('phone')]: '(512) 555-0401' },
      smsConsent: true,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const body = sent.json() as { headline: string; dueCents: number };
    expect(body.headline).toBeTruthy();
    expect(body.dueCents).toBe(0);
    const [person] = await rows<{ first_name: string; sms_consent: string }>(
      admin(),
      sql`select first_name, sms_consent from app.people
          where workspace_id = ${w.workspaceId} and phone_e164 = '+15125550401'`,
    );
    expect(person!.first_name).toBe('Rosa');
    expect(person!.sms_consent).toBe('opted_in');
  });

  it('refuses to write to a sheet without its key', async () => {
    const started = (await post(w, formUrl('/start'), {}).then((r) => r.json())) as {
      responseId: string;
    };
    const res = await post(w, formUrl(`/${started.responseId}/submit`), {
      token: 'x'.repeat(32),
      answers: { [qid('name')]: 'Somebody else', [qid('phone')]: '(512) 555-0402' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('says what is missing rather than taking half an answer', async () => {
    const started = (await post(w, formUrl('/start'), {}).then((r) => r.json())) as {
      responseId: string;
      token: string;
    };
    const res = await post(w, formUrl(`/${started.responseId}/submit`), {
      token: started.token,
      answers: { [qid('name')]: 'No phone here' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { rule: string; details: { problems: unknown[] } } };
    expect(body.error.rule).toBe('form_answers_invalid');
    expect(body.error.details.problems).toHaveLength(1);
  });

  it('drops an answer to a question that was never shown', async () => {
    const started = (await post(w, formUrl('/start'), {}).then((r) => r.json())) as {
      responseId: string;
      token: string;
    };
    await post(w, formUrl(`/${started.responseId}/submit`), {
      token: started.token,
      answers: {
        [qid('name')]: 'Pat',
        [qid('phone')]: '(512) 555-0403',
        [qid('dog')]: 'no',
        [qid('breed')]: 'Collie',
      },
    });
    const answers = await rows<{ question_id: string }>(
      admin(),
      sql`select question_id from app.form_answers where response_id = ${started.responseId}`,
    );
    expect(answers.map((a) => a.question_id)).not.toContain(qid('breed'));
  });

  it('tells a robot the same thing it tells a person, and records nothing', async () => {
    const before = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.form_responses
          where workspace_id = ${w.workspaceId} and status = 'completed'`,
    );
    const started = (await post(w, formUrl('/start'), { website: 'https://spam.example' }).then(
      (r) => r.json(),
    )) as { responseId: string; token: string };
    expect(started.token).toBe('nothing-was-written-for-this-one');
    const sent = await post(w, formUrl(`/${started.responseId}/submit`), {
      token: started.token,
      answers: { [qid('name')]: 'Robot', [qid('phone')]: '(512) 555-0404' },
      website: 'https://spam.example',
    });
    expect(sent.statusCode).toBe(200);
    const after = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.form_responses
          where workspace_id = ${w.workspaceId} and status = 'completed'`,
    );
    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count));
  });

  it('asks for the bot check before sending, when it is on', async () => {
    const guarded: World = {
      ...w,
      app: await buildHttpServer({
        ...w.s,
        httpDb: testDbs().worker.db,
        verifyToken: null,
        webOrigins: ['http://localhost:3000'],
        forms: { botCheck: fakeBotCheck() },
      }),
    };
    try {
      const page = (await get(guarded, formUrl())).json() as { botCheck: unknown };
      expect(page.botCheck).toEqual({ siteKey: 'fake-site-key' });
      const started = (await post(guarded, formUrl('/start'), {}).then((r) => r.json())) as {
        responseId: string;
        token: string;
      };
      const send = (turnstileToken?: string) =>
        post(guarded, formUrl(`/${started.responseId}/submit`), {
          token: started.token,
          answers: { [qid('name')]: 'Bot', [qid('phone')]: '(512) 555-0405' },
          ...(turnstileToken ? { turnstileToken } : {}),
        });
      for (const refused of [await send(), await send('nope')]) {
        expect(refused.statusCode).toBe(400);
        expect(errorOf(refused).rule).toBe('bot_check_failed');
      }
      expect((await send('pass')).statusCode).toBe(200);
    } finally {
      await guarded.app.close();
    }
  });
});

describe('coming back to one', () => {
  it('finds the sheet a “finish it later” link names', async () => {
    const started = (await post(w, formUrl('/start'), {}).then((r) => r.json())) as {
      responseId: string;
      token: string;
    };
    await post(w, formUrl(`/${started.responseId}/save`), {
      token: started.token,
      answers: { [qid('name')]: 'Half done' },
    });
    const res = await get(w, formUrl(`/resume/${started.token}`));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { responseId: string; answers: Record<string, unknown> };
    expect(body.responseId).toBe(started.responseId);
    expect(body.answers[qid('name')]).toBe('Half done');
    expect((await get(w, formUrl('/resume/not-a-real-token'))).statusCode).toBe(404);
  });
});
