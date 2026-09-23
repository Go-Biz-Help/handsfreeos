/**
 * Relationships (0101) in the database itself: who may shape and fill in kinds of records and relationship types,
 * what a business's neighbours can see (nothing), and the rules that hold whoever writes — each end the kind its
 * type says, "only one" meaning one, a mutual pair stored one way round, a record's fields its own kind's, and a
 * record that goes taking its pairs with it.
 */
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

let owner: TestUser;
let member: TestUser;
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
const one = <T>(list: T[]) => list[0]!;

/** A kind of record, as the command would make it (as the owner). */
const kind = (singular: string) =>
  as(owner)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, created_by)
          values (${wsA}, ${`k_${uniq().slice(0, 8)}`}, ${`${singular} ${uniq().slice(0, 6)}`}, ${`${singular}s`}, ${owner.id})
          returning id`,
    ),
  ).then((r) => one(r).id);

const record = (typeId: string, name: string, u: TestUser = member) =>
  as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.custom_records (workspace_id, type_id, name, created_by)
          values (${wsA}, ${typeId}, ${name}, ${u.id}) returning id`,
    ),
  ).then((r) => one(r).id);

const person = (ws: string, org: string, first: string) =>
  worker(
    ws,
    org,
  )((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name) values (${ws}, ${first}) returning id`,
    ),
  ).then((r) => one(r).id);

/** A relationship type, as the owner. */
const type = (
  a: { end: string; kind?: string | null; label: string },
  b: { end: string; kind?: string | null; label: string },
  cardinality = 'many_to_many',
  mutual = false,
) =>
  as(owner)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.relationship_types
            (workspace_id, a_end, a_record_type_id, a_label, b_end, b_record_type_id, b_label, cardinality, mutual, created_by)
          values (${wsA}, ${a.end}::app.relationship_end, ${a.kind ?? null}, ${a.label},
            ${b.end}::app.relationship_end, ${b.kind ?? null}, ${b.label},
            ${cardinality}::app.relationship_cardinality, ${mutual}, ${owner.id})
          returning id`,
    ),
  ).then((r) => one(r).id);

/** A pair, as a member: `a` and `b` name the column each end's record sits in. */
const pair = (
  typeId: string,
  a: { col: 'person' | 'company' | 'custom_record'; id: string },
  b: { col: 'person' | 'company' | 'custom_record'; id: string },
  u: TestUser = member,
) =>
  as(u)((tx) =>
    rows<{ id: string; a_id: string; b_id: string }>(
      tx,
      sql`insert into app.relationships (workspace_id, type_id, ${sql.raw(`a_${a.col}_id`)}, ${sql.raw(`b_${b.col}_id`)}, created_by)
          values (${wsA}, ${typeId}, ${a.id}, ${b.id}, ${u.id}) returning id, a_id, b_id`,
    ),
  ).then(one);

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('rel-owner'),
    createTestUser('rel-member'),
    createTestUser('rel-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Relationships Org A', 'Relationships A');
  wsA = a.wsId;
  orgA = a.orgId;
  const b = await bootstrapOrganization(outsider, 'Relationships Org B', 'Relationships B');
  wsB = b.wsId;
  orgB = b.orgId;
  await dbs.admin.db
    .insert(workspaceMemberships)
    .values([{ workspaceId: wsA, userId: member.id, role: 'member' }]);
});
afterAll(closeAll);

