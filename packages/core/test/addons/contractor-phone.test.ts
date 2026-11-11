/**
 * Contractor Operations on the phone (docs/contractor.md, "On the phone"; part 6), on the database:
 *
 * - What phones keep is what the manifest says, and never money (the owner's decision 11).
 * - A note from the field is typed, spoken or photographed, made once under the phone's own id and stamped with the
 *   moment it was taken; its photos and recording are the job's own files; a recording's words come once; people
 *   take off their own notes, and someone who sets the add-on up anyone's.
 * - Work that waited on a phone lands as it was done: counts of what was used add up, a tick carries the moment it
 *   was made, a break sits where it was pressed, and what was done before the office closed the job still counts.
 * - The phone's views (`views/phone.ts`) answer, from the rows a phone holds, what the server's queries answer.
 * - A job that leaves phones takes its rows with it, and brings them back.
 * - The phone's list of commands gives each of the add-on's the class the server does.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { PHONE_COMMANDS } from '../../../../apps/mobile/src/changes/commands';
import { contractorAddon } from '../../src/addons/contractor/manifest';
import { contractorAddonServer } from '../../src/addons/contractor/server';
import {
  contractorCopyOf,
  phoneDayVisits,
  phoneJob,
  phoneJobList,
  phoneMaterials,
  phoneNotes,
  phoneTime,
  phoneWorkOrder,
  type ContractorSource,
} from '../../src/addons/contractor/views/phone';
import { CONTRACTOR_WORDS } from '../../src/addons/contractor/words';
import type { AddonManifest, AddonOfflineTable } from '../../src/addons/manifest';
import { addDays, startOfLocalDay } from '../../src/calendar/engine/zoned';
import type { RequestMeta } from '../../src/kernel/types';
import {
  addonRef,
  customRecordArchive,
  executeCommand,
  executeQuery,
  organizationCreate,
  registry,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type SystemActor,
} from '../../src/server';
import { cells } from './realestate-phone-fixture';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const ops = [...(contractorAddonServer.commands ?? []), ...(contractorAddonServer.queries ?? [])];
const op = (name: string) => {
  const found = ops.find((o) => o.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

/** As a person, in the business. */
function as(u: TestUser, name: string, input: Record<string, unknown> = {}): Promise<Any> {
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        api(),
        found as CommandDef,
        { workspaceId: ws, ...input },
        human(u),
        meta(),
      ).then((r) => r.output)
    : executeQuery(api(), found as QueryDef, { workspaceId: ws, ...input }, human(u), meta());
}
/** A change made on the phone at a moment and sent when it had signal, under its own command id. */
function phone(u: TestUser, name: string, input: Record<string, unknown>, at: Date): Promise<Any> {
  const sent: RequestMeta = {
    correlationId: randomUUID(),
    channel: 'mobile',
    commandId: randomUUID(),
    occurredAt: at,
    sentAt: new Date(),
    confirmedAt: null,
    appVersion: '1.0.0',
  };
  return executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(u),
    sent,
  ).then((r) => r.output);
}
/** As the worker, acting for the add-on. */
function worker(name: string, input: Record<string, unknown>): Promise<Any> {
  const actor: SystemActor = {
    type: 'system',
    workspaceId: ws,
    organizationId: orgId,
    addon: addonRef(contractorAddon),
  };
  return executeCommand(
    testDbs().worker.db,
    op(name) as CommandDef<z.ZodType, z.ZodType>,
    { workspaceId: ws, ...input },
    actor,
    meta(),
  ).then((r) => r.output);
}
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );

let owner: TestUser;
let member: TestUser;
/** Another tech, who only uses the add-on. */
let other: TestUser;
let ws: string;
let orgId: string;
let customerId: string;
let calendarId: string;

/** The add-on on, set up the way the worker sets it up when it arrives: its kinds of records and relationships. */
async function install(id: string): Promise<void> {
  const manifest: AddonManifest = contractorAddon;
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${id}, 'contractor', 'enabled', ${contractorAddon.version})`,
  );
  const kinds = new Map<string, string>();
  for (const [i, k] of (manifest.recordKinds ?? []).entries()) {
    const [row] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, name_label, icon, position,
            addon_id, write_permission, kept_to_team, see_all_permission)
          values (${id}, ${k.key}, ${k.singular}, ${k.plural}, ${k.nameLabel ?? 'Name'}, ${k.icon ?? 'box'},
            ${900 + i}, 'contractor', ${k.writePermission}, ${k.keptToTeam !== undefined},
            ${k.keptToTeam?.seeAllPermission ?? null})
          returning id`,
    );
    kinds.set(k.key, row!.id);
  }
  for (const [i, t] of (manifest.relationshipTypes ?? []).entries()) {
    const end = (e: typeof t.a) =>
      e.kind === 'record'
        ? { end: 'custom_record', kind: kinds.get(e.recordKind)! }
        : { end: e.kind, kind: null };
    const a = end(t.a);
    const b = end(t.b);
    await rows(
      admin(),
      sql`insert into app.relationship_types (workspace_id, a_end, a_record_type_id, a_label, b_end,
            b_record_type_id, b_label, cardinality, position, addon_id, addon_key, portal_visible)
          values (${id}, ${a.end}::app.relationship_end, ${a.kind}, ${t.aLabel}, ${b.end}::app.relationship_end,
            ${b.kind}, ${t.bLabel}, ${t.cardinality ?? 'many_to_many'}::app.relationship_cardinality, ${900 + i},
            'contractor', ${t.key}, ${t.portal === true})`,
    );
  }
}

