/**
 * The Deleted bin (20261027000400): a customer, a conversation or a booking deleted for good.
 *   - Only someone with records.delete (owners, unless an owner gives it out) puts things in the bin, sees it,
 *     brings things back and empties it.
 *   - In the bin, what went with a customer is hidden from people, customers and the worker, and phones drop it
 *     through the columns they already read. The customer stays readable (their bills name them), but nobody
 *     changes them.
 *   - What can't go is refused in words: a plan still billing, a signed file, a booking still to come, a message
 *     still going out, a call still going on.
 *   - Brought back, everything is as it was, and a thread whose line has had a new one since joins it.
 *   - Emptied, the rows go, history keeps its lines without their details, and bills keep the customer's name.
 */
import { randomUUID } from 'node:crypto';
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

const admin$ = dbs.admin.db;

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: string;
let org: string;
let otherWs: string;
let otherOrg: string;
let calendar: string;
let stage: { id: string; pipeline_id: string };
let linkType: string;
let form: { formId: string; versionId: string };

const worker = () => asService({ workspaceId: ws, organizationId: org });
const uuids = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
let phoneSeq = 1000;
const nextPhone = () => `+1512555${String(phoneSeq++).padStart(4, '0')}`;

const one = <T>(r: T[]): T => {
  expect(r).toHaveLength(1);
  return r[0]!;
};

const bin = async (u: TestUser, kind: string, id: string): Promise<string> =>
  one(
    await as(u)((tx) =>
      rows<{ id: string }>(tx, sql`select private.bin_put(${kind}, ${id}::uuid) as id`),
    ),
  ).id;

const restore = async (u: TestUser, item: string) =>
  one(
    await as(u)((tx) =>
      rows<{ r: { kind: string; recordId: string; name: string; folded: number } }>(
        tx,
        sql`select private.restore_bin_item(${item}::uuid) as r`,
      ),
    ),
  ).r;

type Preview = {
  record_id: string;
  name: string | null;
  contents: Record<string, unknown>;
  rule: string | null;
  message: string | null;
};
const preview = (u: TestUser, kind: string, ids: string[]) =>
  as(u)((tx) => rows<Preview>(tx, sql`select * from private.bin_preview(${kind}, ${uuids(ids)})`));

const startPurge = (u: TestUser, items: string[]) =>
  as(u)((tx) =>
    rows<{ bin_item_id: string; kind: string; record_id: string; name: string }>(
      tx,
      sql`select * from private.bin_start_purge(${uuids(items)})`,
    ),
  );

type Removed = { bucket: string; objectPath: string };
/** Empties one item the way the worker does, a batch at a time; answers what it'd remove from storage. */
async function empty(item: string, batch = 500): Promise<Removed[]> {
  const removed: Removed[] = [];
  for (let i = 0; i < 100; i++) {
    const [r] = await worker()((tx) =>
      rows<{ r: { more: boolean; objects: Removed[] } }>(
        tx,
        sql`select private.purge_bin_batch(${ws}::uuid, ${item}::uuid, ${batch}) as r`,
      ),
    );
    removed.push(...r!.r.objects);
    if (!r!.r.more) return removed;
  }
  throw new Error('the bin never finished emptying');
}

/** What the admin sees, past row-level security: how many of these rows are left. */
const left = async (table: string, ids: string[]) =>
  Number(
    one(
      await rows<{ n: number }>(
        admin$,
        sql`select count(*)::int as n from app.${sql.raw(table)} where id = any (${uuids(ids)})`,
      ),
    ).n,
  );

const seen = (u: TestUser, table: string, ids: string[]) =>
  as(u)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`select id from app.${sql.raw(table)} where id = any (${uuids(ids)}) order by id`,
    ),
  ).then((r) => r.map((x) => x.id));

const flags = (table: string, ids: string[]) =>
  rows<{ w: boolean }>(
    admin$,
    sql`select sync_window as w from app.${sql.raw(table)} where id = any (${uuids(ids)})`,
  ).then((r) => r.map((x) => x.w));

interface World {
  person: string;
  name: string;
  other: string;
  phone: string;
  conversation: string;
  messages: string[];
  media: string;
  call: string;
  recording: string;
  note: string;
  line: string;
  task: string;
  lead: string;
  leadTask: string;
  visit: string;
  visitSeat: string;
  session: string;
  seat: string;
  otherSeat: string;
  file: string;
  filePath: string;
  link: string;
  response: string;
  invoice: string;
  event: string;
}

