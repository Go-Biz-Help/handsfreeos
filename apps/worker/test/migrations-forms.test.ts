/**
 * Forms and the answers people gave them, on the real database.
 *
 * A form is the one thing in a CRM where the *record* and the *history* come apart. The answers are
 * history — somebody typed them on a Tuesday in 2023 and they belong to that customer — but the form
 * itself is a live thing with a public link, and no system we have met will hand over its questions. They
 * have to be read back out of the answers, which can only ever show the questions somebody actually
 * filled in.
 *
 * So the promise this suite holds is a careful one:
 *
 *   - every answer anybody ever gave is here, on the customer who gave it, dated the day they gave it;
 *   - an answer from somebody who was never in the book is still kept, on the form;
 *   - the form arrives as a **draft**, never live, because publishing a form rebuilt from its own answers
 *     on a link a business might print would be claiming we know what it asks;
 *   - and the business is told exactly that, in words, rather than finding out from a form that turns
 *     people away.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  executeQuery,
  migrationCreate,
  migrationGet,
  migrationMapScopes,
  migrationScan,
  migrationSelect,
  migrationStart,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createSealer } from '../src/crypto';
import {
  createMigrationAdapters,
  type MigrationAdapters,
} from '../src/migrations/adapters/registry';
import { activateConnection, sealTokens } from '../src/migrations/engine/connection';
import { processMigrationJobs } from '../src/migrations/engine/run';
import { countOf, drainUntilWritten, standInMedia } from './helpers';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const worker = () => testDbs().worker.db;

const actorOf = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let organizationId: string;
let workspaceId: string;
let migrationId: string;
let adapters: MigrationAdapters;
let deps: Parameters<typeof processMigrationJobs>[0];

const run = <T>(cmd: unknown, input: unknown): Promise<T> =>
  executeCommand(api(), cmd as never, input, actorOf(owner), meta()).then((r) => r.output as T);
const ask = <T>(q: unknown, input: unknown): Promise<T> =>
  executeQuery(api(), q as never, input, actorOf(owner), meta()) as Promise<T>;

async function drain(limit = 400): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await admin().execute(
      sql`update app.migration_jobs set run_at = now()
          where migration_id = ${migrationId} and state in ('pending', 'retry') and run_at > now()`,
    );
    const [mine] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.migration_jobs
          where migration_id = ${migrationId} and state in ('leased', 'pending', 'retry')`,
    );
    if ((mine?.count ?? 0) === 0) return;
    await processMigrationJobs(deps);
  }
}

beforeAll(async () => {
  owner = await createTestUser('forms-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Lone Star HVAC', timezone: 'America/Chicago' },
    actorOf(owner),
    meta(),
  );
  organizationId = output.organizationId;
  workspaceId = output.workspaceId;
  const sealer = createSealer(
    Buffer.from(randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'hex').toString(
      'base64',
    ),
  );
  adapters = createMigrationAdapters({
    live: false,
    goHighLevel: { clientId: '', clientSecret: '', configured: false },
  });
  deps = {
    db: worker(),
    sealer,
    log: pino({ level: 'silent' }),
    adapters,
    ...standInMedia(),
    workerId: `vitest-forms-${process.pid}`,
    batchSize: 8,
  } as never;

  const connectionId = randomUUID();
  await asWorker(worker(), { organizationId }, async (tx) => {
    await tx.execute(sql`
      insert into app.migration_connections (id, organization_id, source_system, install_kind, status,
        token_enc, token_key_id, created_by)
      values (${connectionId}::uuid, ${organizationId}, 'gohighlevel', 'agency', 'pending',
        ${sealTokens(sealer, { accessToken: 'fake-not-a-real-token', refreshToken: null })},
        ${sealer.keyId}, ${owner.id}::uuid)`);
    await activateConnection(tx, {
      connectionId,
      organizationId,
      sourceSystem: 'gohighlevel',
      externalAccountId: 'fake-agency-forms',
      displayName: 'Lone Star HVAC (agency)',
      installKind: 'agency',
      scopes: ['contacts.readonly', 'forms.readonly'],
      missingScopes: [],
      adapterVersion: 'fake-1',
    });
  });

  const created = await run<{ migrationId: string }>(migrationCreate, {
    organizationId,
    connectionId,
    name: 'Off GoHighLevel',
  });
  migrationId = created.migrationId;
  await run(migrationScan, { organizationId, migrationId });
  await drain();
  const scanned = await ask<{ scopes: { id: string }[] }>(migrationGet, {
    organizationId,
    migrationId,
  });
  await run(migrationMapScopes, {
    organizationId,
    migrationId,
    scopes: scanned.scopes.map((s) => ({ scopeId: s.id, workspaceId })),
  });
  await run(migrationSelect, {
    organizationId,
    migrationId,
    choices: [
      { category: 'contacts', selected: true },
      { category: 'forms', selected: true },
      { category: 'form_submissions', selected: true },
      { category: 'templates', selected: true },
    ],
  });
  await run(migrationStart, { organizationId, migrationId, acknowledgedFindingIds: [] });
  // What the stand-in holds: two forms, and three people who filled one of them in.
  await drainUntilWritten({
    migrationId,
    drain,
    targets: [
      {
        what: 'forms',
        categories: ['forms'],
        expected: 2,
        count: () =>
          countOf(
            sql`select count(*)::int as count from app.forms where workspace_id = ${workspaceId}::uuid`,
          ),
      },
      {
        what: 'wording',
        categories: ['templates'],
        expected: 2,
        count: () =>
          countOf(
            sql`select count(*)::int as count from app.message_templates
                where workspace_id = ${workspaceId}::uuid`,
          ),
      },
      {
        what: 'answers',
        // Answers wait for the customer who gave them, so a short count may mean the customers are late.
        categories: ['contacts', 'form_submissions'],
        expected: 3,
        count: () =>
          countOf(
            sql`select count(*)::int as count from app.form_responses
                where workspace_id = ${workspaceId}::uuid`,
          ),
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await closeTestDbs();
});

describe('forms and what people put in them', () => {
  it('brings the form with its questions, and leaves it a draft nobody can fill in yet', async () => {
    const [form] = await rows<{
      id: string;
      name: string;
      mode: string;
      status: string;
      slug: string;
      active_version_id: string | null;
      definition: { title: string; pages: { questions: { title: string; type: string }[] }[] };
      created_at: Date;
    }>(
      admin(),
      sql`select id::text as id, name, mode::text as mode, status::text as status, slug,
            active_version_id::text as active_version_id, definition, created_at
          from app.forms where workspace_id = ${workspaceId}::uuid and name = 'Get a quote'`,
    );
    expect(form).toBeTruthy();
    expect(form!.mode).toBe('form');
    expect(form!.slug).toBe('get-a-quote');
    // A draft: it is not taking answers on a public link until somebody has looked at it.
    expect(form!.status).toBe('draft');
    // But it has a published version behind it, because the answers have to point at one.
    expect(form!.active_version_id).not.toBeNull();
    // Its own date, not today's.
    expect(new Date(form!.created_at).getUTCFullYear()).toBe(2021);

    const asked = form!.definition.pages.flatMap((p) => p.questions);
    expect(asked.map((q) => q.title)).toEqual([
      'Your name',
      'Email',
      'Phone',
      'What do you need?',
      'How many units?',
    ]);
    expect(asked.map((q) => q.type)).toEqual([
      'short_text',
      'email',
      'phone',
      'long_text',
      'number',
    ]);
  }, 60_000);

  it('says out loud that a form nobody can hand over has to be finished by hand', async () => {
    const got = await ask<{
      findings: { code: string; summary: string; whatChanges: string; affectedCount: number }[];
    }>(migrationGet, { organizationId, migrationId });
    const said = got.findings.filter((f) => f.code === 'forms.questions_read_from_answers');
    // One finding, counting the forms, rather than one per form.
    expect(said).toHaveLength(1);
    expect(said[0]!.summary).toContain('came across as drafts');
    expect(said[0]!.whatChanges).toContain('takes no new answers until you publish it');
    expect(said[0]!.affectedCount).toBe(2);
  }, 60_000);

  it('brings every answer, on the customer who gave it, dated the day they gave it', async () => {
    const answers = await rows<{
      person: string | null;
      question_title: string;
      text_value: string | null;
      number_value: string | null;
      answered_at: Date;
    }>(
      admin(),
      sql`select nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as person,
            a.question_title, a.text_value, a.number_value, a.answered_at
          from app.form_answers a
          join app.form_responses r on r.id = a.response_id
          left join app.people p on p.id = r.person_id
          where a.workspace_id = ${workspaceId}::uuid
          order by r.completed_at, a.question_title`,
    );
    // Three people answered five, four and three questions.
    expect(answers).toHaveLength(12);

    const dave = answers.filter((a) => a.person === 'Dave Smith');
    expect(dave).toHaveLength(5);
    expect(dave.find((a) => a.question_title === 'How many units?')!.number_value).toBe('2.0000');
    expect(dave.find((a) => a.question_title === 'What do you need?')!.text_value).toContain(
      'not keeping up',
    );
    // 2023, because that is when they answered it.
    expect(new Date(dave[0]!.answered_at).getUTCFullYear()).toBe(2023);
  }, 60_000);

  it('keeps an answer from somebody who was never in the book', async () => {
    const [stranger] = await rows<{ person_id: string | null; status: string; answers: unknown }>(
      admin(),
      sql`select r.person_id::text as person_id, r.status::text as status, r.answers
          from app.form_responses r
          join app.form_answers a on a.response_id = r.id
          where r.workspace_id = ${workspaceId}::uuid and a.text_value = 'Walk-in'`,
    );
    expect(stranger).toBeTruthy();
    expect(stranger!.person_id).toBeNull();
    // Still a finished answer, not a half-filled one waiting for somebody to come back to it.
    expect(stranger!.status).toBe('completed');
  }, 60_000);

  it('never lets an imported answer be the one that stops somebody answering again', async () => {
    const [one] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.form_responses
          where workspace_id = ${workspaceId}::uuid and one_per_person`,
    );
    expect(one!.count).toBe(0);
  }, 60_000);

  it('brings a form whose questions the old system will not say, with no questions and no lies', async () => {
    const [survey] = await rows<{
      status: string;
      mode: string;
      definition: { pages: { questions: unknown[] }[] };
    }>(
      admin(),
      sql`select status::text as status, mode::text as mode, definition from app.forms
          where workspace_id = ${workspaceId}::uuid and name = 'After the visit'`,
    );
    expect(survey).toBeTruthy();
    expect(survey!.mode).toBe('survey');
    expect(survey!.status).toBe('draft');
    expect(survey!.definition.pages.flatMap((p) => p.questions)).toHaveLength(0);
  }, 60_000);

  it('says the form on their website is still wired to the old system', async () => {
    const tasks = await rows<{ label: string; instructions: string; settings_path: string | null }>(
      admin(),
      sql`select label, instructions, settings_path from app.migration_reconnect_tasks
          where migration_id = ${migrationId}::uuid and kind = 'other' and provider = 'website'
          order by label`,
    );
    // One per form, because each one has its own copy out there on a page somewhere.
    expect(tasks.map((t) => t.label)).toEqual(['After the visit', 'Get a quote']);
    const quote = tasks.find((t) => t.label === 'Get a quote')!;
    // The quiet failure this exists to prevent: the old form keeps working, and keeps feeding the dead system.
    expect(quote.instructions).toContain('new enquiries go to the account you are leaving');
    expect(quote.settings_path).toBe('/forms');
  }, 60_000);

  it('turns none of it into work', async () => {
    // No workflow started, nobody notified, nothing queued to send: these answers are years old.
    const [jobs] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.scheduled_jobs
          where workspace_id = ${workspaceId}::uuid`,
    );
    expect(jobs!.count).toBe(0);
    const [leads] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.form_responses
          where workspace_id = ${workspaceId}::uuid and lead_id is not null`,
    );
    expect(leads!.count).toBe(0);
  }, 60_000);
});

/**
 * The wording they reuse, which is the last thing a business loses by leaving and the one it notices last:
 * nobody misses the quote follow-up until the week they need it.
 */