/** A job for the customer at an address of its own. */
const job = (name: string, more: Record<string, unknown> = {}) =>
  as(owner, 'contractor.job.open', {
    name,
    customerPersonId: customerId,
    newPropertyAddress: `${name}, 4 Birch Ln`,
    trade: 'electrical',
    ...more,
  }).then((o) => o.jobId as string);

/**
 * A visit on a job at the customer's address, so many hours from now: an ordinary appointment whose record is the
 * job, with the work order the worker starts for every visit booked on one.
 */
async function visit(jobId: string, hoursOut: number): Promise<string> {
  const [a] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
          custom_record_id, owner_user_id, location)
        values (${ws}, ${calendarId}, 1, 'Site visit', now() + make_interval(hours => ${hoursOut}),
          now() + make_interval(hours => ${hoursOut + 1}), ${jobId}, ${owner.id},
          jsonb_build_object('kind', 'customer_address', 'address', '4 Birch Ln'))
        returning id`,
  );
  await worker('contractor.work_order.start', { appointmentId: a!.id });
  return a!.id;
}
/** Where a visit's crew has it: core's job for the visit, as its status buttons leave it. */
async function stage(appointmentId: string, status: string): Promise<void> {
  const [j] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.jobs (workspace_id, person_id, title, status)
        values (${ws}, ${customerId}, 'Site visit', ${status}) returning id`,
  );
  await rows(
    admin(),
    sql`update app.appointments set job_id = ${j!.id} where id = ${appointmentId}`,
  );
}
/** Puts people on a visit, as booking them does. */
async function onVisit(appointmentId: string, ...people: TestUser[]): Promise<void> {
  for (const p of people)
    await rows(
      admin(),
      sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
          values (${ws}, ${appointmentId}, ${p.id})`,
    );
}
/** A file on a job, uploaded. */
const file = (jobId: string, name: string, mime: string) =>
  rows<{ id: string }>(
    admin(),
    sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, status,
          created_by)
        values (${ws}, 'custom_record', ${jobId}, ${`${ws}/${randomUUID()}`}, ${name}, ${mime}, 'ready',
          ${owner.id})
        returning id`,
  ).then((r) => r[0]!.id);
/** Closes a job the way the office does, whatever its checklists say. */
const close = (jobId: string) =>
  as(owner, 'contractor.job.set_status', {
    jobId,
    status: 'done',
    skipReason: 'Closed from the office',
  });

/**
 * The rows the sync streams send `u` (apps/sync/sync-config.yaml), as text the way PowerSync stores them: the
 * add-on's records, rows and links by their keys and seals (records_v1), and core's people, team, appointments,
 * visit jobs and files (business_v1).
 */
async function phoneRows(u: TestUser): Promise<ContractorSource> {
  const keys = await rows<{ kind: string; key: string }>(
    admin(),
    sql`select kind, key from app.sync_keys where user_id = ${u.id} and workspace_id = ${ws}`,
  );
  const list = (kind: string) =>
    `{${keys
      .filter((k) => k.kind === kind)
      .map((k) => `"${k.key}"`)
      .join(',')}}`;
  const use = list('use');
  const all = list('all');
  const sealed = (t: string) =>
    sql.raw(`((${t}.seal_scope = any('${use}'::text[]) and ${t}.seal_open)
      or ${t}.seal_all = any('${all}'::text[])
      or (${t}.seal_scope = any('${use}'::text[]) and '${u.id}'::uuid = any(${t}.seal_viewer_ids)))
      and ${t}.sync_window`);
  const db = admin();
  const read = async (q: ReturnType<typeof sql>) => cells(await rows(db, q));
  return {
    records: await read(
      sql`select r.id, t.key as kind_key, r.name, r.archived_at
          from app.custom_records r join app.custom_record_types t on t.id = r.type_id
          where r.workspace_id = ${ws} and t.addon_id = 'contractor' and ${sealed('r')}`,
    ),
    rows: await read(
      sql`select p.id, p.source, p.record_id, p.data from app.addon_phone_rows p
          where p.workspace_id = ${ws} and p.addon_id = 'contractor' and ${sealed('p')}`,
    ),
    links: await read(
      sql`select t.addon_key, l.a_person_id, l.a_custom_record_id, l.b_custom_record_id, l.created_at
          from app.relationships l join app.relationship_types t on t.id = l.type_id
          where l.workspace_id = ${ws} and t.addon_id = 'contractor' and ${sealed('l')}`,
    ),
    people: await read(
      sql`select id, first_name, last_name, email, phone_e164, company_id, archived_at
          from app.people where workspace_id = ${ws}`,
    ),
    companies: await read(sql`select id, name from app.companies where workspace_id = ${ws}`),
    users: await read(
      sql`select u.id, u.full_name, u.email from app.users u
          join app.workspace_memberships m on m.user_id = u.id where m.workspace_id = ${ws}`,
    ),
    appointments: await read(
      sql`select id, title, starts_at, ends_at, status, location, job_id from app.appointments
          where workspace_id = ${ws} and sync_window and not sealed`,
    ),
    staff: await read(
      sql`select appointment_id, user_id, active, created_at from app.appointment_staff
          where workspace_id = ${ws} and sync_window`,
    ),
    visitJobs: await read(sql`select id, status from app.jobs where workspace_id = ${ws} and open`),
    files: await read(
      sql`select id, name, mime_type, status from app.files
          where workspace_id = ${ws} and deleted_at is null and record_type <> 'knowledge' and not sealed`,
    ),
  } as unknown as ContractorSource;
}

beforeAll(async () => {
  [owner, member, other] = await Promise.all([
    createTestUser('contractor-phone-owner', { fullName: 'Olive Owner' }),
    createTestUser('contractor-phone-member', { fullName: 'Marco Member' }),
    createTestUser('contractor-phone-other', { fullName: 'Tess Tech' }),
  ]);
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Bright Line Electric' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  orgId = made.output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${member.id}, 'member'), (${ws}, ${other.id}, 'member')`,
  );
  await install(ws);
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.people (workspace_id, first_name, last_name, phone_e164)
        values (${ws}, 'Dana', 'Reyes', '+15125550142') returning id`,
  );
  customerId = p!.id;
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.calendars (workspace_id, name, slug)
        values (${ws}, 'Jobs', ${`jobs-${randomUUID().slice(0, 8)}`}) returning id`,
  );
  calendarId = c!.id;
}, 60_000);
afterAll(closeTestDbs);

