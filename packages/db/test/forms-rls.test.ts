import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

/** Workspace A's owner. */
let owner: TestUser;
let member: TestUser;
/** Another business entirely. */
let outsider: TestUser;
let wsA: string;
let orgA: string;
let wsB: string;
let orgB: string;

const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('form-owner'),
    createTestUser('form-member'),
    createTestUser('form-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Forms Org A', 'Forms A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Forms Org B', 'Forms B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: wsA, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

interface Live {
  readonly formId: string;
  readonly versionId: string;
}

/** A form published to version 1 and taking answers, as the worker would leave it. */
function live(ws: string, org: string): Promise<Live> {
  return worker(
    ws,
    org,
  )(async (tx) => {
    const [f] = await rows<{ id: string }>(
      tx,
      sql`insert into app.forms (workspace_id, name, slug, mode)
          values (${ws}, 'Get a quote', ${`quote-${uniq()}`}, 'form') returning id`,
    );
    const [v] = await rows<{ id: string }>(
      tx,
      sql`insert into app.form_versions (workspace_id, form_id, version, definition, definition_version, revision)
          values (${ws}, ${f!.id}, 1, '{"pages": []}', 1, 1) returning id`,
    );
    await tx.execute(
      sql`update app.forms set status = 'live', active_version_id = ${v!.id} where id = ${f!.id}`,
    );
    return { formId: f!.id, versionId: v!.id };
  });
}

/** A completed response, the way a submission arrives. */
async function respond(form: Live, ws = wsA, org = orgA): Promise<string> {
  const [r] = await worker(
    ws,
    org,
  )(async (tx) => {
    const inserted = await rows<{ id: string }>(
      tx,
      sql`insert into app.form_responses (workspace_id, form_id, version_id, status, completed_at, answers)
          values (${ws}, ${form.formId}, ${form.versionId}, 'completed', now(), '{"q_aaaaaaaa": "Dale"}')
          returning id`,
    );
    await tx.execute(
      sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title, question_type, value, text_value)
          values (${ws}, ${inserted[0]!.id}, ${form.formId}, 'q_aaaaaaaa', 'Your name', 'short_text', '"Dale"', 'Dale')`,
    );
    return inserted;
  });
  return r!.id;
}

describe('forms: who reads and who writes', () => {
  it('the whole business reads its forms, versions and answers; another business sees none', async () => {
    const form = await live(wsA, orgA);
    const responseId = await respond(form);
    const count = (user: TestUser, table: string, column: string, value: string) =>
      as(user)((tx) =>
        rows(tx, sql`select 1 from ${sql.raw(`app.${table}`)} where ${sql.raw(column)} = ${value}`),
      ).then((r) => r.length);
    const probes: [string, string, string][] = [
      ['forms', 'id', form.formId],
      ['form_versions', 'form_id', form.formId],
      ['form_responses', 'id', responseId],
      ['form_answers', 'response_id', responseId],
    ];
    for (const [table, column, value] of probes) {
      expect(await count(member, table, column, value)).toBeGreaterThan(0);
      expect(await count(owner, table, column, value)).toBeGreaterThan(0);
      expect(await count(outsider, table, column, value)).toBe(0);
    }
  });

  it('members cannot build a form; owners can, and a new one is an unpublished draft', async () => {
    const insertAs = (user: TestUser, status: string = 'draft') =>
      as(user)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.forms (workspace_id, name, slug, created_by, status)
              values (${wsA}, 'Intake', ${`intake-${uniq()}`}, ${user.id}, ${sql.raw(`'${status}'`)}) returning id`,
        ),
      );
    expect((await failure(() => insertAs(member))).code).toBe('42501');
    // Even an owner can't start one live: the policy says a new form is a draft with nothing published.
    expect((await failure(() => insertAs(owner, 'live'))).code).toBe('42501');
    const [f] = await insertAs(owner);
    expect(f!.id).toBeTruthy();
    const touched = await as(member)((tx) =>
      rows(tx, sql`update app.forms set name = 'Mine now' where id = ${f!.id} returning id`),
    );
    expect(touched).toHaveLength(0);
  });

  it('nobody edits a published version, and it never belongs to another business', async () => {
    const form = await live(wsA, orgA);
    expect(
      (
        await failure(() =>
          worker(
            wsA,
            orgA,
          )((tx) =>
            tx.execute(
              sql`update app.form_versions set definition = '{"pages": [1]}' where id = ${form.versionId}`,
            ),
          ),
        )
      ).detail,
    ).toBe('version_immutable');
    expect(
      (
        await failure(() =>
          worker(
            wsB,
            orgB,
          )((tx) =>
            tx.execute(
              sql`insert into app.form_versions (workspace_id, form_id, version, definition, definition_version, revision)
                  values (${wsB}, ${form.formId}, 2, '{}', 1, 1)`,
            ),
          ),
        )
      ).detail,
    ).toBe('cross_workspace');
  });

  it('a renamed form keeps its old link, and taking a name back frees it', async () => {
    const form = await live(wsA, orgA);
    const slugs = () =>
      worker(
        wsA,
        orgA,
      )((tx) =>
        rows<{ slug: string }>(
          tx,
          sql`select slug from app.form_slugs where form_id = ${form.formId}`,
        ),
      );
    const [before] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ slug: string }>(tx, sql`select slug from app.forms where id = ${form.formId}`),
    );
    const rename = (slug: string) =>
      worker(
        wsA,
        orgA,
      )((tx) => tx.execute(sql`update app.forms set slug = ${slug} where id = ${form.formId}`));
    await rename('spring-special');
    expect((await slugs()).map((s) => s.slug)).toEqual([before!.slug]);
    await rename(before!.slug);
    expect((await slugs()).map((s) => s.slug)).toEqual(['spring-special']);
  });

  it('counts completed responses as they arrive, so “closes after N” is right', async () => {
    const form = await live(wsA, orgA);
    const count = async () => {
      const [f] = await worker(
        wsA,
        orgA,
      )((tx) =>
        rows<{ response_count: number }>(
          tx,
          sql`select response_count from app.forms where id = ${form.formId}`,
        ),
      );
      return Number(f!.response_count);
    };
    expect(await count()).toBe(0);
    await respond(form);
    await respond(form);
    expect(await count()).toBe(2);
  });

  it('an answer cannot be filed under another business’s response', async () => {
    const mine = await live(wsA, orgA);
    const responseId = await respond(mine);
    const theirs = await live(wsB, orgB);
    expect(
      (
        await failure(() =>
          worker(
            wsB,
            orgB,
          )((tx) =>
            tx.execute(
              sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title, question_type)
                  values (${wsB}, ${responseId}, ${theirs.formId}, 'q_bbbbbbbb', 'Sneaky', 'short_text')`,
            ),
          ),
        )
      ).detail,
    ).toBe('cross_response');
  });

  it('nobody types a response in by hand; forms.manage may delete one', async () => {
    const form = await live(wsA, orgA);
    const responseId = await respond(form);
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            tx.execute(
              sql`insert into app.form_responses (workspace_id, form_id, version_id)
                  values (${wsA}, ${form.formId}, ${form.versionId})`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    const gone = await as(member)((tx) =>
      rows(tx, sql`delete from app.form_responses where id = ${responseId} returning id`),
    );
    expect(gone).toHaveLength(0);
    const deleted = await as(owner)((tx) =>
      rows(tx, sql`delete from app.form_responses where id = ${responseId} returning id`),
    );
    expect(deleted).toHaveLength(1);
  });

  it('a teammate sends a sheet from the app, and nothing more (0109)', async () => {
    const form = await live(wsA, orgA);
    const start = (user: TestUser, extra = '') =>
      as(user)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.form_responses (workspace_id, form_id, version_id, source${sql.raw(extra ? ', resume_token_hash, resume_expires_at' : '')})
              values (${wsA}, ${form.formId}, ${form.versionId}, 'app'${sql.raw(extra)})
              returning id`,
        ),
      );
    // With a key, or in another business: refused.
    expect(
      (await failure(() => start(member, `, '\\x${'ab'.repeat(32)}', now() + interval '1 day'`)))
        .code,
    ).toBe('42501');
    expect((await failure(() => start(outsider))).code).toBe('42501');

    // A sheet from the app, with no key and nobody on it: the teammate starts it, sends it and files its answers.
    const [sheet] = await start(member);
    const sent = await as(member)((tx) =>
      rows(
        tx,
        sql`update app.form_responses set status = 'completed', completed_at = now(), answers = '{"q_aaaaaaaa": "Lupe"}'
            where id = ${sheet!.id} returning id`,
      ),
    );
    expect(sent).toHaveLength(1);
    await as(member)((tx) =>
      tx.execute(
        sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title, question_type, value, text_value)
            values (${wsA}, ${sheet!.id}, ${form.formId}, 'q_aaaaaaaa', 'Your name', 'short_text', '"Lupe"', 'Lupe')`,
      ),
    );
    await as(member)((tx) =>
      tx.execute(
        sql`insert into app.form_days (workspace_id, form_id, day, completions)
            values (${wsA}, ${form.formId}, current_date, 1)
            on conflict (form_id, day) do update set completions = app.form_days.completions + 1`,
      ),
    );

    // Once sent, it is never changed by hand again.
    const again = await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.form_responses set answers = '{}' where id = ${sheet!.id} returning id`,
      ),
    );
    expect(again).toHaveLength(0);

    // A customer's sheet from the link stays the worker's: not changed, no answers filed under it, no key read.
    const linkSheet = await respond(form);
    const touched = await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.form_responses set answers = '{}' where id = ${linkSheet} returning id`,
      ),
    );
    expect(touched).toHaveLength(0);
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            tx.execute(
              sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title, question_type)
                  values (${wsA}, ${linkSheet}, ${form.formId}, 'q_bbbbbbbb', 'Sneaky', 'short_text')`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            rows(tx, sql`select resume_token_hash from app.form_responses where id = ${linkSheet}`),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('a sheet sent again writes its answers over the last ones, and reads them back (20261027010300)', async () => {
    // Answers now read only through a response the person can read, and sending writes them with
    // `on conflict do update`, which reads the answer already there. The phone's own sheet still can.
    const form = await live(wsA, orgA);
    const [sheet] = await as(member)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.form_responses (workspace_id, form_id, version_id, source)
            values (${wsA}, ${form.formId}, ${form.versionId}, 'app') returning id`,
      ),
    );
    const send = (name: string) =>
      as(member)((tx) =>
        rows<{ text_value: string }>(
          tx,
          sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title, question_type, value, text_value)
              values (${wsA}, ${sheet!.id}, ${form.formId}, 'q_aaaaaaaa', 'Your name', 'short_text', ${JSON.stringify(name)}::jsonb, ${name})
              on conflict (response_id, question_id) do update set value = excluded.value, text_value = excluded.text_value
              returning text_value`,
        ),
      );
    expect(await send('Lupe')).toEqual([{ text_value: 'Lupe' }]);
    expect(await send('Lupe Garza')).toEqual([{ text_value: 'Lupe Garza' }]);
    const read = await as(owner)((tx) =>
      rows(tx, sql`select text_value from app.form_answers where response_id = ${sheet!.id}`),
    );
    expect(read).toEqual([{ text_value: 'Lupe Garza' }]);
  });
});