/**
 * A customer with something of everything: a text thread with a photo and a recorded call, a note and a system
 * line, a task, a lead with its own task, a visit last week, a seat at a group class (with someone else on it), a
 * file, a link to that someone else, a form they filled in, an invoice, and the history of being added.
 */
async function customer(first: string, last: string): Promise<World> {
  const phone = nextPhone();
  const media = `${ws}/messages/${randomUUID()}/photo.jpg`;
  const recording = `${ws}/calls/${randomUUID()}/recording.mp3`;
  const w = await worker()(async (tx) => {
    const one$ = async (q: ReturnType<typeof sql>) => one(await rows<{ id: string }>(tx, q)).id;
    const person = await one$(
      sql`insert into app.people (workspace_id, first_name, last_name, phone_e164)
          values (${ws}, ${first}, ${last}, ${phone}) returning id`,
    );
    const other = await one$(
      sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, 'Sam', 'Ortiz') returning id`,
    );
    const conversation = await one$(
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status)
          values (${ws}, 'sms', ${phone}, ${person}, 'open') returning id`,
    );
    const inbound = await one$(
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, media)
          values (${ws}, ${conversation}, 'sms', 'inbound', 'received', 'Here’s the unit',
            ${JSON.stringify([{ bucket: 'telephony', objectPath: media, mimeType: 'image/jpeg' }])}::jsonb)
          returning id`,
    );
    const outbound = await one$(
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
          values (${ws}, ${conversation}, 'sms', 'outbound', 'delivered', 'Thanks, see you Tuesday') returning id`,
    );
    const call = await one$(
      sql`insert into app.calls (workspace_id, conversation_id, person_id, direction, status, started_at,
            recording_object_path)
          values (${ws}, ${conversation}, ${person}, 'inbound', 'completed', now() - interval '1 day', ${recording})
          returning id`,
    );
    const note = await one$(
      sql`insert into app.activities (workspace_id, kind, person_id, body, actor_type)
          values (${ws}, 'note', ${person}, 'Gate code 4411', 'assistant') returning id`,
    );
    const line = await one$(
      sql`insert into app.activities (workspace_id, kind, subtype, person_id, body, actor_type)
          values (${ws}, 'system', 'person_created', ${person}, 'Added', 'system') returning id`,
    );
    const task = await one$(
      sql`insert into app.tasks (workspace_id, title, person_id) values (${ws}, 'Call back', ${person}) returning id`,
    );
    const lead = await one$(
      sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title)
          values (${ws}, ${stage.pipeline_id}, ${stage.id}, ${person}, 'New AC') returning id`,
    );
    const leadTask = await one$(
      sql`insert into app.tasks (workspace_id, title, lead_id) values (${ws}, 'Send the quote', ${lead}) returning id`,
    );
    const visit = await one$(
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at)
          values (${ws}, ${calendar}, 1, 'AC tune-up', now() - interval '7 days', now() - interval '7 days' + interval '1 hour')
          returning id`,
    );
    const visitSeat = await one$(
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
          values (${ws}, ${visit}, ${person}) returning id`,
    );
    const session = await one$(
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, kind, capacity, title, starts_at,
            ends_at)
          values (${ws}, ${calendar}, 1, 'session', 10, 'Filter class', now() - interval '3 days',
            now() - interval '3 days' + interval '1 hour')
          returning id`,
    );
    const seat = await one$(
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
          values (${ws}, ${session}, ${person}) returning id`,
    );
    const otherSeat = await one$(
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
          values (${ws}, ${session}, ${other}) returning id`,
    );
    const filePath = `${ws}/person/${person}/${randomUUID()}/Quote.pdf`;
    const file = await one$(
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes, status)
          values (${ws}, 'person', ${person}, ${filePath}, 'Quote.pdf', 'application/pdf', 10, 'ready') returning id`,
    );
    const link = await one$(
      sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_person_id)
          values (${ws}, ${linkType}, ${person}, ${other}) returning id`,
    );
    const response = await one$(
      sql`insert into app.form_responses (workspace_id, form_id, version_id, status, completed_at, person_id, answers)
          values (${ws}, ${form.formId}, ${form.versionId}, 'completed', now(), ${person}, '{"q_aaaaaaaa": "Dale"}')
          returning id`,
    );
    const invoice = await one$(
      sql`insert into app.invoices (workspace_id, person_id, title, subtotal_cents, taxable_base_cents, tax_cents,
            total_cents, tax_rate_bp, tax_label)
          values (${ws}, ${person}, 'AC tune-up', 15000, 15000, 0, 15000, 0, 'Sales tax') returning id`,
    );
    return {
      person,
      other,
      conversation,
      messages: [inbound, outbound],
      call,
      note,
      line,
      task,
      lead,
      leadTask,
      visit,
      visitSeat,
      session,
      seat,
      otherSeat,
      file,
      filePath,
      link,
      response,
      invoice,
    };
  });
  // The history of adding them, as the kernel writes it.
  const [ev] = await rows<{ id: string }>(
    admin$,
    sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type, entity_id,
          payload, correlation_id)
        values (${org}, ${ws}, 'person.created', 'human', ${owner.id}, 'person', ${w.person},
          ${JSON.stringify({ firstName: first, phone })}::jsonb, ${randomUUID()})
        returning id`,
  );
  await rows(
    admin$,
    sql`insert into app.audit_logs (event_id, organization_id, workspace_id, actor_type, action, entity_type, entity_id,
          after, correlation_id)
        values (${ev!.id}, ${org}, ${ws}, 'human', 'person.create', 'person', ${w.person},
          ${JSON.stringify({ firstName: first, phone })}::jsonb, ${randomUUID()})`,
  );
  return { ...w, name: `${first} ${last}`, phone, media, recording, event: ev!.id };
}

beforeAll(async () => {
  [owner, member, outsider] = await Promise.all([
    createTestUser('bin-owner'),
    createTestUser('bin-member'),
    createTestUser('bin-outsider'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Bin Org', 'Bin Heating'));
  ({ wsId: otherWs, orgId: otherOrg } = await bootstrapOrganization(
    outsider,
    'Other Org',
    'Other Heating',
  ));
  await admin$
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: member.id, role: 'member' }]);
  await worker()(async (tx: Tx) => {
    calendar = one(
      await rows<{ id: string }>(
        tx,
        sql`insert into app.calendars (workspace_id, name, slug, status)
            values (${ws}, 'Visits', ${`visits-${uniq().toLowerCase()}`}, 'active') returning id`,
      ),
    ).id;
    stage = one(
      await rows<{ id: string; pipeline_id: string }>(
        tx,
        sql`select id, pipeline_id from app.pipeline_stages
            where workspace_id = ${ws} and kind = 'open' order by position limit 1`,
      ),
    );
  });
  linkType = one(
    await rows<{ id: string }>(
      admin$,
      sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_label, cardinality)
          values (${ws}, 'person', 'Referred', 'person', 'Referred by', 'many_to_many') returning id`,
    ),
  ).id;
  const formId = one(
    await rows<{ id: string }>(
      admin$,
      sql`insert into app.forms (workspace_id, name, slug, mode)
          values (${ws}, 'Get a quote', ${`quote-${uniq()}`}, 'form') returning id`,
    ),
  ).id;
  const versionId = one(
    await rows<{ id: string }>(
      admin$,
      sql`insert into app.form_versions (workspace_id, form_id, version, definition, definition_version, revision)
          values (${ws}, ${formId}, 1, '{"pages": []}', 1, 1) returning id`,
    ),
  ).id;
  form = { formId, versionId };
}, 90_000);