// ---------- the tests ----------

/** The worker passing on a visit's button, pressed at a moment. */
const press = (appointmentId: string, status: string, at: Date, by?: TestUser) =>
  worker('contractor.time.follow_status', {
    appointmentId,
    status,
    at: at.toISOString(),
    byUserId: by?.id ?? null,
  });
/** Moments so many minutes before now, to the second, so sums come out exact. */
const clock = () => {
  const base = Math.floor(Date.now() / 1000) * 1000;
  return (minutesAgo: number) => new Date(base - minutesAgo * 60_000);
};
const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
  (await rows<T>(admin(), q))[0]!;
const ms = (v: string | Date) => new Date(v).getTime();

describe('what phones keep', () => {
  it('is what the manifest says, with no money in it', async () => {
    const registered = await rows<{
      source: string;
      key_column: string;
      record_column: string | null;
      columns: string[];
      reach: string;
      owner_column: string | null;
      keep_column: string | null;
      keep_values: string[] | null;
    }>(
      admin(),
      sql`select source, key_column, record_column, columns, reach, owner_column, keep_column, keep_values
          from app.addon_phone_tables where addon_id = 'contractor' order by source collate "C"`,
    );
    const declared = (contractorAddon.offline?.tables ?? []) as readonly AddonOfflineTable[];
    expect(registered).toEqual(
      [...declared]
        .sort((a, b) => (a.table < b.table ? -1 : 1))
        .map((t) => ({
          source: t.table,
          key_column: t.key ?? 'id',
          record_column: t.record ?? null,
          columns: [...t.columns],
          reach: t.reach ?? 'team',
          owner_column: t.owner ?? null,
          keep_column: t.keep?.column ?? null,
          keep_values: t.keep ? [...t.keep.values] : null,
        })),
    );
    // The owner's decision 11: a tech's phone holds no price, budget or cost.
    const money = [
      'money',
      'estimating',
      'item_costs',
      'estimates',
      'estimate_costs',
      'estimate_oks',
      'material_costs',
      'time_costs',
      'labor_rates',
      'other_costs',
    ];
    expect(declared.filter((t) => money.includes(t.table))).toEqual([]);
    expect(
      declared.flatMap((t) => t.columns).filter((c) => /cents|cost|price|rate|margin/.test(c)),
    ).toEqual([]);
  });
});

