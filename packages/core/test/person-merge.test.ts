import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import {
  as,
  closeTestDbs,
  createTestUser,
  expectPgError,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { mergedDetails, type MergeSide } from '../src/crm/person-merge';
import { describeTimeline } from '../src/crm/timeline-words';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef } from '../src/kernel/types';
import {
  activityLog,
  customFieldArchive,
  customFieldCreate,
  leadCreate,
  organizationCreate,
  personCreate,
  personGet,
  personMerge,
  personRestore,
  recordSetTags,
  relationshipCreate,
  relationshipTypeCreate,
  tagCreate,
  taskCreate,
  timelineList,
} from '../src/server';

const db = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(db(), cmd, input, human(u), { correlationId: randomUUID(), channel: 'test' });
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, human(u), { correlationId: randomUUID(), channel: 'test' });

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    expect((e as HfosError).code).toBe(code);
    if (rule) expect((e as HfosError).rule).toBe(rule);
    return e as HfosError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

let owner: TestUser;
let member: TestUser;
let wsId: string;

const addPerson = async (input: Record<string, unknown>) =>
  (await run(personCreate, { workspaceId: wsId, ignoreDuplicates: true, ...input }, owner)).output
    .personId;

const count = async (table: string, column: string, id: string) => {
  const [r] = await rows<{ n: number }>(
    admin(),
    sql`select count(*)::int as n from ${sql.raw(`app.${table}`)} where ${sql.raw(column)} = ${id}`,
  );
  return r!.n;
};

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('merge-owner'),
    createTestUser('merge-member'),
  ]);
  wsId = (await run(organizationCreate, { businessName: 'Merge Test HVAC' }, owner)).output
    .workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${member.id}, 'member')`,
  );
});
afterAll(closeTestDbs);

describe('mergedDetails', () => {
  const side = (s: Partial<MergeSide>): MergeSide => ({
    firstName: '',
    lastName: '',
    email: null,
    phoneE164: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    country: 'US',
    otherEmails: [],
    otherPhones: [],
    otherAddresses: [],
    companyId: null,
    notes: null,
    source: null,
    ...s,
  });

  it('fills in only what the record kept is missing', () => {
    const { patch, filled } = mergedDetails(
      side({ firstName: 'Maria', email: 'maria@example.com' }),
      side({
        firstName: 'M.',
        lastName: 'Lopez',
        phoneE164: '+17135550100',
        city: 'Houston',
        source: 'Google',
      }),
    );
    expect(patch).toMatchObject({
      lastName: 'Lopez',
      phoneE164: '+17135550100',
      phone: '(713) 555-0100',
      city: 'Houston',
      source: 'Google',
    });
    expect(patch.firstName).toBeUndefined();
    expect(patch.email).toBeUndefined();
    expect(filled).toEqual(['last name', 'phone number', 'address', 'source']);
  });

  it('keeps the duplicate’s own email, number and address among the other ones', () => {
    const { patch, filled } = mergedDetails(
      side({
        firstName: 'Maria',
        email: 'maria@example.com',
        phoneE164: '+17135550100',
        addressLine1: '1 Main St',
        city: 'Houston',
        otherPhones: [{ phone: '+17135550199', label: 'Work' }],
      }),
      side({
        firstName: 'Maria',
        email: 'MARIA@work.example.com',
        phoneE164: '+17135550101',
        addressLine1: '9 Elm St',
        city: 'Katy',
        otherPhones: [{ phone: '+17135550100' }],
      }),
    );
    expect(patch.otherEmails).toEqual([{ email: 'maria@work.example.com' }]);
    expect(patch.otherPhones).toEqual([
      { phone: '+17135550199', label: 'Work' },
      { phone: '+17135550101' },
    ]);
    expect(patch.otherAddresses).toEqual([{ line1: '9 Elm St', city: 'Katy', country: 'US' }]);
    expect(filled).toEqual(['other emails', 'other numbers', 'other addresses']);
  });

  it('keeps notes from both, once', () => {
    expect(
      mergedDetails(side({ notes: 'Gate code 1234' }), side({ notes: 'Has a dog' })).patch.notes,
    ).toBe('Gate code 1234\n\nHas a dog');
    expect(
      mergedDetails(side({ notes: 'Gate code 1234. Has a dog' }), side({ notes: 'Has a dog' }))
        .patch.notes,
    ).toBeUndefined();
  });

  it('changes nothing when the duplicate adds nothing', () => {
    const same = side({ firstName: 'Maria', email: 'maria@example.com' });
    expect(mergedDetails(same, same)).toEqual({ patch: {}, filled: [] });
  });
});

describe('person.merge', () => {
  it('moves everything onto the record kept, fills in what it lacked and archives the duplicate', async () => {
    const keep = await addPerson({
      firstName: 'Maria',
      lastName: 'Lopez',
      email: 'maria@example.com',
    });
    const dup = await addPerson({
      firstName: 'Maria',
      lastName: 'L',
      phone: '713 555 0142',
      email: 'maria.lopez@work.example.com',
      notes: 'Prefers texts',
    });
    const other = await addPerson({ firstName: 'Carlos', lastName: 'Lopez' });

    const lead = (
      await run(leadCreate, { workspaceId: wsId, title: 'AC tune-up', personId: dup }, owner)
    ).output.leadId;
    await run(taskCreate, { workspaceId: wsId, title: 'Call back', personId: dup }, owner);
    await run(
      activityLog,
      { workspaceId: wsId, kind: 'note', body: 'Asked about a new unit', personId: dup },
      owner,
    );
    const tag = (await run(tagCreate, { workspaceId: wsId, name: 'VIP' }, owner)).output.tagId;
    await run(
      recordSetTags,
      { workspaceId: wsId, recordType: 'person', recordId: dup, tagIds: [tag] },
      owner,
    );
    const type = (
      await run(
        relationshipTypeCreate,
        {
          workspaceId: wsId,
          a: { end: 'person', label: 'Spouse' },
          b: { end: 'person', label: 'Spouse' },
          mutual: true,
        },
        owner,
      )
    ).output.relationshipTypeId;
    await run(
      relationshipCreate,
      { workspaceId: wsId, relationshipTypeId: type, aId: dup, bId: other },
      owner,
    );
    // Somebody already said the two were related: that pair means nothing once they're one customer.
    await run(
      relationshipCreate,
      { workspaceId: wsId, relationshipTypeId: type, aId: dup, bId: keep },
      owner,
    );
    // A STOP on the duplicate holds on the record kept.
    await rows(
      admin(),
      sql`update app.people set sms_consent = 'opted_out', sms_consent_at = now(), sms_consent_source = 'STOP'
          where id = ${dup}`,
    );

    const done = await run(
      personMerge,
      { workspaceId: wsId, personId: dup, intoPersonId: keep },
      owner,
    );
    expect(done.output).toMatchObject({ personId: keep, mergedPersonId: dup });
    expect(done.output.filled).toEqual(['phone number', 'other emails', 'notes']);
    expect(done.output.moved).toMatchObject({ leads: 1, tasks: 1, tags: 1, relationships: 1 });

    // Nothing is left on the duplicate but its own history as it was written.
    expect(await count('leads', 'person_id', dup)).toBe(0);
    expect(await count('tasks', 'person_id', dup)).toBe(0);
    expect(await count('activities', 'person_id', dup)).toBe(0);
    expect(await count('leads', 'person_id', keep)).toBe(1);
    const [{ person_id: leadPerson } = { person_id: '' }] = await rows<{ person_id: string }>(
      admin(),
      sql`select person_id from app.leads where id = ${lead}`,
    );
    expect(leadPerson).toBe(keep);

    const { person } = await ask(personGet, { workspaceId: wsId, personId: keep }, member);
    expect(person.email).toBe('maria@example.com');
    expect(person.phoneE164).toBe('+17135550142');
    expect(person.otherEmails.map((e) => e.email)).toEqual(['maria.lopez@work.example.com']);
    expect(person.notes).toBe('Prefers texts');
    expect(person.tags.map((t) => t.name)).toEqual(['VIP']);
    expect(person.mergedInto).toBeNull();

    const gone = (await ask(personGet, { workspaceId: wsId, personId: dup }, member)).person;
    expect(gone.archivedAt).not.toBeNull();
    expect(gone.mergedInto).toEqual({ id: keep, fullName: 'Maria Lopez' });

    const [keptRow] = await rows<{ sms_consent: string; possible: string | null }>(
      admin(),
      sql`select sms_consent::text, possible_duplicate_of as possible from app.people where id = ${keep}`,
    );
    expect(keptRow!.sms_consent).toBe('opted_out');

    // The one relationship to someone else moved; the one between the two is gone.
    const pairs = await rows<{ a: string; b: string }>(
      admin(),
      sql`select a_person_id as a, b_person_id as b from app.relationships where type_id = ${type}`,
    );
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.a, pairs[0]!.b].sort()).toEqual([keep, other].sort());

    // Both records' timelines land on the one kept, with the merge on top.
    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'person', recordId: keep },
      owner,
    );
    expect(timeline.items[0]).toMatchObject({ kind: 'system', subtype: 'merged' });
    expect(describeTimeline(timeline.items[0]!, 'person')).toBe('merged Maria L into this person');
    expect(timeline.items.filter((i) => i.subtype === 'created')).toHaveLength(2);
    expect(timeline.items.some((i) => i.kind === 'note')).toBe(true);

    const [event] = await rows<{ payload: { mergedName: string; name: string } }>(
      admin(),
      sql`select payload from app.events where id = ${done.eventIds[0]}`,
    );
    expect(event!.payload).toMatchObject({ name: 'Maria Lopez', mergedName: 'Maria L' });

    // The duplicate stays archived: its history is the other record's now.
    await expectHfos(
      () => run(personRestore, { workspaceId: wsId, personId: dup }, owner),
      'rule_violation',
      'person_merged',
    );
    await expectHfos(
      () => run(personMerge, { workspaceId: wsId, personId: dup, intoPersonId: other }, owner),
      'rule_violation',
      'person_already_merged',
    );
    // Nor can anything be merged into it.
    await expectHfos(
      () => run(personMerge, { workspaceId: wsId, personId: other, intoPersonId: dup }, owner),
      'rule_violation',
      'person_merge_into_archived',
    );
  });

  it('carries over answers to fields the business still has, and the duplicate’s owner', async () => {
    const field = async (label: string) =>
      (await run(customFieldCreate, { workspaceId: wsId, entity: 'person', label }, owner)).output
        .customFieldId;
    const gate = await field('Gate code');
    const old = await field('Old field');
    const keep = await addPerson({ firstName: 'Nina', lastName: 'Park' });
    const dup = await addPerson({ firstName: 'Nina', lastName: 'P' });
    await rows(
      admin(),
      sql`update app.people set owner_user_id = ${member.id},
            custom = ${JSON.stringify({ [gate]: '4471', [old]: 'gone' })}::jsonb
          where id = ${dup}`,
    );
    await run(customFieldArchive, { workspaceId: wsId, customFieldId: old }, owner);

    await run(personMerge, { workspaceId: wsId, personId: dup, intoPersonId: keep }, owner);
    const [kept] = await rows<{ custom: Record<string, unknown>; owner_user_id: string | null }>(
      admin(),
      sql`select custom, owner_user_id from app.people where id = ${keep}`,
    );
    expect(kept!.custom).toEqual({ [gate]: '4471' });
    expect(kept!.owner_user_id).toBe(member.id);
  });

  it('is for owners and admins, and never merges a customer into themselves', async () => {
    const a = await addPerson({ firstName: 'Tom', lastName: 'Reed' });
    const b = await addPerson({ firstName: 'Tommy', lastName: 'Reed' });
    await expectHfos(
      () => run(personMerge, { workspaceId: wsId, personId: a, intoPersonId: b }, member),
      'forbidden',
    );
    await expectHfos(
      () => run(personMerge, { workspaceId: wsId, personId: a, intoPersonId: a }, owner),
      'validation',
    );
    // The database asks too: a member calling the merge directly is refused.
    const err = await expectPgError(() =>
      as(member)((tx) =>
        rows(tx, sql`select private.merge_people(${wsId}::uuid, ${a}::uuid, ${b}::uuid)`),
      ),
    );
    expect(err.detail).toBe('person_merge_forbidden');
    expect(await count('people', 'merged_into_id', b)).toBe(0);
  });

  it('keeps who a locked row is for fixed outside a merge', async () => {
    const a = await addPerson({ firstName: 'Ann', lastName: 'Fixed' });
    const b = await addPerson({ firstName: 'Bea', lastName: 'Fixed' });
    // A system timeline entry ("added this person") can't be moved by hand, even by the database's owner.
    const err = await expectPgError(() =>
      rows(
        admin(),
        sql`update app.activities set person_id = ${b} where person_id = ${a} and kind = 'system'`,
      ),
    );
    expect(err.detail).toBe('system_activity_immutable');
    // Nor can anybody mark a customer merged themselves.
    const mark = await expectPgError(() =>
      as(owner)((tx) =>
        rows(
          tx,
          sql`update app.people set merged_into_id = ${b}, merged_at = now() where id = ${a}`,
        ),
      ),
    );
    expect(mark.detail).toBe('person_merge_mark');
  });
});