afterAll(closeAll);

describe('who may delete for good', () => {
  it('is an owner, unless an owner gives it to a role or a person', async () => {
    const may = (u: TestUser) =>
      as(u)((tx) =>
        rows<{ ok: boolean }>(tx, sql`select private.has_permission(${ws}::uuid, 'records.delete') as ok`),
      ).then((r) => r[0]!.ok);
    expect(await may(owner)).toBe(true);
    expect(await may(member)).toBe(false);
    const [c] = await rows<{ requires: string[] }>(
      admin$,
      sql`select requires from app.customizable_permissions where permission = 'records.delete'`,
    );
    expect(c!.requires).toEqual(['records.read', 'records.write', 'records.archive']);

    const w = await customer('Mia', 'Hart');
    const refused = await expectPgError(() => bin(member, 'person', w.person));
    expect(refused.code).toBe('42501');
    expect(refused.detail).toBe('delete_forbidden');
    // Someone who can't delete it is told it isn't there, not what deleting it would take.
    expect(await preview(member, 'person', [w.person])).toEqual([
      expect.objectContaining({ record_id: w.person, name: null, rule: 'bin_record_gone' }),
    ]);
    // Nor can anyone in another business.
    expect((await expectPgError(() => bin(outsider, 'person', w.person))).detail).toBe(
      'delete_forbidden',
    );
  });
});