describe('notes from the field', () => {
  it('keeps a typed note, and one from a phone under its own id and moment, once', async () => {
    const jobId = await job('Rewire the garage');
    const appointmentId = await visit(jobId, 2);
    const typed = await as(member, 'contractor.note.add', {
      jobId,
      body: '  The panel is behind the freezer.  ',
    });
    expect(typed).toMatchObject({ jobId, appointmentId: null });
    // Taken with no signal an hour ago, on the visit.
    const id = randomUUID();
    const taken = clock()(60);
    const sent = { jobId, id, appointmentId, body: 'Needs a 60A breaker.' };
    expect(await phone(member, 'contractor.note.add', sent, taken)).toEqual({
      noteId: id,
      jobId,
      appointmentId,
    });
    // Sent again after its answer was lost: the same note, not a second one.
    expect(await phone(member, 'contractor.note.add', sent, new Date())).toMatchObject({
      noteId: id,
    });
    const list = await as(other, 'contractor.note.list', { jobId });
    expect(
      list.notes.map((n: Any) => [n.body, n.appointmentId, n.by?.userId, n.audio, n.photoFileIds]),
    ).toEqual([
      ['The panel is behind the freezer.', null, member.id, null, []],
      ['Needs a 60A breaker.', appointmentId, member.id, null, []],
    ]);
    expect(ms(list.notes[1].notedAt)).toBe(taken.getTime());
    expect(list.may).toEqual({ removeAny: false });
    expect((await as(other, 'contractor.note.list', { jobId, appointmentId })).notes).toHaveLength(
      1,
    );
    // The same id can't make a note somewhere else.
    const elsewhere = await job('Another job');
    expect(
      await refused(
        phone(member, 'contractor.note.add', { ...sent, jobId: elsewhere }, new Date()),
      ),
    ).toBe('validation');
    // A visit of another job isn't this one's; a note says something.
    expect(
      await refused(
        as(member, 'contractor.note.add', { jobId: elsewhere, appointmentId, body: 'Hm' }),
      ),
    ).toBe('contractor_note_visit_elsewhere');
    expect(await refused(as(member, 'contractor.note.add', { jobId }))).toBe('validation');
    // On the job's timeline, in the add-on's words.
    const line = await one<{ words: string }>(
      sql`select meta ->> 'words' as words from app.activities
          where custom_record_id = ${jobId} and meta ->> 'words' like 'added a note%'
          order by created_at desc limit 1`,
    );
    expect(line.words).toBe('added a note: “Needs a 60A breaker.”');
    // A finished job still takes notes.
    await close(jobId);
    expect(
      await as(member, 'contractor.note.add', { jobId, body: 'Customer called: all good.' }),
    ).toMatchObject({ jobId });
  });

  it('takes photos and a recording only from the job’s own files, and gets the recording’s words once', async () => {
    const jobId = await job('Add a subpanel');
    const elsewhere = await job('Somewhere else');
    const [photo, pdf, audio, stray] = await Promise.all([
      file(jobId, 'panel.jpg', 'image/jpeg'),
      file(jobId, 'permit.pdf', 'application/pdf'),
      file(jobId, 'note.m4a', 'audio/mp4'),
      file(elsewhere, 'other.jpg', 'image/jpeg'),
    ]);
    const add = (more: Record<string, unknown>) =>
      as(member, 'contractor.note.add', { jobId, ...more });
    expect(await refused(add({ photoFileIds: [stray] }))).toBe('contractor_note_photo_not_on_job');
    expect(await refused(add({ photoFileIds: [pdf] }))).toBe('contractor_not_a_photo');
    expect(await refused(add({ audioFileId: stray }))).toBe('contractor_note_recording_not_on_job');
    expect(await refused(add({ audioFileId: photo }))).toBe('contractor_not_a_recording');
    const { noteId } = await add({ audioFileId: audio, photoFileIds: [photo, photo] });
    const read = async () =>
      (await as(member, 'contractor.note.list', { jobId })).notes.find((n: Any) => n.id === noteId);
    expect(await read()).toMatchObject({
      body: null,
      audio: { fileId: audio, transcript: null, state: 'waiting' },
      photoFileIds: [photo],
    });
    expect((await as(member, 'contractor.note.list', { jobId })).files).toEqual(
      expect.arrayContaining([
        { id: photo, name: 'panel.jpg' },
        { id: audio, name: 'note.m4a' },
      ]),
    );
    const added = await one<{ payload: { spoken: boolean } }>(
      sql`select payload from app.events
          where workspace_id = ${ws} and event_type = 'contractor.note.added'
            and payload ->> 'noteId' = ${noteId}`,
    );
    expect(added.payload.spoken).toBe(true);
    // Only the worker hands the words back, and only once.
    expect(
      await refused(as(member, 'contractor.note.transcribed', { noteId, transcript: 'Hi' })),
    ).toBe('forbidden');
    expect(
      await worker('contractor.note.transcribed', {
        noteId,
        transcript: '  The neutral  bar is full. ',
      }),
    ).toEqual({ noteId, jobId, changed: true });
    expect(
      await worker('contractor.note.transcribed', { noteId, transcript: 'Something else' }),
    ).toEqual({ noteId, jobId, changed: false });
    expect((await read()).audio).toEqual({
      fileId: audio,
      transcript: 'The neutral bar is full.',
      state: 'done',
    });
    // Words that couldn't be made leave the recording to play.
    const silent = await add({ audioFileId: audio });
    await worker('contractor.note.transcribed', { noteId: silent.noteId, transcript: null });
    const after = (await as(member, 'contractor.note.list', { jobId })).notes.find(
      (n: Any) => n.id === silent.noteId,
    );
    expect(after.audio).toEqual({ fileId: audio, transcript: null, state: 'failed' });
    // A note that was removed meanwhile has nothing to keep the words on.
    expect(
      await worker('contractor.note.transcribed', { noteId: randomUUID(), transcript: 'x' }),
    ).toBeNull();
  });

  it('lets people take off their own notes, and someone who sets the add-on up anyone’s', async () => {
    const jobId = await job('Replace the service mast');
    const mine = await as(member, 'contractor.note.add', {
      jobId,
      body: 'Mast is rusted through.',
    });
    const theirs = await as(other, 'contractor.note.add', { jobId, body: 'Ordered a new one.' });
    expect(await refused(as(member, 'contractor.note.remove', { noteId: theirs.noteId }))).toBe(
      'contractor_note_someone_else',
    );
    expect(await as(member, 'contractor.note.remove', { noteId: mine.noteId })).toEqual({
      noteId: mine.noteId,
      jobId,
      removed: true,
    });
    expect((await as(owner, 'contractor.note.list', { jobId })).may).toEqual({ removeAny: true });
    expect(await as(owner, 'contractor.note.remove', { noteId: theirs.noteId })).toMatchObject({
      removed: true,
    });
    expect(await refused(as(owner, 'contractor.note.remove', { noteId: theirs.noteId }))).toBe(
      'not_found',
    );
    expect((await as(member, 'contractor.note.list', { jobId })).notes).toEqual([]);
  });
});

