/**
 * Relationships (0101), end to end through the command pipeline: a business makes up a kind of record (pets), its
 * customers own them — many to many unless somebody says otherwise — and each pet has its own fields, notes,
 * tasks, visits and timeline. The pair reads both ways, "only one" is held to whoever writes, and archiving a kind
 * hides everything that rests on it without deleting any of it.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECORD_KIND_STARTERS, RELATIONSHIP_STARTERS } from '../src/relationships/starters';
import {
  activityLog,
  appointmentCreate,
  appointmentList,
  calendarCreate,
  calendarSetStatus,
  customFieldArchive,
  customFieldCreate,
  customFieldList,
  customFieldUpdate,
  customRecordArchive,
  customRecordCreate,
  customRecordGet,
  customRecordList,
  customRecordRestore,
  customRecordTypeArchive,
  customRecordTypeCreate,
  customRecordTypeList,
  customRecordTypeRestore,
  customRecordUpdate,
  fileBeginUpload,
  personCreate,
  personGet,
  recordSetFields,
  relationshipCreate,
  relationshipDelete,
  relationshipList,
  relationshipTypeCreate,
  relationshipTypeList,
  relationshipTypeUpdate,
  relationshipUpdate,
  taskComplete,
  taskCreate,
  taskList,
  timelineList,
} from '../src/server';
import {
  admin,
  ask,
  expectHfos,
  isoAt,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let outsider: TestUser;
let otherWs: string;
/** The Pets kind, its fields by label, and its Owner ↔ Pet relationship type. */
let pets: { id: string; field: (label: string) => string; ownerType: string };
let john: string;
let jane: string;
let jim: string;
let max: string;

const person = async (firstName: string, lastName = 'Doe') =>
  (await run(personCreate, { workspaceId: t.wsId, firstName, lastName }, t.member)).personId;

const pairsOf = (
  recordType: 'person' | 'company' | 'custom_record',
  recordId: string,
  u = t.member,
) => ask(relationshipList, { workspaceId: t.wsId, recordType, recordId }, u).then((r) => r.items);

const timeline = (recordType: 'person' | 'custom_record', recordId: string) =>
  ask(timelineList, { workspaceId: t.wsId, recordType, recordId }, t.member).then((r) => r.items);

beforeAll(async () => {
  t = await setupTeam(`rel-${randomUUID().slice(0, 6)}`);
  outsider = await createTestUser('rel-outsider');
  const { organizationCreate } = await import('../src/server');
  otherWs = (await run(organizationCreate, { businessName: 'Elsewhere Grooming' }, outsider))
    .workspaceId;
  john = await person('John');
  jane = await person('Jane');
  jim = await person('Jim', 'Smith');
});
afterAll(closeTestDbs);

describe('kinds of records', () => {
  it('a starter makes the kind, its fields and the relationship that ties it to customers, in one go', async () => {
    const starter = RECORD_KIND_STARTERS.find((s) => s.key === 'pets')!;
    const made = await run(
      customRecordTypeCreate,
      {
        workspaceId: t.wsId,
        singular: starter.singular,
        plural: starter.plural,
        nameLabel: starter.nameLabel,
        icon: starter.icon,
        fields: starter.fields,
        link: starter.link,
      },
      t.owner,
    );
    expect(made.key).toBe('pet');
    expect(made.customFieldIds).toHaveLength(4);
    expect(made.relationshipTypeId).not.toBeNull();

    const { types } = await ask(customRecordTypeList, { workspaceId: t.wsId }, t.member);
    expect(types).toEqual([
      expect.objectContaining({
        id: made.customRecordTypeId,
        singular: 'Pet',
        plural: 'Pets',
        icon: 'paw',
        fieldCount: 4,
        recordCount: 0,
      }),
    ]);
    const { fields } = await ask(
      customFieldList,
      { workspaceId: t.wsId, recordTypeId: made.customRecordTypeId },
      t.member,
    );
    expect(fields.map((f) => [f.label, f.type, f.key])).toEqual([
      ['Species', 'choice', 'species'],
      ['Breed', 'text', 'breed'],
      ['Birthday', 'date', 'birthday'],
      ['Weight (lb)', 'number', 'weight_lb'],
    ]);
    expect(fields[0]!.options.map((o) => o.label)).toEqual(['Dog', 'Cat', 'Other']);

    const rt = (await ask(relationshipTypeList, { workspaceId: t.wsId }, t.member)).types;
    expect(rt).toEqual([
      expect.objectContaining({
        id: made.relationshipTypeId,
        cardinality: 'many_to_many',
        mutual: false,
        a: expect.objectContaining({ end: 'person', label: 'Owner', recordType: null }),
        b: expect.objectContaining({
          end: 'custom_record',
          label: 'Pet',
          recordType: expect.objectContaining({ id: made.customRecordTypeId, singular: 'Pet' }),
        }),
      }),
    ]);
    const byLabel = new Map(fields.map((f) => [f.label, f.id]));
    pets = {
      id: made.customRecordTypeId,
      field: (label) => byLabel.get(label)!,
      ownerType: made.relationshipTypeId!,
    };
  });

  it('only owners and admins shape the business’s records; a second “Pet” is refused', async () => {
    await expectHfos(
      () => run(customRecordTypeCreate, { workspaceId: t.wsId, singular: 'Vehicle' }, t.member),
      'forbidden',
    );
    await expectHfos(
      () => run(customRecordTypeCreate, { workspaceId: t.wsId, singular: 'pet' }, t.owner),
      'record_type_taken',
    );
    await expectHfos(
      () =>
        run(
          relationshipTypeCreate,
          {
            workspaceId: t.wsId,
            a: { end: 'person', label: 'Parent' },
            b: { end: 'person', label: 'Child' },
          },
          t.member,
        ),
      'forbidden',
    );
  });

  it('a second kind’s field of the same name takes the next key, first among its own kind', async () => {
    const horses = await run(
      customRecordTypeCreate,
      { workspaceId: t.wsId, singular: 'Horse', fields: [{ label: 'Breed' }] },
      t.owner,
    );
    const { fields } = await ask(
      customFieldList,
      { workspaceId: t.wsId, recordTypeId: horses.customRecordTypeId },
      t.member,
    );
    expect(fields.map((f) => [f.label, f.key, f.position])).toEqual([['Breed', 'breed_2', 0]]);
  });
});