describe('a customer', () => {
  let w: World;
  let item: string;
  let newThread: string;

  beforeAll(async () => {
    w = await customer('Dana', 'Reyes');
  });

  it('shows what deleting them takes', async () => {
    const [p] = await preview(owner, 'person', [w.person]);
    expect(p).toEqual({
      record_id: w.person,
      name: 'Dana Reyes',
      contents: {
        conversations: 1,
        messages: 2,
        calls: 1,
        notes: 1,
        tasks: 2,
        leads: 1,
        bookings: 2,
        files: 1,
        forms: 1,
        bills: 1,
      },
      rule: null,
      message: null,
    });
  });

  it('goes in the bin with everything only about them, hidden from everyone', async () => {
    // A lead they'd already archived stays archived when they come back.
    await worker()((tx) =>
      tx.execute(sql`update app.leads set archived_at = now() where id = ${w.lead}`),
    );
    item = await bin(owner, 'person', w.person);

    // Still readable, for the bills that name them, but archived and in the bin.
    expect(
      await as(owner)((tx) =>
        rows(
          tx,
          sql`select archived_at is not null as archived, bin_item_id from app.people where id = ${w.person}`,
        ),
      ),
    ).toEqual([{ archived: true, bin_item_id: item }]);
    // Everything about them is out of sight, for people and for the worker.
    for (const who of [owner, member]) {
      expect(await seen(who, 'conversations', [w.conversation])).toEqual([]);
      expect(await seen(who, 'messages', w.messages)).toEqual([]);
      expect(await seen(who, 'calls', [w.call])).toEqual([]);
      expect(await seen(who, 'activities', [w.note, w.line])).toEqual([]);
      expect(await seen(who, 'tasks', [w.task, w.leadTask])).toEqual([]);
      expect(await seen(who, 'leads', [w.lead])).toEqual([]);
      expect(await seen(who, 'appointments', [w.visit])).toEqual([]);
      expect(await seen(who, 'appointment_attendees', [w.visitSeat, w.seat])).toEqual([]);
      expect(await seen(who, 'files', [w.file])).toEqual([]);
      expect(await seen(who, 'relationships', [w.link])).toEqual([]);
      expect(await seen(who, 'form_responses', [w.response])).toEqual([]);
    }
    // The group class stays, with the other person's seat; the bill stays.
    expect(await seen(owner, 'appointments', [w.session])).toEqual([w.session]);
    expect(await seen(owner, 'appointment_attendees', [w.seat, w.otherSeat])).toEqual([w.otherSeat]);
    expect(await seen(owner, 'invoices', [w.invoice])).toEqual([w.invoice]);
    expect(
      await worker()((tx) =>
        rows(tx, sql`select id from app.conversations where id = ${w.conversation}`),
      ),
    ).toEqual([]);
    // The worker reads a booking in the bin only when it says so (to take it off a Google calendar).
    expect(
      await worker()((tx) => rows(tx, sql`select id from app.appointments where id = ${w.visit}`)),
    ).toEqual([]);
    expect(
      await worker()(async (tx) => {
        await tx.execute(sql`select set_config('app.read_bin', 'on', true)`);
        return rows(tx, sql`select id from app.appointments where id = ${w.visit}`);
      }),
    ).toEqual([{ id: w.visit }]);

    // Phones drop it through what their streams already read.
    expect(await flags('messages', w.messages)).toEqual([false, false]);
    expect(await flags('calls', [w.call])).toEqual([false]);
    expect(await flags('activities', [w.note, w.line])).toEqual([false, false]);
    expect(await flags('tasks', [w.task, w.leadTask])).toEqual([false, false]);
    expect(await flags('appointments', [w.visit])).toEqual([false]);
    expect(await flags('appointment_attendees', [w.visitSeat, w.seat])).toEqual([false, false]);
    expect(await flags('appointment_attendees', [w.otherSeat])).toEqual([true]);
    expect(await flags('relationships', [w.link])).toEqual([false]);
    const [state] = await rows<Record<string, boolean>>(
      admin$,
      sql`select (select archived_at is not null from app.conversations where id = ${w.conversation}) as conversation,
            (select deleted_at is not null from app.files where id = ${w.file}) as file`,
    );
    expect(state).toEqual({ conversation: true, file: true });

    // The bin, for the owner only.
    expect(
      await as(owner)((tx) =>
        rows(tx, sql`select kind, record_id, name, contents ->> 'messages' as messages from app.bin_items`),
      ),
    ).toEqual([{ kind: 'person', record_id: w.person, name: 'Dana Reyes', messages: '2' }]);
    expect(await as(member)((tx) => rows(tx, sql`select id from app.bin_items`))).toEqual([]);
    // Nothing was left open behind it.
    expect(await rows(admin$, sql`select * from private.bin_work`)).toEqual([]);
  });

  it('can’t be changed or deleted twice while in the bin', async () => {
    expect(
      await as(owner)((tx) =>
        rows(tx, sql`update app.people set first_name = 'Dee' where id = ${w.person} returning id`),
      ),
    ).toEqual([]);
    expect((await expectPgError(() => bin(owner, 'person', w.person))).detail).toBe(
      'bin_record_gone',
    );
    expect((await preview(owner, 'person', [w.person]))[0]!.rule).toBe('bin_record_gone');
    // Nor merged away into someone else, nor anyone merged into them (they're archived).
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) =>
            rows(tx, sql`select private.merge_people(${ws}::uuid, ${w.person}::uuid, ${w.other}::uuid)`),
          ),
        )
      ).detail,
    ).toBe('person_in_bin');
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) =>
            rows(tx, sql`select private.merge_people(${ws}::uuid, ${w.other}::uuid, ${w.person}::uuid)`),
          ),
        )
      ).detail,
    ).toBe('person_merge_into_archived');
  });

  it('writing again starts a new conversation', async () => {
    // Nothing new lands in the thread in the bin.
    expect(
      (
        await expectPgError(() =>
          worker()((tx) =>
            tx.execute(
              sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
                  values (${ws}, ${w.conversation}, 'sms', 'inbound', 'received', 'Hello?')`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
    // The line is free for a new thread, as for someone the business has never heard from.
    const [c] = await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, status)
            values (${ws}, 'sms', ${w.phone}, 'open') returning id`,
      ),
    );
    await worker()((tx) =>
      tx.execute(
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
            values (${ws}, ${c!.id}, 'sms', 'inbound', 'received', 'Hello?')`,
      ),
    );
    newThread = c!.id;
  });

  it('comes back as it was, and their old thread joins the new one', async () => {
    expect(
      (await expectPgError(() => restore(member, item))).detail,
    ).toBe('delete_forbidden');
    expect(await restore(owner, item)).toEqual({
      kind: 'person',
      recordId: w.person,
      name: 'Dana Reyes',
      folded: 1,
    });

    expect(
      await as(owner)((tx) =>
        rows(tx, sql`select archived_at, bin_item_id from app.people where id = ${w.person}`),
      ),
    ).toEqual([{ archived_at: null, bin_item_id: null }]);
    // The old thread joined the new one, which is theirs now.
    expect(await left('conversations', [w.conversation])).toBe(0);
    expect(
      await as(owner)((tx) =>
        rows(
          tx,
          sql`select person_id, (select count(*)::int from app.messages m where m.conversation_id = c.id) as messages,
                (select count(*)::int from app.calls k where k.conversation_id = c.id) as calls
              from app.conversations c where c.id = ${newThread}`,
        ),
      ),
    ).toEqual([{ person_id: w.person, messages: 3, calls: 1 }]);
    expect(await seen(owner, 'activities', [w.note, w.line])).toHaveLength(2);
    expect(await seen(owner, 'tasks', [w.task, w.leadTask])).toHaveLength(2);
    expect(await seen(owner, 'appointments', [w.visit])).toEqual([w.visit]);
    expect(await seen(owner, 'appointment_attendees', [w.visitSeat, w.seat])).toHaveLength(2);
    expect(await seen(owner, 'relationships', [w.link])).toEqual([w.link]);
    expect(await seen(owner, 'form_responses', [w.response])).toEqual([w.response]);
    expect(
      await as(owner)((tx) =>
        rows(
          tx,
          sql`select (select archived_at is not null from app.leads where id = ${w.lead}) as lead_archived,
                (select deleted_at is null from app.files where id = ${w.file}) as file_back`,
        ),
      ),
    ).toEqual([{ lead_archived: true, file_back: true }]);
    // Back on phones.
    expect(await flags('messages', w.messages)).toEqual([true, true]);
    expect(await flags('calls', [w.call])).toEqual([true]);
    expect(await flags('activities', [w.note, w.line])).toEqual([true, true]);
    expect(await flags('tasks', [w.task, w.leadTask])).toEqual([true, true]);
    expect(await flags('appointments', [w.visit])).toEqual([true]);
    expect(await flags('appointment_attendees', [w.visitSeat, w.seat])).toEqual([true, true]);
    expect(await flags('relationships', [w.link])).toEqual([true]);
    expect(await as(owner)((tx) => rows(tx, sql`select id from app.bin_items`))).toEqual([]);
    expect((await expectPgError(() => restore(owner, item))).detail).toBe('bin_item_gone');
  });
});

describe('what can’t go', () => {
  const plain = (first: string) =>
    worker()(async (tx) =>
      one(
        await rows<{ id: string }>(
          tx,
          sql`insert into app.people (workspace_id, first_name, last_name) values (${ws}, ${first}, 'Doe') returning id`,
        ),
      ).id,
    );
  const refusal = async (person: string) => {
    const e = await expectPgError(() => bin(owner, 'person', person));
    const [p] = await preview(owner, 'person', [person]);
    expect(p!.rule).toBe(e.detail);
    expect(p!.message).toBe(e.message);
    return { rule: e.detail, message: e.message };
  };

  it('is a customer with a plan still billing', async () => {
    const p = await plain('Pat');
    await worker()((tx) =>
      tx.execute(
        sql`insert into app.subscriptions (workspace_id, person_id, plan_name, price_cents, status)
            values (${ws}, ${p}, 'Comfort club', 1500, 'active')`,
      ),
    );
    expect(await refusal(p)).toEqual({
      rule: 'bin_plan_running',
      message:
        'Pat Doe has a plan that’s still billing. Cancel it on their Money tab first, then delete them.',
    });
  });

  it('is a customer with a signed file', async () => {
    const p = await plain('Lou');
    const [f] = await worker()((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, status)
            values (${ws}, 'person', ${p}, ${`${ws}/person/${p}/${randomUUID()}/Contract.pdf`}, 'Contract.pdf', 'ready')
            returning id`,
      ),
    );
    await rows(admin$, sql`update app.files set locked_at = now(), locked_reason = 'signed' where id = ${f!.id}`);
    expect(await refusal(p)).toEqual({
      rule: 'bin_signed_file',
      message:
        'Lou Doe has a signed file, Contract.pdf, and signed files are kept for good. Archive them instead.',
    });
  });

  it('is a booking still to come, until it’s cancelled', async () => {
    const p = await plain('Kim');
    const visit = await worker()(async (tx) => {
      const [a] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at)
            values (${ws}, ${calendar}, 1, 'Install', now() + interval '3 days', now() + interval '3 days 2 hours')
            returning id`,
      );
      await tx.execute(
        sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id) values (${ws}, ${a!.id}, ${p})`,
      );
      return a!.id;
    });
    const r = await refusal(p);
    expect(r.rule).toBe('bin_upcoming_booking');
    expect(r.message).toMatch(/^Kim Doe has a booking still to come, on \w+ \d+\. Cancel it first, then delete them\.$/);
    expect((await expectPgError(() => bin(owner, 'appointment', visit))).detail).toBe(
      'bin_upcoming_booking',
    );
    await worker()((tx) =>
      tx.execute(sql`update app.appointments set status = 'cancelled' where id = ${visit}`),
    );
    expect((await preview(owner, 'person', [p]))[0]!.rule).toBeNull();
  });

  it('is a message still going out, or a call still going on', async () => {
    const p = await plain('Ray');
    const conv = await worker()(async (tx) => {
      const [c] = await rows<{ id: string }>(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
            values (${ws}, 'sms', ${nextPhone()}, ${p}) returning id`,
      );
      await tx.execute(
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
            values (${ws}, ${c!.id}, 'sms', 'outbound', 'sending', 'On my way')`,
      );
      return c!.id;
    });
    expect((await refusal(p)).rule).toBe('bin_still_sending');
    expect((await expectPgError(() => bin(owner, 'conversation', conv))).message).toBe(
      'A message in this conversation is still going out. Try again in a minute.',
    );
    await worker()(async (tx) => {
      await tx.execute(sql`update app.messages set status = 'sent' where conversation_id = ${conv}`);
      await tx.execute(
        sql`insert into app.calls (workspace_id, conversation_id, person_id, direction, status)
            values (${ws}, ${conv}, ${p}, 'inbound', 'in_progress')`,
      );
    });
    expect(await refusal(p)).toEqual({
      rule: 'bin_call_live',
      message: 'A call with Ray Doe is still going on. Try again when it ends.',
    });
  });

  it('is a duplicate merged into someone else', async () => {
    const [keep, dupe] = [await plain('Ana'), await plain('Ann')];
    await rows(
      admin$,
      sql`update app.people set merged_into_id = ${keep}, merged_at = now() where id = ${dupe}`,
    );
    expect((await expectPgError(() => bin(owner, 'person', dupe))).detail).toBe('bin_person_merged');
  });
});