describe('the wording they reuse', () => {
  it('brings the saved wording across, with its own dates', async () => {
    const saved = await rows<{
      name: string;
      channel: string;
      subject: string | null;
      body: string;
      created_at: Date;
    }>(
      admin(),
      sql`select name, channel::text as channel, subject, body, created_at
          from app.message_templates where workspace_id = ${workspaceId}::uuid
          order by name`,
    );
    expect(saved.map((t) => t.name)).toEqual(['On our way', 'Quote follow-up']);
    const quote = saved.find((t) => t.name === 'Quote follow-up')!;
    expect(quote.channel).toBe('email');
    expect(quote.subject).toBe('Your quote from Lone Star HVAC');
    // The placeholders come across as they were written: one language for wording, wherever it is used.
    expect(quote.body).toContain('{{person.first_name}}');
    // Saved in 2020, and it still says 2020.
    expect(new Date(quote.created_at).getUTCFullYear()).toBe(2020);
  }, 60_000);

  it('refuses to shelve a template the old system would not hand the words over for', async () => {
    // Listed over there, with nothing in it. An empty card in the picker is worse than an honest gap.
    const [empty] = await rows<{ count: number }>(
      admin(),
      sql`select count(*)::int as count from app.message_templates
          where workspace_id = ${workspaceId}::uuid and name = 'Winter reminder'`,
    );
    expect(empty!.count).toBe(0);
    const [said] = await rows<{ message: string }>(
      admin(),
      sql`select message from app.migration_errors
          where migration_id = ${migrationId}::uuid and code = 'template_has_no_words'`,
    );
    expect(said!.message).toContain('Winter reminder');
  }, 60_000);
});