describe('pairs, both ways', () => {
  it('adding a pet from its owner’s page relates them, and each page lists the other', async () => {
    const made = await run(
      customRecordCreate,
      {
        workspaceId: t.wsId,
        typeId: pets.id,
        name: 'Max',
        values: { [pets.field('Breed')]: 'Golden retriever', [pets.field('Species')]: 'dog' },
        relateTo: { relationshipTypeId: pets.ownerType, recordId: john, side: 'b' },
      },
      t.member,
    );
    max = made.customRecordId;
    expect(made.relationshipId).not.toBeNull();

    expect(await pairsOf('person', john)).toEqual([
      expect.objectContaining({
        side: 'a',
        label: 'Pet',
        ownLabel: 'Owner',
        other: expect.objectContaining({
          kind: 'custom_record',
          id: max,
          name: 'Max',
          detail: 'Dog · Golden retriever',
          recordType: expect.objectContaining({ singular: 'Pet', icon: 'paw' }),
        }),
      }),
    ]);
    expect(await pairsOf('custom_record', max)).toEqual([
      expect.objectContaining({
        side: 'b',
        label: 'Owner',
        ownLabel: 'Pet',
        other: expect.objectContaining({ kind: 'person', id: john, name: 'John Doe' }),
      }),
    ]);

    // Both timelines hear of it, from one entry; the pet's own starts with "added this pet".
    // (Both are written by one command, so they can share a millisecond: found by subtype, not by order.)
    const entries = await timeline('custom_record', max);
    expect(entries.map((e) => e.subtype).sort()).toEqual(['created', 'related']);
    expect(entries.find((e) => e.subtype === 'created')!.meta).toMatchObject({ kind: 'Pet' });
    const related = entries.find((e) => e.subtype === 'related')!;
    expect(related).toMatchObject({ personId: john, customRecordId: max });
    expect((await timeline('person', john)).map((e) => e.id)).toContain(related.id);
  });

  it('is many to many unless somebody says otherwise: two owners for Max, two pets for John', async () => {
    await run(
      relationshipCreate,
      { workspaceId: t.wsId, relationshipTypeId: pets.ownerType, aId: jane, bId: max },
      t.member,
    );
    const bella = await run(
      customRecordCreate,
      {
        workspaceId: t.wsId,
        typeId: pets.id,
        name: 'Bella',
        relateTo: { relationshipTypeId: pets.ownerType, recordId: john, side: 'b' },
      },
      t.member,
    );
    expect((await pairsOf('custom_record', max)).map((p) => p.other.name).sort()).toEqual([
      'Jane Doe',
      'John Doe',
    ]);
    expect((await pairsOf('person', john)).map((p) => p.other.name).sort()).toEqual([
      'Bella',
      'Max',
    ]);
    await expectHfos(
      () =>
        run(
          relationshipCreate,
          {
            workspaceId: t.wsId,
            relationshipTypeId: pets.ownerType,
            aId: john,
            bId: bella.customRecordId,
          },
          t.member,
        ),
      'already_related',
    );
    // The wrong kind on an end, and a record related to itself, are refused.
    await expectHfos(
      () =>
        run(
          relationshipCreate,
          { workspaceId: t.wsId, relationshipTypeId: pets.ownerType, aId: max, bId: john },
          t.member,
        ),
      'validation',
    );
  });

  it('saying “one” is refused while a record has more, and held once it’s said', async () => {
    await expectHfos(
      () =>
        run(
          relationshipTypeUpdate,
          { workspaceId: t.wsId, relationshipTypeId: pets.ownerType, cardinality: 'one_to_many' },
          t.owner,
        ),
      'relationship_cardinality_conflict',
    );
    const janeAndMax = (await pairsOf('person', jane)).find((p) => p.other.id === max)!;
    await run(relationshipDelete, { workspaceId: t.wsId, relationshipId: janeAndMax.id }, t.member);
    // One owner per pet, many pets per owner.
    await run(
      relationshipTypeUpdate,
      { workspaceId: t.wsId, relationshipTypeId: pets.ownerType, cardinality: 'one_to_many' },
      t.owner,
    );
    const err = await expectHfos(
      () =>
        run(
          relationshipCreate,
          { workspaceId: t.wsId, relationshipTypeId: pets.ownerType, aId: jim, bId: max },
          t.member,
        ),
      'relationship_end_full',
    );
    expect(err.message).toBe('Max already has an owner. Each pet can have only one.');
    // Taking a pair apart is on both timelines.
    expect((await timeline('person', jane))[0]).toMatchObject({ subtype: 'unrelated' });
    expect((await timeline('custom_record', max))[0]).toMatchObject({ subtype: 'unrelated' });
    await run(
      relationshipTypeUpdate,
      { workspaceId: t.wsId, relationshipTypeId: pets.ownerType, cardinality: 'many_to_many' },
      t.owner,
    );
  });

  it('a mutual type has no direction: spouses are one pair whichever way they’re entered, one each', async () => {
    const starter = RELATIONSHIP_STARTERS.find((s) => s.key === 'spouse')!;
    const { relationshipTypeId } = await run(
      relationshipTypeCreate,
      {
        workspaceId: t.wsId,
        a: starter.a,
        b: starter.b,
        cardinality: starter.cardinality,
        mutual: starter.mutual,
      },
      t.owner,
    );
    await run(
      relationshipCreate,
      { workspaceId: t.wsId, relationshipTypeId, aId: jane, bId: john, note: 'Married 2015' },
      t.member,
    );
    await expectHfos(
      () =>
        run(
          relationshipCreate,
          { workspaceId: t.wsId, relationshipTypeId, aId: john, bId: jane },
          t.member,
        ),
      'already_related',
    );
    const err = await expectHfos(
      () =>
        run(
          relationshipCreate,
          { workspaceId: t.wsId, relationshipTypeId, aId: jim, bId: jane },
          t.member,
        ),
      'relationship_end_full',
    );
    expect(err.message).toBe('Jane Doe already has a spouse. Each customer can have only one.');
    const spouse = (await pairsOf('person', jane)).find((p) => p.typeId === relationshipTypeId)!;
    expect(spouse).toMatchObject({
      label: 'Spouse',
      ownLabel: 'Spouse',
      mutual: true,
      note: 'Married 2015',
    });
    expect(spouse.other.id).toBe(john);
    expect(
      (await pairsOf('person', john)).find((p) => p.typeId === relationshipTypeId)!.other.id,
    ).toBe(jane);
    // Two people: one timeline entry each, one of them carrying the event.
    const [row] = await rows<{ n: number; events: number }>(
      admin(),
      sql`select count(*)::int as n, count(event_id)::int as events from app.activities
          where subtype = 'related' and meta ->> 'typeId' = ${relationshipTypeId}`,
    );
    expect(row).toEqual({ n: 2, events: 1 });
    await run(
      relationshipUpdate,
      { workspaceId: t.wsId, relationshipId: spouse.id, note: null },
      t.member,
    );
    expect((await pairsOf('person', jane)).find((p) => p.id === spouse.id)!.note).toBeNull();
  });

  it('nobody outside the business sees or relates its records', async () => {
    await expectHfos(
      () => ask(customRecordGet, { workspaceId: t.wsId, customRecordId: max }, outsider),
      'not_found',
    );
    await expectHfos(
      () => ask(customRecordGet, { workspaceId: otherWs, customRecordId: max }, outsider),
      'not_found',
    );
    await expectHfos(
      () =>
        run(
          relationshipCreate,
          { workspaceId: otherWs, relationshipTypeId: pets.ownerType, aId: john, bId: max },
          outsider,
        ),
      'not_found',
    );
  });
});