describe('emptying the bin', () => {
  it('takes everything about a customer for good, and leaves their bills with the name', async () => {
    const w = await customer('Lee', 'Park');
    const item = await bin(owner, 'person', w.person);
    // What the command writes about deleting them: the one line that stays whole.
    const [deleted] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type, entity_id,
            payload, correlation_id)
          values (${org}, ${ws}, 'person.deleted', 'human', ${owner.id}, 'person', ${w.person},
            '{"name": "Lee Park"}'::jsonb, ${randomUUID()})
          returning id`,
    );

    expect(await startPurge(member, [item])).toEqual([]);
    expect(await startPurge(owner, [item])).toEqual([
      expect.objectContaining({ bin_item_id: item, kind: 'person', record_id: w.person, name: 'Lee Park' }),
    ]);
    expect((await expectPgError(() => restore(owner, item))).detail).toBe('bin_item_emptying');
    // Only the worker in that business empties it.
    expect(
      (
        await expectPgError(() =>
          asService({ workspaceId: otherWs, organizationId: otherOrg })((tx) =>
            rows(tx, sql`select private.purge_bin_batch(${ws}::uuid, ${item}::uuid)`),
          ),
        )
      ).code,
    ).toBe('42501');

    const removed = await empty(item, 2);
    expect(removed).toEqual(
      expect.arrayContaining([
        { bucket: 'telephony', objectPath: w.media },
        { bucket: 'telephony', objectPath: w.recording },
        { bucket: 'attachments', objectPath: w.filePath },
      ]),
    );
    expect(removed).toHaveLength(3);

    expect(await left('people', [w.person])).toBe(0);
    for (const [table, ids] of [
      ['conversations', [w.conversation]],
      ['messages', w.messages],
      ['calls', [w.call]],
      ['activities', [w.note, w.line]],
      ['tasks', [w.task, w.leadTask]],
      ['leads', [w.lead]],
      ['appointments', [w.visit]],
      ['appointment_attendees', [w.visitSeat, w.seat]],
      ['files', [w.file]],
      ['relationships', [w.link]],
      ['form_responses', [w.response]],
      ['bin_items', [item]],
    ] as const) {
      expect([table, await left(table, [...ids])]).toEqual([table, 0]);
    }
    // The class and the other person's seat stay.
    expect(await left('appointments', [w.session])).toBe(1);
    expect(await left('appointment_attendees', [w.otherSeat])).toBe(1);
    expect(await left('people', [w.other])).toBe(1);

    // The bill stays, on a record of their name alone that nobody can change.
    const [keeper] = await rows<Record<string, unknown>>(
      admin$,
      sql`select p.id, p.first_name, p.last_name, p.phone_e164, p.archived_at is not null as archived,
            p.erased_at is not null as erased
          from app.invoices i join app.people p on p.id = i.person_id where i.id = ${w.invoice}`,
    );
    expect(keeper).toEqual(
      expect.objectContaining({
        first_name: 'Lee',
        last_name: 'Park',
        phone_e164: null,
        archived: true,
        erased: true,
      }),
    );
    expect(
      await as(owner)((tx) =>
        rows(
          tx,
          sql`update app.people set first_name = 'X' where id = ${keeper!.id as string} returning id`,
        ),
      ),
    ).toEqual([]);

    // History keeps its lines and drops their details, except the line saying they were deleted.
    expect(
      await rows(
        admin$,
        sql`select event_type, payload from app.events where entity_id = ${w.person} order by occurred_at, event_type`,
      ),
    ).toEqual([
      { event_type: 'person.created', payload: { _redacted: true } },
      { event_type: 'person.deleted', payload: { name: 'Lee Park' } },
    ]);
    expect(
      await rows(
        admin$,
        sql`select action, before, after from app.audit_logs where entity_id = ${w.person}`,
      ),
    ).toEqual([{ action: 'person.create', before: null, after: null }]);
    expect(deleted).toBeDefined();
    expect(await rows(admin$, sql`select * from private.bin_work`)).toEqual([]);
    expect((await expectPgError(() => restore(owner, item))).detail).toBe('bin_item_gone');
  });

  it('takes a conversation on its own, and leaves the customer', async () => {
    const w = await customer('Jo', 'Lane');
    const item = await bin(owner, 'conversation', w.conversation);
    expect(await seen(owner, 'people', [w.person])).toEqual([w.person]);
    expect(await seen(owner, 'conversations', [w.conversation])).toEqual([]);
    expect(await seen(owner, 'messages', w.messages)).toEqual([]);
    expect(await seen(owner, 'calls', [w.call])).toEqual([]);
    expect(await seen(owner, 'activities', [w.note])).toEqual([w.note]);
    expect(
      await as(owner)((tx) =>
        rows(tx, sql`select name, contents from app.bin_items where id = ${item}`),
      ),
    ).toEqual([{ name: 'Jo Lane', contents: { conversations: 1, messages: 2, calls: 1, channel: 'sms' } }]);

    expect(await restore(owner, item)).toEqual(
      expect.objectContaining({ kind: 'conversation', folded: 0 }),
    );
    expect(
      await as(owner)((tx) =>
        rows(tx, sql`select archived_at from app.conversations where id = ${w.conversation}`),
      ),
    ).toEqual([{ archived_at: null }]);

    const again = await bin(owner, 'conversation', w.conversation);
    await startPurge(owner, [again]);
    const removed = await empty(again);
    expect(removed).toHaveLength(2);
    expect(removed).toEqual(
      expect.arrayContaining([
        { bucket: 'telephony', objectPath: w.media },
        { bucket: 'telephony', objectPath: w.recording },
      ]),
    );
    expect(await left('conversations', [w.conversation])).toBe(0);
    expect(await left('messages', w.messages)).toBe(0);
    expect(await left('calls', [w.call])).toBe(0);
    expect(await left('people', [w.person])).toBe(1);
    expect(await left('activities', [w.note])).toBe(1);
  });

  it('takes a booking on its own', async () => {
    const w = await customer('Al', 'Moss');
    const item = await bin(owner, 'appointment', w.visit);
    expect(await seen(owner, 'appointments', [w.visit])).toEqual([]);
    expect(await seen(owner, 'appointment_attendees', [w.visitSeat])).toEqual([]);
    expect(await seen(owner, 'people', [w.person])).toEqual([w.person]);
    const [b] = await as(owner)((tx) =>
      rows<{ name: string; contents: { who: string[] } }>(
        tx,
        sql`select name, contents from app.bin_items where id = ${item}`,
      ),
    );
    expect(b).toEqual(
      expect.objectContaining({ name: 'AC tune-up', contents: expect.objectContaining({ who: ['Al Moss'] }) }),
    );
    await startPurge(owner, [item]);
    expect(await empty(item)).toEqual([]);
    expect(await left('appointments', [w.visit])).toBe(0);
    expect(await left('appointment_attendees', [w.visitSeat])).toBe(0);
    expect(await left('people', [w.person])).toBe(1);
  });

  it('starts by itself 30 days on', async () => {
    const w = await customer('Bo', 'Finch');
    const item = await bin(owner, 'conversation', w.conversation);
    const due = () =>
      asService({})((tx) =>
        rows<{ bin_item_id: string; workspace_id: string; organization_id: string }>(
          tx,
          sql`select * from private.bin_due(1000)`,
        ),
      ).then((r) => r.filter((x) => x.bin_item_id === item));
    expect(await due()).toEqual([]);
    await rows(
      admin$,
      sql`update app.bin_items set purge_after = now() - interval '1 minute' where id = ${item}`,
    );
    expect(await due()).toEqual([{ bin_item_id: item, workspace_id: ws, organization_id: org }]);
    // Once started it isn't answered again, unless it's still not done a day on.
    expect(await due()).toEqual([]);
    expect((await expectPgError(() => restore(owner, item))).detail).toBe('bin_item_emptying');
    await empty(item);
    expect(await left('bin_items', [item])).toBe(0);
  });
});