describe('work that waited on a phone', () => {
  it('adds up counts of what was used, wasted and sent back', async () => {
    const jobId = await job('Run a new circuit');
    const { materialId } = await as(member, 'contractor.material.add', {
      jobId,
      name: '12/2 wire',
      unitLabel: 'ft',
      needed: 100,
      delivered: 100,
    });
    const count = (u: TestUser, more: Record<string, unknown>, minutesAgo = 0) =>
      phone(u, 'contractor.material.count', { materialId, ...more }, clock()(minutesAgo));
    // Two people counting the same roll both add up, whenever each arrives.
    expect(await count(member, { used: 40.5 }, 90)).toMatchObject({ used: 40.5, changed: true });
    expect(await count(other, { used: 20, wasted: 2.25 }, 30)).toMatchObject({
      used: 60.5,
      wasted: 2.25,
      returned: 0,
    });
    // Taking some back never goes under nothing.
    expect(await count(member, { wasted: -5 })).toMatchObject({ wasted: 0, changed: true });
    expect(await count(member, { wasted: -1 })).toMatchObject({ wasted: 0, changed: false });
    expect(await refused(count(member, {}))).toBe('validation');
    const [m] = (await as(member, 'contractor.material.list', { jobId })).materials;
    expect(m).toMatchObject({ used: 60.5, wasted: 0, returned: 0, left: 39.5, state: 'here' });
    // The office closes the job; a count made before that still lands, one made after doesn't.
    const before = new Date(Date.now() - 1000);
    await close(jobId);
    expect(
      await phone(member, 'contractor.material.count', { materialId, returned: 10 }, before),
    ).toMatchObject({ returned: 10, changed: true });
    expect(
      await refused(
        phone(member, 'contractor.material.count', { materialId, used: 1 }, new Date()),
      ),
    ).toBe('contractor_job_closed');
    expect(await refused(as(member, 'contractor.material.count', { materialId, used: 1 }))).toBe(
      'contractor_job_closed',
    );
  });

  it('stamps a tick with the moment it was made, and lets one made before the job closed land after', async () => {
    const jobId = await job('Swap a breaker');
    const appointmentId = await visit(jobId, 3);
    const box = await as(member, 'contractor.work_order.item_add', {
      appointmentId,
      label: 'Label the circuit',
    });
    const walk = await as(member, 'contractor.work_order.item_add', {
      appointmentId,
      label: 'Walk it with the customer',
    });
    const ticked = clock()(45);
    await phone(
      member,
      'contractor.work_order.item_set',
      { itemId: box.itemId, done: true },
      ticked,
    );
    const stamped = await one<{ done_at: string; done_by: string }>(
      sql`select done_at, done_by from addon_contractor.work_order_items where id = ${box.itemId}`,
    );
    expect(ms(stamped.done_at)).toBe(ticked.getTime());
    expect(stamped.done_by).toBe(member.id);
    // Ticked on the way out, with no signal; the office closed the job before the phone got through.
    const before = new Date(Date.now() - 1000);
    await close(jobId);
    expect(
      await phone(
        member,
        'contractor.work_order.item_set',
        { itemId: walk.itemId, done: true },
        before,
      ),
    ).toMatchObject({ done: true });
    expect(
      await refused(
        phone(
          member,
          'contractor.work_order.item_set',
          { itemId: walk.itemId, done: false },
          new Date(),
        ),
      ),
    ).toBe('contractor_job_closed');
  });

  it('puts a break where it was pressed, even after the visit’s clock stopped', async () => {
    const jobId = await job('Trench for the feeder');
    const appointmentId = await visit(jobId, 4);
    await onVisit(appointmentId, member);
    const at = clock();
    await press(appointmentId, 'in_progress', at(240));
    // Lunch at noon with no signal, back half an hour later; the phone gets through after the visit is Done.
    await phone(member, 'contractor.time.set_break', { appointmentId, onBreak: true }, at(180));
    await press(appointmentId, 'done', at(60));
    await phone(member, 'contractor.time.set_break', { appointmentId, onBreak: false }, at(150));
    const read = async () =>
      (await as(member, 'contractor.time.list', { jobId, appointmentId })).entries
        .map((e: Any) => [e.kind, ms(e.startedAt), e.endedAt ? ms(e.endedAt) : null])
        .sort((a: number[], b: number[]) => a[1]! - b[1]!);
    expect(await read()).toEqual([
      ['work', at(240).getTime(), at(180).getTime()],
      ['break', at(180).getTime(), at(150).getTime()],
      ['work', at(150).getTime(), at(60).getTime()],
    ]);
    // A second break, pressed after the clock stopped and sent later still: it splits what was running then.
    await phone(member, 'contractor.time.set_break', { appointmentId, onBreak: true }, at(100));
    await phone(member, 'contractor.time.set_break', { appointmentId, onBreak: false }, at(90));
    expect(await read()).toEqual([
      ['work', at(240).getTime(), at(180).getTime()],
      ['break', at(180).getTime(), at(150).getTime()],
      ['work', at(150).getTime(), at(100).getTime()],
      ['break', at(100).getTime(), at(90).getTime()],
      ['work', at(90).getTime(), at(60).getTime()],
    ]);
    const { totals } = await as(member, 'contractor.time.list', { jobId });
    expect(totals).toMatchObject({ workSeconds: 140 * 60, breakSeconds: 40 * 60, running: 0 });
    // Pressed now, with the clock stopped: there's no break to take.
    expect(
      await refused(as(member, 'contractor.time.set_break', { appointmentId, onBreak: true })),
    ).toBe('contractor_time_not_working');
  });
});