describe('a record’s own fields, notes, tasks, files and visits', () => {
  it('fields are checked against their type, found by search, and cleared with nothing', async () => {
    const birthday = pets.field('Birthday');
    await expectHfos(
      () =>
        run(
          recordSetFields,
          {
            workspaceId: t.wsId,
            recordType: 'custom_record',
            recordId: max,
            values: { [pets.field('Species')]: 'dragon', [birthday]: '2021-02-30' },
          },
          t.member,
        ),
      'validation',
    );
    const set = await run(
      recordSetFields,
      {
        workspaceId: t.wsId,
        recordType: 'custom_record',
        recordId: max,
        values: {
          [birthday]: '2021-03-04',
          [pets.field('Weight (lb)')]: '64',
          [pets.field('Breed')]: null,
        },
      },
      t.member,
    );
    expect(set.updated.sort()).toEqual(
      [birthday, pets.field('Weight (lb)'), pets.field('Breed')].sort(),
    );
    const { record } = await ask(
      customRecordGet,
      { workspaceId: t.wsId, customRecordId: max },
      t.member,
    );
    expect(record.custom).toEqual({
      [pets.field('Species')]: 'dog',
      [birthday]: '2021-03-04',
      [pets.field('Weight (lb)')]: 64,
    });
    expect(record.type).toMatchObject({ singular: 'Pet', nameLabel: 'Pet’s name' });
    // A field that belongs to customers isn't on a pet.
    const gate = await run(
      customFieldCreate,
      { workspaceId: t.wsId, entity: 'person', label: 'Gate code' },
      t.owner,
    );
    await expectHfos(
      () =>
        run(
          recordSetFields,
          {
            workspaceId: t.wsId,
            recordType: 'custom_record',
            recordId: max,
            values: { [gate.customFieldId]: '1234' },
          },
          t.member,
        ),
      'validation',
    );
    const found = await ask(
      customRecordList,
      { workspaceId: t.wsId, typeId: pets.id, q: '64' },
      t.member,
    );
    expect(found.items.map((r) => r.name)).toEqual(['Max']);
    expect(found.items[0]!.related).toEqual([
      expect.objectContaining({ kind: 'person', id: john, label: 'Owner' }),
    ]);
  });

  it('a customer’s own fields are filled in the same way, and their page reads them', async () => {
    const { fields } = await ask(
      customFieldList,
      { workspaceId: t.wsId, entity: 'person' },
      t.member,
    );
    const gate = fields.find((f) => f.label === 'Gate code')!;
    const res = await run(
      recordSetFields,
      {
        workspaceId: t.wsId,
        recordType: 'person',
        recordId: john,
        values: { [gate.id]: ' 4321# ' },
      },
      t.member,
    );
    expect(res.updated).toEqual([gate.id]);
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId: john }, t.member);
    expect(person.custom).toEqual({ [gate.id]: '4321#' });
    // Recorded as the customer changing, under the field's key.
    const [event] = await rows<{ payload: { fields: string[] }; after: Record<string, unknown> }>(
      admin(),
      sql`select e.payload, a.after from app.events e join app.audit_logs a on a.event_id = e.id
          where e.entity_id = ${john} and e.event_type = 'person.updated' order by e.created_at desc limit 1`,
    );
    expect(event!.payload.fields).toEqual([`custom.${gate.id}`]);
    expect(event!.after).toMatchObject({ 'custom.gate_code': '4321#' });
    // Renaming keeps the key; archiving takes the value off the customer.
    await run(
      customFieldUpdate,
      { workspaceId: t.wsId, customFieldId: gate.id, label: 'Access code' },
      t.owner,
    );
    await run(customFieldArchive, { workspaceId: t.wsId, customFieldId: gate.id }, t.owner);
    expect(
      (await ask(personGet, { workspaceId: t.wsId, personId: john }, t.member)).person.custom,
    ).toEqual({});
  });

  it('notes, tasks and files hang off the record, and its timeline tells them', async () => {
    await run(
      activityLog,
      { workspaceId: t.wsId, kind: 'note', body: 'Nervous with clippers.', customRecordId: max },
      t.member,
    );
    const task = await run(
      taskCreate,
      { workspaceId: t.wsId, title: 'Rabies booster due', customRecordId: max, personId: john },
      t.member,
    );
    const tasks = await ask(
      taskList,
      { workspaceId: t.wsId, scope: 'all', status: 'all', customRecordId: max },
      t.member,
    );
    expect(tasks.items).toEqual([
      expect.objectContaining({
        id: task.taskId,
        customRecord: expect.objectContaining({ id: max, name: 'Max', kind: 'Pet', icon: 'paw' }),
      }),
    ]);
    await run(taskComplete, { workspaceId: t.wsId, taskId: task.taskId }, t.member);
    const reserved = await run(
      fileBeginUpload,
      {
        workspaceId: t.wsId,
        recordType: 'custom_record',
        recordId: max,
        name: 'vaccination record.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      },
      t.member,
    );
    expect(reserved.objectPath).toContain(`/custom_record/${max}/`);
    const subtypes = (await timeline('custom_record', max)).map((e) => e.subtype ?? e.kind);
    expect(subtypes.slice(0, 2)).toEqual(['task_done', 'note']);
  });

  it('a visit can be for the pet: it lists by the pet and lands on its timeline once', async () => {
    const created = await run(
      calendarCreate,
      { workspaceId: t.wsId, name: 'Grooming', preset: 'personal' },
      t.owner,
    );
    await run(
      calendarSetStatus,
      { workspaceId: t.wsId, calendarId: created.calendarId, status: 'active' },
      t.owner,
    );
    const day = nextWeekday(3);
    const booked = await run(
      appointmentCreate,
      {
        workspaceId: t.wsId,
        calendarId: created.calendarId,
        startsAt: isoAt(day, '10:00'),
        personId: john,
        customRecordId: max,
        title: 'Full groom',
        notify: false,
      },
      t.owner,
    );
    const { items } = await ask(
      appointmentList,
      {
        workspaceId: t.wsId,
        from: isoAt(day, '00:00'),
        to: isoAt(day, '23:59'),
        customRecordId: max,
      },
      t.member,
    );
    expect(items).toEqual([
      expect.objectContaining({
        id: booked.appointmentId,
        customRecord: { id: max, name: 'Max', kind: 'Pet' },
      }),
    ]);
    const booking = (await timeline('custom_record', max)).filter(
      (e) => e.subtype === 'appointment_booked',
    );
    expect(booking).toHaveLength(1);
    expect(booking[0]).toMatchObject({ personId: john, customRecordId: max, body: 'Full groom' });
  });
});