describe('who shapes, who fills in, who sees', () => {
  it('members add records and pairs but never kinds or relationship types', async () => {
    const pets = await kind('Pet');
    expect(
      (
        await failure(() =>
          as(member)((tx) =>
            rows(
              tx,
              sql`insert into app.custom_record_types (workspace_id, key, singular, plural, created_by)
                  values (${wsA}, 'sneaky', 'Sneaky', 'Sneakies', ${member.id})`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    const john = await person(wsA, orgA, 'John');
    const owners = await type(
      { end: 'person', label: 'Owner' },
      { end: 'custom_record', kind: pets, label: 'Pet' },
    );
    // Row security hides the type from a member's update: nothing changes.
    expect(
      await as(member)((tx) =>
        rows(
          tx,
          sql`update app.relationship_types set cardinality = 'one_to_one' where id = ${owners} returning id`,
        ),
      ),
    ).toHaveLength(0);
    const max = await record(pets, 'Max');
    const made = await pair(owners, { col: 'person', id: john }, { col: 'custom_record', id: max });
    expect(made).toMatchObject({ a_id: john, b_id: max });
    // Archiving is for records.archive holders, as for customers.
    expect(
      (
        await failure(() =>
          as(member)((tx) =>
            rows(
              tx,
              sql`update app.custom_records set archived_at = now() where id = ${max} returning id`,
            ),
          ),
        )
      ).detail,
    ).toBe('archive_forbidden');
    await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.custom_records set archived_at = now() where id = ${max} returning id`,
      ),
    );
    // The other business sees none of it, and can't point at it.
    for (const table of [
      'custom_record_types',
      'custom_records',
      'relationship_types',
      'relationships',
    ])
      expect(
        await as(outsider)((tx) =>
          rows(tx, sql`select 1 from ${sql.raw(`app.${table}`)} where workspace_id = ${wsA}`),
        ),
      ).toHaveLength(0);
    const theirs = await person(wsB, orgB, 'Theirs');
    expect(
      (
        await failure(() =>
          worker(
            wsB,
            orgB,
          )((tx) =>
            rows(
              tx,
              sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
                  values (${wsB}, ${owners}, ${theirs}, ${max})`,
            ),
          ),
        )
      ).detail,
    ).toBe('record_workspace_mismatch');
  });

  it('a record carries only its own kind’s fields', async () => {
    const pets = await kind('Pet');
    const cars = await kind('Car');
    const [breed] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.custom_fields (workspace_id, entity, record_type_id, key, label, created_by)
            values (${wsA}, 'custom_record', ${pets}, 'breed', 'Breed', ${owner.id}) returning id`,
      ),
    );
    // A key stays unique across every kind (0076's constraint, which the running importer upserts on): another
    // kind's field takes another key.
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`insert into app.custom_fields (workspace_id, entity, record_type_id, key, label, created_by)
                  values (${wsA}, 'custom_record', ${cars}, 'breed', 'Breed', ${owner.id})`,
            ),
          ),
        )
      ).code,
    ).toBe('23505');
    await as(owner)((tx) =>
      rows(
        tx,
        sql`insert into app.custom_fields (workspace_id, entity, record_type_id, key, label, created_by)
            values (${wsA}, 'custom_record', ${cars}, 'breed_2', 'Breed', ${owner.id})`,
      ),
    );
    // A kind's field says which kind; a customer's field names none.
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`insert into app.custom_fields (workspace_id, entity, key, label, created_by)
                  values (${wsA}, 'custom_record', 'orphan', 'Orphan', ${owner.id})`,
            ),
          ),
        )
      ).code,
    ).toBe('23514');
    const max = await record(pets, 'Max');
    await as(member)((tx) =>
      rows(
        tx,
        sql`update app.custom_records set custom = ${JSON.stringify({ [breed!.id]: 'Poodle' })}::jsonb where id = ${max}`,
      ),
    );
    const herbie = await record(cars, 'Herbie');
    expect(
      (
        await failure(() =>
          as(member)((tx) =>
            rows(
              tx,
              sql`update app.custom_records set custom = ${JSON.stringify({ [breed!.id]: 'Beetle' })}::jsonb where id = ${herbie}`,
            ),
          ),
        )
      ).detail,
    ).toBe('unknown_custom_field');
    // Retiring the field takes it off the pet.
    await as(owner)((tx) =>
      tx.execute(sql`update app.custom_fields set archived_at = now() where id = ${breed!.id}`),
    );
    const [after] = await as(member)((tx) =>
      rows<{ custom: Record<string, unknown> }>(
        tx,
        sql`select custom from app.custom_records where id = ${max}`,
      ),
    );
    expect(after!.custom).toEqual({});
  });
});

describe('the rules that hold whoever writes', () => {
  it('each end is the kind its type says, and nothing is related to itself', async () => {
    const pets = await kind('Pet');
    const john = await person(wsA, orgA, 'John');
    const owners = await type(
      { end: 'person', label: 'Owner' },
      { end: 'custom_record', kind: pets, label: 'Pet' },
    );
    const jane = await person(wsA, orgA, 'Jane');
    expect(
      (await failure(() => pair(owners, { col: 'person', id: john }, { col: 'person', id: jane })))
        .detail,
    ).toBe('relationship_end_mismatch');
    const friends = await type(
      { end: 'person', label: 'Friend' },
      { end: 'person', label: 'Friend' },
      'many_to_many',
      true,
    );
    expect(
      (await failure(() => pair(friends, { col: 'person', id: john }, { col: 'person', id: john })))
        .detail,
    ).toBe('relationship_to_itself');
    // A mutual type's two ends are one part.
    expect(
      (
        await failure(() =>
          type(
            { end: 'person', label: 'Parent' },
            { end: 'person', label: 'Child' },
            'many_to_many',
            true,
          ),
        )
      ).code,
    ).toBe('23514');
  });

  it('a mutual pair is kept one way round, so it can’t be made twice', async () => {
    const siblings = await type(
      { end: 'person', label: 'Sibling' },
      { end: 'person', label: 'Sibling' },
      'many_to_many',
      true,
    );
    const [x, y] = [await person(wsA, orgA, 'Ann'), await person(wsA, orgA, 'Bo')];
    const [low, high] = x < y ? [x, y] : [y, x];
    const made = await pair(siblings, { col: 'person', id: high }, { col: 'person', id: low });
    expect(made).toMatchObject({ a_id: low, b_id: high });
    expect(
      (await failure(() => pair(siblings, { col: 'person', id: low }, { col: 'person', id: high })))
        .code,
    ).toBe('23505');
  });

  it('“one” means one, on each end it is said of, and can’t be said while a record has more', async () => {
    const units = await kind('Unit');
    const tenants = await type(
      { end: 'person', label: 'Tenant' },
      { end: 'custom_record', kind: units, label: 'Unit' },
      'many_to_one',
    );
    const [ann, bo] = [await person(wsA, orgA, 'Ann'), await person(wsA, orgA, 'Bo')];
    const [a1, a2] = [await record(units, '1A'), await record(units, '2B')];
    await pair(tenants, { col: 'person', id: ann }, { col: 'custom_record', id: a1 });
    // Each tenant has one unit...
    expect(
      (
        await failure(() =>
          pair(tenants, { col: 'person', id: ann }, { col: 'custom_record', id: a2 }),
        )
      ).detail,
    ).toBe('relationship_end_full');
    // ...and a unit many tenants.
    await pair(tenants, { col: 'person', id: bo }, { col: 'custom_record', id: a1 });
    expect(
      (
        await failure(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`update app.relationship_types set cardinality = 'one_to_one' where id = ${tenants} returning id`,
            ),
          ),
        )
      ).detail,
    ).toBe('relationship_cardinality_conflict');
    // Widening is always fine.
    await as(owner)((tx) =>
      rows(
        tx,
        sql`update app.relationship_types set cardinality = 'many_to_many' where id = ${tenants} returning id`,
      ),
    );
    await pair(tenants, { col: 'person', id: ann }, { col: 'custom_record', id: a2 });
  });

  it('a pair is only its note after it’s made, and goes when either record goes', async () => {
    const pets = await kind('Pet');
    const owners = await type(
      { end: 'person', label: 'Owner' },
      { end: 'custom_record', kind: pets, label: 'Pet' },
    );
    const [john, jane] = [await person(wsA, orgA, 'John'), await person(wsA, orgA, 'Jane')];
    const rex = await record(pets, 'Rex');
    const made = await pair(owners, { col: 'person', id: john }, { col: 'custom_record', id: rex });
    await as(member)((tx) =>
      rows(
        tx,
        sql`update app.relationships set note = 'Primary driver' where id = ${made.id} returning id`,
      ),
    );
    // A member may not re-point a pair at somebody else (no grant on the column), nor may anyone (the trigger).
    expect(
      (
        await failure(() =>
          as(member)((tx) =>
            rows(
              tx,
              sql`update app.relationships set a_person_id = ${jane} where id = ${made.id} returning id`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    expect(
      (
        await failure(() =>
          worker(
            wsA,
            orgA,
          )((tx) =>
            rows(tx, sql`update app.relationships set a_person_id = ${jane} where id = ${made.id}`),
          ),
        )
      ).code,
    ).toBe('23514');
    await dbs.admin.db.execute(sql`delete from app.custom_records where id = ${rex}`);
    const [left] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.relationships where id = ${made.id}`,
    );
    expect(left!.n).toBe(0);
  });
});
