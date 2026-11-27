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

/** How many times today's tally says the form was looked at. */
const lookedToday = async () => {
  const [day] = await rows<{ views: number }>(
    admin(),
    sql`select views from app.form_days where day = current_date
        and form_id = (select id from app.forms
          where slug = ${slug} and workspace_id = ${w.workspaceId})`,
  );
  return Number(day?.views ?? 0);
};

describe('opening one', () => {
  /**
   * Reading the form used to count a visit, so the web could never keep a copy of it. Now the web keeps one for
   * half a minute (the speed audit, Nov 2026), and reading it counts nobody.
   */
  it('hands the page the published form, and reading it counts nobody', async () => {
    const before = await lookedToday();
    const res = await get(w, formUrl());
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      definition: { title: string; pages: { questions: unknown[] }[] };
      closed: boolean;
    };
    expect(body.closed).toBe(false);
    expect(body.definition.pages[0]!.questions).toHaveLength(4);
    expect(await lookedToday()).toBe(before);
  });

  it('counts a visit each time the page says somebody opened it', async () => {
    const before = await lookedToday();
    const first = await post(w, formUrl('/view'), {});
    expect(first.statusCode, first.body).toBe(200);
    expect((await post(w, formUrl('/view'), {})).statusCode).toBe(200);
    expect(await lookedToday()).toBe(before + 2);
  });

  it('counts nobody at an address with no form at it', async () => {
    expect((await post(w, `/public/form/${w.site}/nothing-here/view`, {})).statusCode).toBe(404);
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

  /** A form's design starts from the business's colour and logo (forms/design.ts), so the page needs them. */
  it('hands back the business’s colour for the form’s design to start from', async () => {
    await admin().execute(
      sql`update app.workspaces set settings = settings || '{"look":{"color":{"hex":"#e85d04","from":"person","at":"2026-11-02T21:00:00.000Z"}}}'::jsonb
          where id = ${w.workspaceId}`,
    );
    const res = await get(w, formUrl());
    expect(res.statusCode, res.body).toBe(200);
    const { business } = res.json() as {
      business: { look: { color: string | null; logo: string | null } };
    };
    // With the brand kit's font and corners, unset until someone picks them.
    expect(business.look).toEqual({ color: '#e85d04', logo: null, font: null, corners: null });
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

  it('shows a separate box for offers once the business texts offers, and keeps that answer apart', async () => {
    const offersOf = async () =>
      ((await get(w, formUrl())).json() as { offersConsent: { title: string } | null })
        .offersConsent;
    expect(await offersOf()).toBeNull();
    // A texting registration for customer care and the odd promotion: the carriers check for the second box.
    await admin().execute(
      sql`insert into app.telephony_registrations (workspace_id, kind, status, submission, submitted_at)
          values (${w.workspaceId}, 'toll_free_verification', 'submitted',
                  ${JSON.stringify({ useCase: 'mixed' })}::jsonb, now())`,
    );
    expect((await offersOf())?.title).toMatch(/offers/i);

    const started = (await post(w, formUrl('/start'), {}).then((r) => r.json())) as {
      responseId: string;
      token: string;
    };
    const sent = await post(w, formUrl(`/${started.responseId}/submit`), {
      token: started.token,
      answers: { [qid('name')]: 'Lena Ortiz', [qid('phone')]: '(512) 555-0402' },
      smsConsent: false,
      offersConsent: true,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const [person] = await rows<{ sms_consent: string; offers_consent: string; source: string }>(
      admin(),
      sql`select sms_consent, offers_consent, offers_consent_source as source from app.people
          where workspace_id = ${w.workspaceId} and phone_e164 = '+15125550402'`,
    );
    // Offers yes, texts about their own job not asked: two answers, kept apart.
    expect(person).toMatchObject({ sms_consent: 'unknown', offers_consent: 'opted_in' });
    expect(person!.source).toMatch(/^Form: /);

    // STOP wins: a customer who stopped texts isn't signed up for offers by ticking the box again.
    await admin().execute(
      sql`update app.people set sms_consent = 'opted_out', offers_consent = 'unknown'
          where workspace_id = ${w.workspaceId} and phone_e164 = '+15125550402'`,
    );
    const again = (await post(w, formUrl('/start'), {}).then((r) => r.json())) as {
      responseId: string;
      token: string;
    };
    await post(w, formUrl(`/${again.responseId}/submit`), {
      token: again.token,
      answers: { [qid('name')]: 'Lena Ortiz', [qid('phone')]: '(512) 555-0402' },
      offersConsent: true,
    });
    const after = await rows<{ offers_consent: string }>(
      admin(),
      sql`select offers_consent from app.people
          where workspace_id = ${w.workspaceId} and phone_e164 = '+15125550402'`,
    );
    expect(after.map((p) => p.offers_consent)).not.toContain('opted_in');
    await admin().execute(
      sql`delete from app.telephony_registrations where workspace_id = ${w.workspaceId}`,
    );
  });

  it('shows the OK to call box once the business asks for one, and keeps a yes with where it was ticked', async () => {
    const asks = (on: boolean) =>
      admin().execute(
        sql`update app.workspaces
            set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{automations}',
              coalesce(settings->'automations', '{}'::jsonb)
                || jsonb_build_object('calls', jsonb_build_object('askConsent', ${on}::boolean)))
            where id = ${w.workspaceId}`,
      );
    const boxOf = async () =>
      ((await get(w, formUrl())).json() as { callConsent: { title: string } | null }).callConsent;
    const send = async (callConsent: boolean) => {
      const started = (await post(w, formUrl('/start'), {}).then((r) => r.json())) as {
        responseId: string;
        token: string;
      };
      const sent = await post(w, formUrl(`/${started.responseId}/submit`), {
        token: started.token,
        answers: { [qid('name')]: 'Dale Ruiz', [qid('phone')]: '(512) 555-0403' },
        callConsent,
      });
      expect(sent.statusCode, sent.body).toBe(200);
      const [person] = await rows<{ consent: string; source: string | null; at: Date | null }>(
        admin(),
        sql`select call_consent as consent, call_consent_source as source, call_consent_at as at
            from app.people where workspace_id = ${w.workspaceId} and phone_e164 = '+15125550403'`,
      );
      return person!;
    };

    // Off to begin with: no box, and a tick sent anyway is a box nobody read.
    expect(await boxOf()).toBeNull();
    expect((await send(true)).consent).toBe('unknown');

    await asks(true);
    expect((await boxOf())?.title).toMatch(/OK to call/i);
    expect(await send(false)).toMatchObject({ consent: 'unknown' });
    const yes = await send(true);
    expect(yes).toMatchObject({ consent: 'opted_in', source: 'Form: Quote request' });
    expect(yes.at).not.toBeNull();

    // "Doesn't want calls" wins, as STOP does for texts.
    await admin().execute(
      sql`update app.people set call_consent = 'opted_out'
          where workspace_id = ${w.workspaceId} and phone_e164 = '+15125550403'`,
    );
    expect((await send(true)).consent).toBe('opted_out');
    await asks(false);
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

  it('keeps the ref the page was opened with on the sheet, and leaves anything else off', async () => {
    const refOf = async (ref: string) => {
      const started = (await post(w, formUrl('/start'), { ref }).then((r) => r.json())) as {
        responseId: string;
      };
      const [row] = await rows<{ link_ref: string | null }>(
        admin(),
        sql`select link_ref from app.form_responses where id = ${started.responseId}`,
      );
      return row?.link_ref;
    };
    expect(await refOf('or-demo_Abc123')).toBe('or-demo_Abc123');
    expect(await refOf('not a ref!')).toBeNull();
  });
});

describe('adding a file (product sellers, 5a)', () => {
  it('keeps its place, hands back a one-time link, checks what arrived, and sends it with the sheet', async () => {
    const created = await run(formCreate, { workspaceId: w.workspaceId, name: 'Custom order' });
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
          mapTo: 'person.phone',
          config: {},
        }),
        add({ id: qid('design'), type: 'file', title: 'Your design', config: { accept: 'image' } }),
      ],
    });
    await run(formPublish, {
      workspaceId: w.workspaceId,
      formId: created.formId,
      baseRevision: saved.revision,
    });
    const url = (extra: string) => `/public/form/${w.site}/${created.slug}${extra}`;
    const started = (await post(w, url('/start'), {}).then((r) => r.json())) as {
      responseId: string;
      token: string;
    };

    const refused = await post(w, url(`/${started.responseId}/uploads`), {
      token: started.token,
      questionId: qid('design'),
      name: 'quote.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
    });
    expect(refused.statusCode).toBe(422);
    expect(errorOf(refused).rule).toBe('form_file_type');

    const begun = await post(w, url(`/${started.responseId}/uploads`), {
      token: started.token,
      questionId: qid('design'),
      name: 'shirt front.png',
      mimeType: 'image/png',
      sizeBytes: 3000,
    });
    expect(begun.statusCode, begun.body).toBe(200);
    const { fileId, uploadUrl } = begun.json() as { fileId: string; uploadUrl: string };
    expect(uploadUrl).toBeTruthy();
    const [reserved] = await rows<{ object_path: string }>(
      admin(),
      sql`select object_path from app.files where id = ${fileId}`,
    );
    expect(reserved!.object_path).toContain(
      `/form/${created.formId}/responses/${started.responseId}/`,
    );

    // What the browser's PUT leaves in Storage.
    const objectPath = reserved!.object_path;
    await rows(
      admin(),
      sql`insert into storage.objects (bucket_id, name, metadata)
          values ('attachments', ${objectPath}, ${JSON.stringify({ size: 3000, mimetype: 'image/png' })}::jsonb)`,
    );
    const stranger = await post(w, url(`/${started.responseId}/uploads/${fileId}/confirm`), {
      token: 'not-the-key-for-this-sheet',
    });
    expect(stranger.statusCode).toBe(404);
    const confirmed = await post(w, url(`/${started.responseId}/uploads/${fileId}/confirm`), {
      token: started.token,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({ fileId, accepted: true, bytes: 3000 });

    const sent = await post(w, url(`/${started.responseId}/submit`), {
      token: started.token,
      answers: {
        [qid('name')]: 'Sherri',
        [qid('phone')]: '(512) 555-0477',
        [qid('design')]: [{ fileId, name: 'shirt front.png', bytes: 3000 }],
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const [copy] = await rows<{ name: string; record_type: string }>(
      admin(),
      sql`select f.name, f.record_type::text from app.files f
          join app.people p on p.id = f.record_id
          where f.workspace_id = ${w.workspaceId} and p.phone_e164 = '+15125550477'`,
    );
    expect(copy).toMatchObject({ name: 'shirt front.png', record_type: 'person' });
  });
});