describe('the phone’s copy', () => {
  it('answers what the server answers: jobs, a job, a work order, materials, time, notes and the day', async () => {
    const zone = (
      await one<{ timezone: string }>(sql`select timezone from app.workspaces where id = ${ws}`)
    ).timezone;
    // A project with phases, a lead and a team; a visit with a crew, people, a subcontractor, a checklist with a
    // photo, materials for it and for any visit, time with a break, and notes.
    const jobId = await job('Finish the basement', { kind: 'project', dueOn: '2020-01-15' });
    await as(owner, 'contractor.job.team_add', { jobId, userId: member.id });
    const detail0 = await as(owner, 'contractor.job.get', { jobId });
    await as(member, 'contractor.phase.update', {
      phaseId: detail0.phaseList[0].id,
      status: 'done',
    });
    await as(member, 'contractor.phase.update', {
      phaseId: detail0.phaseList[1].id,
      percentDone: 40,
      dueOn: '2020-02-01',
    });
    const appointmentId = await visit(jobId, 1);
    const later = await visit(jobId, 30);
    const earlier = await visit(jobId, -20);
    await onVisit(appointmentId, member, other);
    const [sub] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, phone_e164)
          values (${ws}, 'Sam', 'Sparks', '+15125550177') returning id`,
    );
    const crew = await as(owner, 'contractor.crew.save', {
      name: 'Finish crew',
      userIds: [member.id],
      subPersonIds: [sub!.id],
    });
    await as(owner, 'contractor.work_order.set_crew', {
      appointmentId,
      crewId: crew.crewId,
      acknowledgeWarnings: true,
    });
    await as(member, 'contractor.work_order.update', {
      appointmentId,
      instructions: 'Side door. Mind the dog.',
      bring: 'Drywall lift',
    });
    await as(owner, 'contractor.work_order.sub_set', {
      appointmentId,
      personId: sub!.id,
      done: true,
      note: 'Taped and mudded',
    });
    const photoItem = await as(member, 'contractor.work_order.item_add', {
      appointmentId,
      label: 'Photo of the framing',
      kind: 'photo',
      required: true,
    });
    const boxItem = await as(member, 'contractor.work_order.item_add', {
      appointmentId,
      label: 'Fire blocking in',
      required: true,
    });
    const photo = await file(jobId, 'framing.jpg', 'image/jpeg');
    await as(member, 'contractor.work_order.item_set', {
      itemId: photoItem.itemId,
      done: true,
      fileId: photo,
    });
    await as(member, 'contractor.work_order.item_set', { itemId: boxItem.itemId, done: true });
    await as(member, 'contractor.work_order.item_set', { itemId: boxItem.itemId, done: false });
    await as(member, 'contractor.material.add', {
      jobId,
      name: 'Drywall',
      unitLabel: 'sheet',
      needed: 40,
      ordered: 40,
      delivered: 30,
      supplier: 'Lumber yard',
      expectedOn: '2026-12-01',
      note: 'Half-inch',
    });
    const screws = await as(member, 'contractor.material.add', {
      jobId,
      name: 'Screws',
      unitLabel: 'box',
      needed: 2.5,
      delivered: 3,
      appointmentId,
    });
    await as(member, 'contractor.material.add', {
      jobId,
      name: 'Paint',
      needed: 3,
      appointmentId: later,
    });
    await as(member, 'contractor.material.count', { materialId: screws.materialId, used: 1.25 });
    const at = clock();
    await press(appointmentId, 'on_the_way', at(200));
    await press(appointmentId, 'in_progress', at(170));
    await phone(member, 'contractor.time.set_break', { appointmentId, onBreak: true }, at(120));
    await phone(member, 'contractor.time.set_break', { appointmentId, onBreak: false }, at(100));
    await press(appointmentId, 'waiting_on_parts', at(30));
    // Where each visit's crew has it: one waiting on parts, one finished (a phone no longer keeps its visit job).
    await stage(appointmentId, 'waiting_on_parts');
    await stage(earlier, 'done');
    const audio = await file(jobId, 'voice.m4a', 'audio/mp4');
    const spoken = await phone(
      member,
      'contractor.note.add',
      { jobId, id: randomUUID(), appointmentId, audioFileId: audio, photoFileIds: [photo] },
      at(40),
    );
    await worker('contractor.note.transcribed', {
      noteId: spoken.noteId,
      transcript: 'Inspector wants a second egress.',
    });
    await as(other, 'contractor.note.add', { jobId, body: 'Egress window ordered.' });
    // Other jobs around it: one that's late, one closed, one somebody else's, one archived.
    await job('Late service call', { dueOn: '2020-03-01' });
    const closed = await job('Closed call');
    await close(closed);
    const archived = await job('Archived call');
    // Archived the way a person archives any record: core's own command, which the database holds everyone to.
    await executeCommand(
      api(),
      customRecordArchive,
      { workspaceId: ws, customRecordId: archived },
      human(owner),
      meta(),
    );

    const copy = contractorCopyOf(await phoneRows(member));
    const now = Date.now();
    const today = (await as(member, 'contractor.dispatch', {})).today as string;
    const when = { today, now };

    // ---- the lists
    for (const f of [
      { filter: 'all' },
      { filter: 'mine' },
      { filter: 'late' },
      { filter: 'all', includeClosed: true },
      { filter: 'all', search: 'birch basement' },
      { filter: 'all', includeClosed: true, search: 'dana call' },
    ] as const) {
      const server = await as(member, 'contractor.job.list', f);
      expect(phoneJobList(copy, { ...f, me: member.id }, when), JSON.stringify(f)).toEqual(server);
    }
    expect(
      phoneJobList(copy, { filter: 'mine', me: member.id }, when).jobs.map((j) => j.name),
    ).toEqual(['Finish the basement']);
    expect(
      phoneJobList(copy, { filter: 'all', me: member.id }, when).jobs.map((j) => j.name),
    ).not.toContain('Archived call');

    // ---- one job, whole: the server's without its money
    const { money, recordTypeId, ...server } = await as(member, 'contractor.job.get', { jobId });
    expect(money).toBeNull();
    expect(recordTypeId).toBeTruthy();
    const mine = phoneJob(copy, jobId, when)!;
    expect(mine).toEqual(server);
    expect(mine.daysLate).toBeGreaterThan(0);
    expect(mine.phaseList.slice(0, 2).map((p) => [p.status, p.percentDone])).toEqual([
      ['done', 100],
      ['in_progress', 40],
    ]);
    expect(mine.visits.map((v) => [v.appointmentId, v.stage])).toEqual([
      [later, 'scheduled'],
      [appointmentId, 'waiting_on_parts'],
      [earlier, 'done'],
    ]);
    expect(phoneJob(copy, randomUUID(), when)).toBeNull();

    // ---- the visit's work order
    const order = await as(member, 'contractor.work_order.get', { appointmentId });
    const { visit: mineVisit, ...mineOrder } = phoneWorkOrder(copy, appointmentId)!;
    const { location, ...visitRest } = mineVisit;
    expect(location).toBe('4 Birch Ln');
    const plain = (m: Any) => {
      const { productId: _p, fromEstimate: _f, updatedAt: _u, ...rest } = m;
      return rest;
    };
    expect({ ...mineOrder, visit: visitRest }).toEqual({
      ...order,
      materials: order.materials.map(plain),
    });
    expect(order.visit.stage).toBe('waiting_on_parts');
    expect(order.items.map((i: Any) => [i.label, i.done, i.file?.name ?? null])).toEqual(
      expect.arrayContaining([
        ['Photo of the framing', true, 'framing.jpg'],
        ['Fire blocking in', false, null],
      ]),
    );
    expect(order.subs).toMatchObject([{ name: 'Sam Sparks', canText: true, done: true }]);
    expect(phoneWorkOrder(copy, randomUUID())).toBeNull();

    // ---- materials, all and for one visit
    for (const only of [undefined, appointmentId, later]) {
      const got = await as(member, 'contractor.material.list', {
        jobId,
        ...(only ? { appointmentId: only } : {}),
      });
      expect(phoneMaterials(copy, jobId, only)).toEqual({
        materials: got.materials.map((m: Any) => {
          const { unitCostCents: _c, ...rest } = m;
          return plain(rest);
        }),
        missing: got.missing,
      });
    }

    // ---- time: nothing running, so the sums don't move
    for (const only of [undefined, appointmentId]) {
      const got = await as(member, 'contractor.time.list', {
        jobId,
        ...(only ? { appointmentId: only } : {}),
      });
      const phoneSide = phoneTime(copy, jobId, { appointmentId: only, me: member.id, now });
      expect(phoneSide).toEqual({
        entries: got.entries.map((e: Any) => ({
          ...e,
          name: e.name === CONTRACTOR_WORDS.time.gone ? null : e.name,
          fixed: e.fixed !== null,
        })),
        totals: got.totals,
        mine: got.mine,
        truncated: got.truncated,
      });
      expect(phoneSide.totals).toMatchObject({ breakSeconds: 20 * 60, running: 0 });
    }

    // ---- notes
    for (const only of [undefined, appointmentId]) {
      const got = await as(member, 'contractor.note.list', {
        jobId,
        ...(only ? { appointmentId: only } : {}),
      });
      expect(phoneNotes(copy, jobId, only)).toEqual({
        notes: got.notes,
        truncated: got.truncated,
      });
    }
    expect(phoneNotes(copy, jobId).notes.map((n) => n.audio?.transcript ?? n.body)).toEqual([
      'Egress window ordered.',
      'Inspector wants a second egress.',
    ]);

    // ---- the day: every visit on a job today, and the ones I'm on
    const day = await as(member, 'contractor.dispatch', {});
    const from = startOfLocalDay(day.day, zone);
    const to = startOfLocalDay(addDays(day.day, 1), zone);
    expect(phoneDayVisits(copy, { from, to })).toEqual(day.visits);
    expect(phoneDayVisits(copy, { from, to, me: other.id })).toEqual(
      day.visits.filter((v: Any) => v.userIds.includes(other.id)),
    );

    // ---- and every row a phone holds is what its table says
    expect(
      await rows(admin(), sql`select * from private.addon_phone_mismatches(${ws}::uuid)`),
    ).toEqual([]);
  });

  it('loses a job that left phones, and gets it back', async () => {
    const jobId = await job('Old service call');
    const appointmentId = await visit(jobId, 5);
    await as(member, 'contractor.work_order.update', { appointmentId, bring: 'A ladder' });
    await as(member, 'contractor.note.add', { jobId, body: 'Done and dusted.' });
    const has = async () => {
      const copy = contractorCopyOf(await phoneRows(member));
      return [copy.jobs.has(jobId), copy.orders.has(appointmentId), copy.notes.has(jobId)];
    };
    expect(await has()).toEqual([true, true, true]);
    const window = (on: boolean) =>
      asWorker(testDbs().worker.db, { workspaceId: ws, organizationId: orgId }, (tx) =>
        rows(tx, sql`select private.record_phone_window(${ws}, ${jobId}, ${on})`),
      );
    await window(false);
    expect(await has()).toEqual([false, false, false]);
    await window(true);
    expect(await has()).toEqual([true, true, true]);
  });
});

describe('the phone’s list of Contractor Operations commands', () => {
  it('gives each the class the server does, and leaves none out that can wait', () => {
    const phoneList = Object.entries(PHONE_COMMANDS).filter(([name]) =>
      name.startsWith('contractor.'),
    );
    for (const [name, def] of phoneList)
      expect({ name, offline: registry.command(name)?.offline }).toEqual({
        name,
        offline: def.offline,
      });
    const queueable = registry.commands
      .filter((c) => c.name.startsWith('contractor.') && c.offline !== 'online')
      .map((c) => c.name)
      .sort();
    expect(
      phoneList
        .filter(([, d]) => d.offline !== 'online')
        .map(([name]) => name)
        .sort(),
    ).toEqual(queueable);
    expect(queueable).toEqual([
      'contractor.job.set_percent',
      'contractor.material.count',
      'contractor.note.add',
      'contractor.phase.update',
      'contractor.time.set_break',
      'contractor.work_order.item_set',
    ]);
  });
});
