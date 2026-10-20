/**
 * What search reads, and the rules it adds (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "The database").
 *   - A form response's answers hide while the response is in the Deleted bin (form_answers_follow_response,
 *     20261027009700): from everyone in the business, owners included, and they come back with it. Before, only the
 *     response had a bin rule, so Forms → Results and anything reading answers by business still showed them.
 *   - The worker's policies don't change: it reads the answers it reads today.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
import { workspaceMemberships } from '../src/schema/index';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  uniq,
  type TestUser,
} from './harness';

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: string;
let org: string;
let form: { formId: string; versionId: string };

const worker = () => asService({ workspaceId: ws, organizationId: org });

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('search-owner'),
    createTestUser('search-member'),
    createTestUser('search-outsider'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Search Org', 'Search Plumbing'));
  await bootstrapOrganization(outsider, 'Other Search Org', 'Other Plumbing');
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: member.id, role: 'member' }]);
  form = await worker()(async (tx) => {
    const [f] = await rows<{ id: string }>(
      tx,
      sql`insert into app.forms (workspace_id, name, slug, mode)
          values (${ws}, 'Water heater quote', ${`heater-${uniq()}`}, 'form') returning id`,
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
});
afterAll(closeAll);

/** A completed response with two answers, from a customer when one is given, the way a submission arrives. */
async function respond(personId: string | null, heater: string): Promise<string> {
  return worker()(async (tx) => {
    const [r] = await rows<{ id: string }>(
      tx,
      sql`insert into app.form_responses (workspace_id, form_id, version_id, status, completed_at, person_id, answers)
          values (${ws}, ${form.formId}, ${form.versionId}, 'completed', now(), ${personId}, '{}')
          returning id`,
    );
    await tx.execute(
      sql`insert into app.form_answers (workspace_id, response_id, form_id, question_id, question_title, question_type,
            value, text_value)
          values (${ws}, ${r!.id}, ${form.formId}, 'q_heater00', 'Which heater?', 'short_text', ${JSON.stringify(heater)}::jsonb, ${heater}),
                 (${ws}, ${r!.id}, ${form.formId}, 'q_gate0000', 'Gate code', 'short_text', '"4471"', '4471')`,
    );
    return r!.id;
  });
}

/** Reads as someone: a person under row security, or the worker. */
type Reader = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

const answersOf = (read: Reader) => ({
  response: (id: string) =>
    read((tx) =>
      rows<{ question_id: string }>(
        tx,
        sql`select question_id from app.form_answers where response_id = ${id} order by question_id`,
      ),
    ).then((r) => r.map((a) => a.question_id)),
  /** What Forms → Results reads: the form's answers, by question. */
  heaters: () =>
    read((tx) =>
      rows<{ text_value: string }>(
        tx,
        sql`select text_value from app.form_answers
            where form_id = ${form.formId} and question_id = 'q_heater00' order by text_value`,
      ),
    ).then((r) => r.map((a) => a.text_value)),
});

describe('form answers follow their response into the Deleted bin', () => {
  it('hide from owners and members while it’s there, come back with it, and the worker reads as before', async () => {
    const [dana] = await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Dana', 'Smith') returning id`,
      ),
    );
    const hers = await respond(dana!.id, '50 gallon, gas');
    const other = await respond(null, 'Tankless');
    const both = ['q_gate0000', 'q_heater00'];

    for (const who of [owner, member]) {
      expect(await answersOf(as(who)).response(hers)).toEqual(both);
      expect(await answersOf(as(who)).heaters()).toEqual(['50 gallon, gas', 'Tankless']);
    }
    expect(await answersOf(as(outsider)).response(hers)).toEqual([]);

    // Deleting Dana puts her response in the bin with her, and its answers with it.
    const [put] = await as(owner)((tx) =>
      rows<{ id: string }>(tx, sql`select private.bin_put('person', ${dana!.id}::uuid) as id`),
    );
    for (const who of [owner, member]) {
      expect(await answersOf(as(who)).response(hers)).toEqual([]);
      expect(await answersOf(as(who)).heaters()).toEqual(['Tankless']);
      expect(await answersOf(as(who)).response(other)).toEqual(both);
    }
    // The worker's own policies are unchanged, so it reads them as it did.
    expect(await answersOf(worker()).response(hers)).toEqual(both);

    // Brought back, they read again.
    await as(owner)((tx) => tx.execute(sql`select private.restore_bin_item(${put!.id}::uuid)`));
    for (const who of [owner, member]) {
      expect(await answersOf(as(who)).response(hers)).toEqual(both);
      expect(await answersOf(as(who)).heaters()).toEqual(['50 gallon, gas', 'Tankless']);
    }
  });
});
