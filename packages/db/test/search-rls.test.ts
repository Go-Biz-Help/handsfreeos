/**
 * What search reads, and the rules it adds (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "The database").
 *   - A form response's answers hide while the response is in the Deleted bin (form_answers_follow_response,
 *     20261027010300): from everyone in the business, owners included, and they come back with it. Before, only the
 *     response had a bin rule, so Forms → Results and anything reading answers by business still showed them.
 *   - The worker's policies don't change: it reads the answers it reads today.
 *   - A file's words (app.file_texts, 20261027010400) read exactly when the file could be opened: not another
 *     business's, a sealed file's only for its record's people, not while it's in the bin, never port papers or
 *     knowledge files, and not on a turned-off add-on's record. Deleting a file for good forgets them, the bin keeps
 *     them, and emptying the bin or deleting the business takes them; any ever left for a file deleted for good stay
 *     hidden by their own rule. The worker's finder is its alone.
 */
import { randomInt, randomUUID } from 'node:crypto';
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
  expectPgError,
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

describe('a file’s words', () => {
  const letters = (n: number) =>
    Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join('');
  const ADDON = `fx${letters(8)}`;
  let other: TestUser;
  let outsiderWs: string;
  let outsiderOrg: string;
  let deal: string;
  let listing: string;
  let customer: string;

  /** A ready file, written as storage and the commands leave one. */
  const fileOn = async (
    type: string,
    record: string,
    f: { name?: string; status?: string; createdAt?: string; workspace?: string } = {},
  ): Promise<string> => {
    const [row] = await rows<{ id: string }>(
      dbs.admin.db,
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status, created_at)
          values (${f.workspace ?? ws}, ${type}::app.record_type, ${record}, ${`${f.workspace ?? ws}/${randomUUID()}`},
            ${f.name ?? 'Inspection.pdf'}, ${f.status ?? 'ready'}::app.file_status,
            ${f.createdAt ?? new Date().toISOString()}::timestamptz)
          returning id`,
    );
    return row!.id;
  };
  /** Its words, kept by the worker in the file's business. */
  const wordsFor = (file: string, reader = 1, scope = { workspaceId: ws, organizationId: org }) =>
    asService(scope)((tx) =>
      rows(
        tx,
        sql`insert into app.file_texts (file_id, workspace_id, state, text, chars, reader)
            values (${file}, ${scope.workspaceId}, 'done', 'Test cock weeping on building 2', 31, ${reader})`,
      ),
    );
  /** Which of these files' words the person reads. */
  const readsWords = async (u: TestUser, ids: readonly string[]) =>
    (
      await as(u)((tx) =>
        rows<{ file_id: string }>(
          tx,
          sql`select file_id from app.file_texts where file_id = any(${`{${ids.join(',')}}`}::uuid[])`,
        ),
      )
    )
      .map((r) => r.file_id)
      .sort();
  const kept = async (file: string) =>
    (await rows(dbs.admin.db, sql`select 1 from app.file_texts where file_id = ${file}`)).length;

  beforeAll(async () => {
    other = await createTestUser('search-other');
    ({ wsId: outsiderWs, orgId: outsiderOrg } = await bootstrapOrganization(
      outsider,
      'Words Elsewhere Org',
      'Words Elsewhere Plumbing',
    ));
    await dbs.admin.db
      .insert(workspaceMemberships)
      .values([{ workspaceId: ws, userId: other.id, role: 'member' }]);
    // A fixture add-on with a private kind of record (a deal) and an open one (a listing), on, as reconcile leaves it.
    await rows(
      dbs.admin.db,
      sql`select private.register_addon_permissions(${ADDON}, ${JSON.stringify([
        { key: `${ADDON}.use`, defaultRoles: ['admin', 'member'], requires: [] },
        { key: `${ADDON}.all_deals`, defaultRoles: ['admin'], requires: [`${ADDON}.use`] },
      ])}::jsonb)`,
    );
    await as(owner)((tx) =>
      rows(tx, sql`select * from private.addon_move(${ws}, ${ADDON}, 'installing', '1.0.0', 1, 1)`),
    );
    await worker()((tx) =>
      rows(
        tx,
        sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = ${ADDON}`,
      ),
    );
    const kinds = await worker()((tx) =>
      rows<{ id: string; kept_to_team: boolean }>(
        tx,
        sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission,
              kept_to_team, see_all_permission)
            values (${ws}, ${`${ADDON}_deal`}, 'Deal', 'Deals', ${ADDON}, ${`${ADDON}.use`}, true,
                     ${`${ADDON}.all_deals`}),
                   (${ws}, ${`${ADDON}_listing`}, 'Listing', 'Listings', ${ADDON}, ${`${ADDON}.use`}, false, null)
            returning id, kept_to_team`,
      ),
    );
    const record = async (kind: string, name: string) =>
      (
        await as(member)((tx) =>
          rows<{ id: string }>(
            tx,
            sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
                values (${ws}, ${kind}, ${name}, ${member.id}) returning id`,
          ),
        )
      )[0]!.id;
    deal = await record(kinds.find((k) => k.kept_to_team)!.id, 'Smith purchase');
    listing = await record(kinds.find((k) => !k.kept_to_team)!.id, '12 Oak St');
    [{ id: customer }] = (await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Kim', 'Le') returning id`,
      ),
    )) as [{ id: string }];
  });

  it('read exactly when the file could be opened, by its business and its record’s people', async () => {
    const onKim = await fileOn('person', customer);
    const sealed = await fileOn('custom_record', deal, { name: 'Contract.pdf' });
    const port = await fileOn('port', randomUUID(), { name: 'LOA.pdf' });
    const knowledge = await fileOn('knowledge', ws, { name: 'Price list.pdf' });
    const onListing = await fileOn('custom_record', listing, { name: 'Disclosure.pdf' });
    for (const f of [onKim, sealed, port, knowledge, onListing]) await wordsFor(f);
    const all = [onKim, sealed, port, knowledge, onListing];

    // Port papers and knowledge files never, even for an owner, who may change the papers (channels.manage).
    expect(await readsWords(owner, all)).toEqual([onKim, sealed, onListing].sort());
    // The deal is the member's: its file is sealed, and another member doesn't read it.
    expect(await readsWords(member, all)).toEqual([onKim, sealed, onListing].sort());
    expect(await readsWords(other, all)).toEqual([onKim, onListing].sort());
    expect(await readsWords(outsider, all)).toEqual([]);

    // The add-on turned off: its records hide, and the words of a file on one, sealed or not.
    await as(owner)((tx) =>
      rows(tx, sql`select * from private.addon_move(${ws}, ${ADDON}, 'disabled', '1.0.0', 1, 1)`),
    );
    expect(await readsWords(member, all)).toEqual([onKim]);
    await as(owner)((tx) =>
      rows(tx, sql`select * from private.addon_move(${ws}, ${ADDON}, 'enabled', '1.0.0', 1, 1)`),
    );
    expect(await readsWords(member, all)).toEqual([onKim, sealed, onListing].sort());

    // Nobody signed out, and no customer in a portal, may read them at all.
    const [grants] = await rows<{ anon: boolean; portal: boolean }>(
      dbs.admin.db,
      sql`select has_table_privilege('anon', 'app.file_texts', 'select') as anon,
                 has_table_privilege('portal_actor', 'app.file_texts', 'select') as portal`,
    );
    expect(grants).toEqual({ anon: false, portal: false });
  });

  it('hide while the file is in the Deleted bin, come back with it, and go when it’s deleted for good', async () => {
    const [{ id: gone }] = (await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Ray', 'Binned') returning id`,
      ),
    )) as [{ id: string }];
    const binned = await fileOn('person', gone);
    const deleted = await fileOn('person', customer);
    await wordsFor(binned);
    await wordsFor(deleted);

    const [put] = await as(owner)((tx) =>
      rows<{ id: string }>(tx, sql`select private.bin_put('person', ${gone}::uuid) as id`),
    );
    for (const who of [owner, member]) expect(await readsWords(who, [binned])).toEqual([]);
    // Kept while it's there, so Bring back shows them again.
    expect(await kept(binned)).toBe(1);
    await as(owner)((tx) => tx.execute(sql`select private.restore_bin_item(${put!.id}::uuid)`));
    for (const who of [owner, member]) expect(await readsWords(who, [binned])).toEqual([binned]);

    // file.delete is a person's update, and a person can't touch the words: the trigger forgets them.
    await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.files set deleted_at = now(), deleted_by = ${owner.id} where id = ${deleted}`,
      ),
    );
    expect(await kept(deleted)).toBe(0);

    // Emptying the bin takes the file, and its words with it.
    const [again] = await as(owner)((tx) =>
      rows<{ id: string }>(tx, sql`select private.bin_put('person', ${gone}::uuid) as id`),
    );
    await as(owner)((tx) =>
      rows(tx, sql`select * from private.bin_start_purge(array[${again!.id}::uuid])`),
    );
    for (let i = 0; i < 20; i++) {
      const [r] = await worker()((tx) =>
        rows<{ r: { more: boolean } }>(
          tx,
          sql`select private.purge_bin_batch(${ws}::uuid, ${again!.id}::uuid) as r`,
        ),
      );
      if (!r!.r.more) break;
    }
    expect(await kept(binned)).toBe(0);
  });

  it('stay hidden by their own rule if any are ever left for a file deleted for good', async () => {
    const leftover = await fileOn('person', customer);
    await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.files set deleted_at = now(), deleted_by = ${owner.id} where id = ${leftover}`,
      ),
    );
    // Words written after it went, as a save racing the delete once could: the file itself still reads.
    await rows(
      dbs.admin.db,
      sql`insert into app.file_texts (file_id, workspace_id, state, text, chars, reader)
          values (${leftover}, ${ws}, 'done', 'Leftover words', 14, 1)`,
    );
    const [file] = await as(owner)((tx) =>
      rows(tx, sql`select 1 from app.files where id = ${leftover}`),
    );
    expect(file).toBeDefined();
    for (const who of [owner, member]) expect(await readsWords(who, [leftover])).toEqual([]);
    await rows(dbs.admin.db, sql`delete from app.file_texts where file_id = ${leftover}`);
  });

  it('keep the worker to its business, and to the file’s', async () => {
    const theirs = await fileOn('person', randomUUID(), { workspace: outsiderWs });
    const ours = await fileOn('person', customer);
    await wordsFor(ours);
    const elsewhere = { workspaceId: outsiderWs, organizationId: outsiderOrg };
    await wordsFor(theirs, 1, elsewhere);
    const seen = (scope: typeof elsewhere) =>
      asService(scope)((tx) =>
        rows<{ file_id: string }>(
          tx,
          sql`select file_id from app.file_texts where file_id in (${ours}, ${theirs})`,
        ),
      ).then((r) => r.map((x) => x.file_id));
    expect(await seen({ workspaceId: ws, organizationId: org })).toEqual([ours]);
    expect(await seen(elsewhere)).toEqual([theirs]);
    // Words for another business's file: refused, whether filed under that business or this one.
    const mismatch = await expectPgError(() => wordsFor(ours, 1, elsewhere));
    expect(['23514', '42501']).toContain(mismatch.code);
    // The business deleted, its files' words go with it.
    await as(outsider)((tx) =>
      rows(tx, sql`select private.request_workspace_deletion(${outsiderWs})`),
    );
    await asService(elsewhere)((tx) =>
      rows(tx, sql`select private.purge_workspace(${outsiderWs})`),
    );
    expect(await kept(theirs)).toBe(0);
  });

  it('are found missing, or read by an older reader, by the worker’s finder alone', async () => {
    // Files of long ago, so the finder, oldest first across every business, reaches them.
    const at = (n: number) => new Date(Date.UTC(1972, 0, 1, 0, n)).toISOString();
    const [{ id: gone }] = (await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Old', 'Binned') returning id`,
      ),
    )) as [{ id: string }];
    const missing = await fileOn('person', customer, { createdAt: at(1) });
    const older = await fileOn('person', customer, { createdAt: at(2) });
    const current = await fileOn('person', customer, { createdAt: at(3) });
    const binned = await fileOn('person', gone, { createdAt: at(4) });
    const deleted = await fileOn('person', customer, { createdAt: at(5) });
    const port = await fileOn('port', randomUUID(), { createdAt: at(6) });
    const knowledge = await fileOn('knowledge', ws, { createdAt: at(7) });
    const pending = await fileOn('person', customer, { createdAt: at(8), status: 'pending' });
    const fresh = await fileOn('person', customer);
    const mine = [missing, older, current, binned, deleted, port, knowledge, pending, fresh];
    try {
      await wordsFor(older, 1);
      await wordsFor(current, 2);
      await as(owner)((tx) => rows(tx, sql`select private.bin_put('person', ${gone}::uuid)`));
      await as(owner)((tx) =>
        rows(tx, sql`update app.files set deleted_at = now() where id = ${deleted}`),
      );

      const found = await asService({})((tx) =>
        rows<{ file_id: string; workspace_id: string; organization_id: string }>(
          tx,
          sql`select * from private.files_without_text(500, 2::smallint)`,
        ),
      );
      expect(found.filter((f) => mine.includes(f.file_id))).toEqual([
        { file_id: missing, workspace_id: ws, organization_id: org },
        { file_id: older, workspace_id: ws, organization_id: org },
      ]);
      // A person can't ask it which files a business holds.
      const refused = await expectPgError(() =>
        as(owner)((tx) => rows(tx, sql`select * from private.files_without_text(10, 1::smallint)`)),
      );
      expect(refused.code).toBe('42501');
    } finally {
      // Long-ago files would crowd out the next run's.
      await rows(
        dbs.admin.db,
        sql`delete from app.files where id = any(${`{${mine.join(',')}}`}::uuid[])`,
      );
    }
  });
});