describe('archiving', () => {
  it('only owners and admins archive a record; archived, it leaves lists and can’t be related', async () => {
    await expectHfos(
      () => run(customRecordArchive, { workspaceId: t.wsId, customRecordId: max }, t.member),
      'forbidden',
    );
    await run(customRecordArchive, { workspaceId: t.wsId, customRecordId: max }, t.owner);
    const listed = await ask(customRecordList, { workspaceId: t.wsId, typeId: pets.id }, t.member);
    expect(listed.items.map((r) => r.name)).toEqual(['Bella']);
    await expectHfos(
      () =>
        run(
          relationshipCreate,
          { workspaceId: t.wsId, relationshipTypeId: pets.ownerType, aId: jim, bId: max },
          t.member,
        ),
      'record_archived',
    );
    // Still on John's page, marked archived.
    expect((await pairsOf('person', john)).find((p) => p.other.id === max)!.other.archived).toBe(
      true,
    );
    await run(customRecordRestore, { workspaceId: t.wsId, customRecordId: max }, t.owner);
    await run(
      customRecordUpdate,
      { workspaceId: t.wsId, customRecordId: max, name: 'Maximus' },
      t.member,
    );
    expect((await timeline('custom_record', max)).map((e) => e.subtype).slice(0, 2)).toEqual([
      'restored',
      'archived',
    ]);
  });

  it('archiving a kind hides its records’ relationships everywhere; restoring brings them back', async () => {
    const archived = await run(
      customRecordTypeArchive,
      { workspaceId: t.wsId, customRecordTypeId: pets.id },
      t.owner,
    );
    expect(archived.archivedRelationshipTypes).toBe(1);
    expect((await pairsOf('person', john)).filter((p) => p.other.kind === 'custom_record')).toEqual(
      [],
    );
    await expectHfos(
      () =>
        run(customRecordCreate, { workspaceId: t.wsId, typeId: pets.id, name: 'Rex' }, t.member),
      'record_type_archived',
    );
    await run(
      customRecordTypeRestore,
      { workspaceId: t.wsId, customRecordTypeId: pets.id },
      t.owner,
    );
    expect(
      (await pairsOf('person', john))
        .filter((p) => p.other.kind === 'custom_record')
        .map((p) => p.other.name)
        .sort(),
    ).toEqual(['Bella', 'Maximus']);
  });
});