describe('the fields a business invents', () => {
  const field = (ws: string, org: string, key: string, entity = 'person') =>
    worker(
      ws,
      org,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_fields (workspace_id, entity, key, label)
            values (${ws}, ${sql.raw(`'${entity}'`)}, ${key}, 'Gate code') returning id`,
      ),
    ).then((r) => r[0]!.id);

  const person = (ws: string, org: string, custom: string) =>
    worker(
      ws,
      org,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, custom)
            values (${ws}, 'Dale', ${sql.raw(`'${custom}'::jsonb`)}) returning id`,
      ),
    ).then((r) => r[0]!.id);

  it('members read the fields but cannot make one; owners can', async () => {
    const id = await field(wsA, orgA, `gate_${uniq().slice(0, 6)}`);
    const seen = await as(member)((tx) =>
      rows(tx, sql`select 1 from app.custom_fields where id = ${id}`),
    );
    expect(seen).toHaveLength(1);
    expect(
      await as(outsider)((tx) => rows(tx, sql`select 1 from app.custom_fields where id = ${id}`)),
    ).toHaveLength(0);
    expect(
      (
        await failure(() =>
          as(member)((tx) =>
            rows(
              tx,
              sql`insert into app.custom_fields (workspace_id, entity, key, label, created_by)
                  values (${wsA}, 'person', 'sneaky', 'Sneaky', ${member.id}) returning id`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });

  it('a customer only carries fields this business actually has', async () => {
    const id = await field(wsA, orgA, `gate_${uniq().slice(0, 6)}`);
    const personId = await person(wsA, orgA, `{"${id}": "1234#"}`);
    expect(personId).toBeTruthy();
    const theirs = await field(wsB, orgB, `gate_${uniq().slice(0, 6)}`);
    expect((await failure(() => person(wsA, orgA, `{"${theirs}": "1234#"}`))).detail).toBe(
      'unknown_custom_field',
    );
  });

  it('retiring a field takes it off the customers that held it', async () => {
    const id = await field(wsA, orgA, `pool_${uniq().slice(0, 6)}`);
    const personId = await person(wsA, orgA, `{"${id}": "Large"}`);
    await as(owner)((tx) =>
      tx.execute(sql`update app.custom_fields set archived_at = now() where id = ${id}`),
    );
    const [after] = await worker(
      wsA,
      orgA,
    )((tx) =>
      rows<{ custom: Record<string, unknown> }>(
        tx,
        sql`select custom from app.people where id = ${personId}`,
      ),
    );
    expect(after!.custom).toEqual({});
  });
});
