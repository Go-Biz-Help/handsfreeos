/**
 * The Deleted bin, round two (20261027000800): a lead, a company, or a record of one of the business's own kinds.
 *   - Each takes what's only about it and what was put on it on purpose. Its customer, its people, bookings, bills,
 *     conversations and form answers stay, no longer tied to it.
 *   - An add-on's records, a record on a hold, and anything an add-on keeps rows for can't go.
 *   - A lead in the bin on its own goes with its customer (or its company) when they're emptied, and doesn't come
 *     back while they're in the bin.
 *   - Found on the way: a referral's lead can be emptied, and a stage with leads in the bin can be deleted.
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
let ws: string;
let org: string;
let calendar: string;
let stage: { id: string; pipeline_id: string };
let tag: string;
let pet: string;
let worksAt: string;
let ownsPet: string;
let form: { formId: string; versionId: string };

const worker = () => asService({ workspaceId: ws, organizationId: org });
const uuids = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

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

const restore = (u: TestUser, item: string) =>
  as(u)((tx) => rows(tx, sql`select private.restore_bin_item(${item}::uuid) as r`));

type Preview = {
  record_id: string;
  name: string | null;
  contents: Record<string, unknown>;
  rule: string | null;
  message: string | null;
};
const preview = (u: TestUser, kind: string, ids: string[]) =>
  as(u)((tx) => rows<Preview>(tx, sql`select * from private.bin_preview(${kind}, ${uuids(ids)})`));

type Removed = { bucket: string; objectPath: string };
/** Starts emptying one item and empties it the way the worker does, a batch at a time. */
async function empty(item: string, batch = 500): Promise<Removed[]> {
  await as(owner)((tx) => rows(tx, sql`select * from private.bin_start_purge(${uuids([item])})`));
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

/** A column of one row, past row-level security. */
const valueOf = async (table: string, column: string, id: string) =>
  one(
    await rows<{ v: unknown }>(
      admin$,
      sql`select ${sql.raw(column)} as v from app.${sql.raw(table)} where id = ${id}`,
    ),
  ).v;

/** An event about something, as the kernel writes it: what a system line points at. */
async function event(type: string, entityType: string, entityId: string): Promise<string> {
  const [ev] = await rows<{ id: string }>(
    admin$,
    sql`insert into app.events (organization_id, workspace_id, event_type, actor_type, actor_id, entity_type, entity_id,
          payload, correlation_id)
        values (${org}, ${ws}, ${type}, 'human', ${owner.id}, ${entityType}, ${entityId}, '{"title": "x"}'::jsonb,
          ${randomUUID()})
        returning id`,
  );
  return ev!.id;
}

const insert = (tx: Parameters<typeof rows>[0], q: ReturnType<typeof sql>) =>
  rows<{ id: string }>(tx, q).then((r) => one(r).id);

async function person(first: string, companyId: string | null = null): Promise<string> {
  return worker()((tx) =>
    insert(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name, company_id)
          values (${ws}, ${first}, 'Reyes', ${companyId}) returning id`,
    ),
  );
}

async function company(name: string): Promise<string> {
  return worker()((tx) =>
    insert(
      tx,
      sql`insert into app.companies (workspace_id, name) values (${ws}, ${name}) returning id`,
    ),
  );
}

async function lead(
  title: string,
  personId: string | null,
  companyId: string | null,
): Promise<string> {
  return worker()((tx) =>
    insert(
      tx,
      sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, company_id, title)
          values (${ws}, ${stage.pipeline_id}, ${stage.id}, ${personId}, ${companyId}, ${title}) returning id`,
    ),
  );
}

async function file(recordType: string, recordId: string): Promise<{ id: string; path: string }> {
  const path = `${ws}/${recordType}/${recordId}/${randomUUID()}/Plan.pdf`;
  const id = await worker()((tx) =>
    insert(
      tx,
      sql`insert into app.files (workspace_id, record_type, record_id, object_path, name, mime_type, size_bytes, status)
          values (${ws}, ${recordType}::app.record_type, ${recordId}, ${path}, 'Plan.pdf', 'application/pdf', 10,
            'ready')
          returning id`,
    ),
  );
  return { id, path };
}

/** A timeline line. A system line points at its event. */
async function line(
  anchors: { person?: string; company?: string; lead?: string; record?: string },
  kind: 'note' | 'system',
  eventId: string | null = null,
): Promise<string> {
  return worker()((tx) =>
    insert(
      tx,
      sql`insert into app.activities (workspace_id, kind, subtype, person_id, company_id, lead_id, custom_record_id,
            body, actor_type, event_id)
          values (${ws}, ${kind}, ${kind === 'system' ? 'lead_created' : null}, ${anchors.person ?? null},
            ${anchors.company ?? null}, ${anchors.lead ?? null}, ${anchors.record ?? null}, 'Said so', 'system',
            ${eventId})
          returning id`,
    ),
  );
}

async function task(
  title: string,
  anchors: { person?: string; company?: string; lead?: string; record?: string },
): Promise<string> {
  return worker()((tx) =>
    insert(
      tx,
      sql`insert into app.tasks (workspace_id, title, person_id, company_id, lead_id, custom_record_id)
          values (${ws}, ${title}, ${anchors.person ?? null}, ${anchors.company ?? null}, ${anchors.lead ?? null},
            ${anchors.record ?? null})
          returning id`,
    ),
  );
}

async function tagged(recordType: string, recordId: string): Promise<void> {
  await rows(
    admin$,
    sql`insert into app.record_tags (workspace_id, tag_id, record_type, record_id)
        values (${ws}, ${tag}, ${recordType}::app.record_type, ${recordId})`,
  );
}

const tags = (recordId: string) =>
  rows<{ n: number }>(
    admin$,
    sql`select count(*)::int as n from app.record_tags where record_id = ${recordId}`,
  ).then((r) => Number(r[0]!.n));

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('bin2-owner'),
    createTestUser('bin2-member'),
  ]);
  ({ wsId: ws, orgId: org } = await bootstrapOrganization(owner, 'Bin Two Org', 'Bin Two Heating'));
  await admin$
    .insert(workspaceMemberships)
    .values([{ workspaceId: ws, userId: member.id, role: 'member' }]);
  await worker()(async (tx: Tx) => {
    calendar = await insert(
      tx,
      sql`insert into app.calendars (workspace_id, name, slug, status)
          values (${ws}, 'Visits', ${`visits-${uniq().toLowerCase()}`}, 'active') returning id`,
    );
    stage = one(
      await rows<{ id: string; pipeline_id: string }>(
        tx,
        sql`select id, pipeline_id from app.pipeline_stages
            where workspace_id = ${ws} and kind = 'open' order by position limit 1`,
      ),
    );
  });
  tag = await insert(
    admin$,
    sql`insert into app.tags (workspace_id, name) values (${ws}, 'VIP') returning id`,
  );
  pet = await insert(
    admin$,
    sql`insert into app.custom_record_types (workspace_id, key, singular, plural)
        values (${ws}, 'pet', 'Pet', 'Pets') returning id`,
  );
  worksAt = await insert(
    admin$,
    sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_label, cardinality)
        values (${ws}, 'person', 'Supplier', 'company', 'Customer', 'many_to_many') returning id`,
  );
  ownsPet = await insert(
    admin$,
    sql`insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_record_type_id, b_label,
          cardinality)
        values (${ws}, 'person', 'Owner', 'custom_record', ${pet}, 'Pet', 'many_to_many') returning id`,
  );
  const formId = await insert(
    admin$,
    sql`insert into app.forms (workspace_id, name, slug, mode)
        values (${ws}, 'Get a quote', ${`quote-${uniq()}`}, 'form') returning id`,
  );
  const versionId = await insert(
    admin$,
    sql`insert into app.form_versions (workspace_id, form_id, version, definition, definition_version, revision)
        values (${ws}, ${formId}, 1, '{"pages": []}', 1, 1) returning id`,
  );
  form = { formId, versionId };
}, 90_000);

afterAll(closeAll);

describe('a lead', () => {
  interface LeadWorld {
    dana: string;
    acme: string;
    lead: string;
    leadTask: string;
    danaTask: string;
    file: { id: string; path: string };
    story: string;
    storyEvent: string;
    leadNote: string;
    danaNote: string;
    visit: string;
    invoice: string;
    response: string;
    referral: string;
    hotCard: string;
    billCard: string;
  }

  /** Dana at Acme, with a lead that has a bit of everything on it, and a referral it came from. */
  async function world(): Promise<LeadWorld> {
    const acme = await company(`Acme ${uniq()}`);
    const dana = await person('Dana', acme);
    const sam = await person('Sam');
    const l = await lead('New AC', dana, acme);
    const storyEvent = await event('lead.created', 'lead', l);
    const w = await worker()(async (tx) => {
      const conversation = await insert(
        tx,
        sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status)
            values (${ws}, 'sms', ${`+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`}, ${sam}, 'open')
            returning id`,
      );
      const message = await insert(
        tx,
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
            values (${ws}, ${conversation}, 'sms', 'inbound', 'received', 'My neighbour Dana needs AC') returning id`,
      );
      const visit = await insert(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
              lead_id)
            values (${ws}, ${calendar}, 1, 'Quote visit', now() - interval '2 days',
              now() - interval '2 days' + interval '1 hour', ${l})
            returning id`,
      );
      await insert(
        tx,
        sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
            values (${ws}, ${visit}, ${dana}) returning id`,
      );
      const invoice = await insert(
        tx,
        sql`insert into app.invoices (workspace_id, person_id, lead_id, title, subtotal_cents, taxable_base_cents,
              tax_cents, total_cents, tax_rate_bp, tax_label)
            values (${ws}, ${dana}, ${l}, 'Deposit', 5000, 5000, 0, 5000, 0, 'Sales tax') returning id`,
      );
      const response = await insert(
        tx,
        sql`insert into app.form_responses (workspace_id, form_id, version_id, status, completed_at, person_id,
              lead_id, answers)
            values (${ws}, ${form.formId}, ${form.versionId}, 'completed', now(), ${dana}, ${l}, '{}')
            returning id`,
      );
      const referral = await insert(
        tx,
        sql`insert into app.referrals (workspace_id, referrer_person_id, conversation_id, message_id, referred_name,
              status, person_id, lead_id)
            values (${ws}, ${sam}, ${conversation}, ${message}, 'Dana', 'lead_created', ${dana}, ${l})
            returning id`,
      );
      const hotCard = await insert(
        tx,
        sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, person_id, lead_id, title,
              fingerprint)
            values (${ws}, 'hot_lead', 'lead', ${l}, ${dana}, ${l}, 'Dana is ready to buy', ${uniq()})
            returning id`,
      );
      const billCard = await insert(
        tx,
        sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, person_id, lead_id, title,
              fingerprint)
            values (${ws}, 'invoice_overdue', 'invoice', ${invoice}, ${dana}, ${l}, 'Deposit is overdue', ${uniq()})
            returning id`,
      );
      return { visit, invoice, response, referral, hotCard, billCard };
    });
    const leadTask = await task('Send the quote', { lead: l, person: dana, company: acme });
    const danaTask = await task('Call Dana back', { person: dana });
    const f = await file('lead', l);
    const story = await line({ lead: l, person: dana, company: acme }, 'system', storyEvent);
    const leadNote = await line({ lead: l }, 'note');
    const danaNote = await line({ lead: l, person: dana }, 'note');
    await tagged('lead', l);
    return {
      dana,
      acme,
      lead: l,
      leadTask,
      danaTask,
      file: f,
      story,
      storyEvent,
      leadNote,
      danaNote,
      ...w,
    };
  }

  let w: LeadWorld;
  let item: string;

  beforeAll(async () => {
    w = await world();
  });

  it('shows what deleting it takes, and whose it is', async () => {
    expect(await preview(owner, 'lead', [w.lead])).toEqual([
      {
        record_id: w.lead,
        name: 'New AC',
        contents: { tasks: 1, notes: 1, files: 1, who: ['Dana Reyes'] },
        rule: null,
        message: null,
      },
    ]);
    // Only who may delete for good.
    expect(await preview(member, 'lead', [w.lead])).toEqual([
      expect.objectContaining({ rule: 'bin_record_gone', name: null }),
    ]);
    expect((await expectPgError(() => bin(member, 'lead', w.lead))).detail).toBe(
      'delete_forbidden',
    );
  });

  it('goes in the bin with its own story, tasks and files; the customer keeps theirs', async () => {
    item = await bin(owner, 'lead', w.lead);
    expect(await seen(owner, 'leads', [w.lead])).toEqual([]);
    expect(await seen(owner, 'tasks', [w.leadTask])).toEqual([]);
    expect(await seen(owner, 'files', [w.file.id])).toEqual([]);
    expect(await seen(owner, 'activities', [w.story, w.leadNote])).toEqual([]);
    // Dana's note mentions the lead, and stays hers; so do her task, the visit, the bill and her answers.
    expect(await seen(owner, 'activities', [w.danaNote])).toEqual([w.danaNote]);
    expect(await seen(owner, 'tasks', [w.danaTask])).toEqual([w.danaTask]);
    expect(await seen(owner, 'appointments', [w.visit])).toEqual([w.visit]);
    expect(await seen(owner, 'invoices', [w.invoice])).toEqual([w.invoice]);
    expect(await seen(owner, 'form_responses', [w.response])).toEqual([w.response]);
    expect(await seen(owner, 'people', [w.dana])).toEqual([w.dana]);
    expect(await seen(owner, 'companies', [w.acme])).toEqual([w.acme]);
    // Home's card about the lead goes; the one about the bill stays.
    expect(await left('attention_items', [w.hotCard])).toBe(0);
    expect(await left('attention_items', [w.billCard])).toBe(1);
    expect(await valueOf('leads', 'archived_at is not null', w.lead)).toBe(true);
  });

  it('comes back as it was', async () => {
    expect(await restore(owner, item)).toEqual([
      { r: { kind: 'lead', recordId: w.lead, name: 'New AC', folded: 0 } },
    ]);
    expect(await seen(owner, 'leads', [w.lead])).toEqual([w.lead]);
    expect(await seen(owner, 'tasks', [w.leadTask])).toEqual([w.leadTask]);
    expect(await seen(owner, 'activities', [w.story, w.leadNote].sort())).toEqual(
      [w.story, w.leadNote].sort(),
    );
    expect(await valueOf('leads', 'archived_at', w.lead)).toBeNull();
    expect(await valueOf('files', 'deleted_at', w.file.id)).toBeNull();
  });

  it('empties with only what was its own, and everything else lets go of it', async () => {
    item = await bin(owner, 'lead', w.lead);
    expect(await empty(item, 2)).toEqual([{ bucket: 'attachments', objectPath: w.file.path }]);
    for (const [table, ids] of [
      ['leads', [w.lead]],
      ['tasks', [w.leadTask]],
      ['files', [w.file.id]],
      ['activities', [w.story, w.leadNote]],
      ['bin_items', [item]],
    ] as const)
      expect([table, await left(table, [...ids])]).toEqual([table, 0]);
    expect(await tags(w.lead)).toBe(0);
    for (const [table, id] of [
      ['activities', w.danaNote],
      ['tasks', w.danaTask],
      ['appointments', w.visit],
      ['invoices', w.invoice],
      ['form_responses', w.response],
      ['attention_items', w.billCard],
    ] as const)
      expect([table, await valueOf(table, 'lead_id', id)]).toEqual([table, null]);
    // The referral still says it made a lead, now gone.
    expect(
      await rows(
        admin$,
        sql`select status, lead_id, person_id from app.referrals where id = ${w.referral}`,
      ),
    ).toEqual([{ status: 'lead_created', lead_id: null, person_id: w.dana }]);
    expect(await left('people', [w.dana])).toBe(1);
    // History keeps the line and drops the details.
    expect(await valueOf('events', 'payload', w.storyEvent)).toEqual({ _redacted: true });
    expect(await rows(admin$, sql`select * from private.bin_work`)).toEqual([]);
  });
});

describe('a company', () => {
  it('takes its own notes, tasks, files, leads and relationships; its people stay, no longer at it', async () => {
    const acme = await company(`Acme ${uniq()}`);
    const dana = await person('Dana', acme);
    const fleet = await lead('Acme fleet', null, acme);
    const danasLead = await lead('Dana’s AC', dana, acme);
    const companyNote = await line({ company: acme }, 'note');
    const danaNote = await line({ company: acme, person: dana }, 'note');
    // A system line about Dana that also names the company: it stays hers.
    const danaLine = await line(
      { company: acme, person: dana },
      'system',
      await event('person.updated', 'person', dana),
    );
    const fleetLine = await line(
      { company: acme, lead: fleet },
      'system',
      await event('lead.created', 'lead', fleet),
    );
    const companyTask = await task('Renew the contract', { company: acme });
    const fleetTask = await task('Quote the fleet', { company: acme, lead: fleet });
    const danaTask = await task('Call Dana', { company: acme, person: dana });
    const f = await file('company', acme);
    const link = await insert(
      admin$,
      sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_company_id)
          values (${ws}, ${worksAt}, ${dana}, ${acme}) returning id`,
    );
    await tagged('company', acme);

    expect(await preview(owner, 'company', [acme])).toEqual([
      expect.objectContaining({
        contents: { notes: 1, tasks: 2, leads: 1, files: 1, relationships: 1, people: 1 },
        rule: null,
      }),
    ]);

    const item = await bin(owner, 'company', acme);
    expect(await seen(owner, 'companies', [acme])).toEqual([]);
    expect(await seen(owner, 'leads', [fleet, danasLead])).toEqual([danasLead]);
    expect(
      await seen(owner, 'activities', [companyNote, danaNote, danaLine, fleetLine].sort()),
    ).toEqual([danaNote, danaLine].sort());
    expect(await seen(owner, 'tasks', [companyTask, fleetTask, danaTask])).toEqual([danaTask]);
    expect(await seen(owner, 'relationships', [link])).toEqual([]);
    expect(await seen(owner, 'people', [dana])).toEqual([dana]);
    expect(await valueOf('companies', 'archived_at is not null', acme)).toBe(true);
    // The worker doesn't see it either.
    expect(
      await worker()((tx) => rows(tx, sql`select id from app.companies where id = ${acme}`)),
    ).toEqual([]);

    await restore(owner, item);
    expect(await seen(owner, 'companies', [acme])).toEqual([acme]);
    expect(await valueOf('companies', 'archived_at', acme)).toBeNull();
    expect(await seen(owner, 'leads', [fleet])).toEqual([fleet]);

    const again = await bin(owner, 'company', acme);
    expect(await empty(again, 3)).toEqual([{ bucket: 'attachments', objectPath: f.path }]);
    for (const [table, ids] of [
      ['companies', [acme]],
      ['leads', [fleet]],
      ['activities', [companyNote, fleetLine]],
      ['tasks', [companyTask, fleetTask]],
      ['files', [f.id]],
      ['relationships', [link]],
    ] as const)
      expect([table, await left(table, [...ids])]).toEqual([table, 0]);
    expect(await tags(acme)).toBe(0);
    // Dana, her lead, her lines and her task stay, no longer at the company.
    expect(await valueOf('people', 'company_id', dana)).toBeNull();
    expect(await valueOf('leads', 'company_id', danasLead)).toBeNull();
    for (const id of [danaNote, danaLine])
      expect(await valueOf('activities', 'company_id', id)).toBeNull();
    expect(await valueOf('tasks', 'company_id', danaTask)).toBeNull();
    expect(await rows(admin$, sql`select * from private.bin_work`)).toEqual([]);
  });

  it('stays while an add-on keeps rows that need it', async () => {
    const title = await company(`Lone Star Title ${uniq()}`);
    await rows(
      admin$,
      sql`insert into addon_realestate.vendors (workspace_id, company_id, services)
          values (${ws}, ${title}, '{title}')`,
    );
    const [p] = await preview(owner, 'company', [title]);
    expect(p).toEqual(
      expect.objectContaining({
        rule: 'bin_addon_uses',
        message: expect.stringContaining(
          'is used by the {addon:realestate} add-on, so it has to stay.',
        ),
      }),
    );
    const refused = await expectPgError(() => bin(owner, 'company', title));
    expect(refused.detail).toBe('bin_addon_uses');
    expect(await seen(owner, 'companies', [title])).toEqual([title]);
  });
});

describe('a record of the business’s own kind', () => {
  it('takes its notes, tasks, files and relationships; bookings and conversations on it stay', async () => {
    const dana = await person('Dana');
    const rex = await worker()((tx) =>
      insert(
        tx,
        sql`insert into app.custom_records (workspace_id, type_id, name) values (${ws}, ${pet}, 'Rex') returning id`,
      ),
    );
    const link = await insert(
      admin$,
      sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
          values (${ws}, ${ownsPet}, ${dana}, ${rex}) returning id`,
    );
    const rexNote = await line({ record: rex }, 'note');
    // The line on Dana's timeline about adding Rex goes with the relationship.
    const linkLine = await line(
      { person: dana, record: rex },
      'system',
      await event('relationship.created', 'relationship', link),
    );
    const danaNote = await line({ person: dana, record: rex }, 'note');
    const rexTask = await task('Vaccinate Rex', { record: rex, person: dana });
    const f = await file('custom_record', rex);
    const visit = await worker()((tx) =>
      insert(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at,
              custom_record_id)
            values (${ws}, ${calendar}, 1, 'Grooming', now() - interval '1 day', now() - interval '23 hours', ${rex})
            returning id`,
      ),
    );

    expect(await preview(owner, 'custom_record', [rex])).toEqual([
      {
        record_id: rex,
        name: 'Rex',
        contents: { notes: 1, tasks: 1, files: 1, relationships: 1, type: 'Pet' },
        rule: null,
        message: null,
      },
    ]);
    const item = await bin(owner, 'custom_record', rex);
    expect(await seen(owner, 'custom_records', [rex])).toEqual([]);
    expect(await seen(owner, 'activities', [rexNote, linkLine, danaNote].sort())).toEqual([
      danaNote,
    ]);
    expect(await seen(owner, 'appointments', [visit])).toEqual([visit]);

    await restore(owner, item);
    expect(await seen(owner, 'custom_records', [rex])).toEqual([rex]);
    expect(await seen(owner, 'relationships', [link])).toEqual([link]);

    const again = await bin(owner, 'custom_record', rex);
    expect(await empty(again)).toEqual([{ bucket: 'attachments', objectPath: f.path }]);
    for (const [table, ids] of [
      ['custom_records', [rex]],
      ['activities', [rexNote, linkLine]],
      ['tasks', [rexTask]],
      ['files', [f.id]],
      ['relationships', [link]],
    ] as const)
      expect([table, await left(table, [...ids])]).toEqual([table, 0]);
    expect(await valueOf('appointments', 'custom_record_id', visit)).toBeNull();
    expect(await valueOf('activities', 'custom_record_id', danaNote)).toBeNull();
    expect(await left('people', [dana])).toBe(1);
  });

  it('stays when it’s an add-on’s, or on a hold', async () => {
    // Real Estate is on here, so its deals show.
    await rows(
      admin$,
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${ws}, 'realestate', 'enabled', '1.0.0')`,
    );
    const dealKind = await insert(
      admin$,
      sql`insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission)
          values (${ws}, 'deal', 'Deal', 'Deals', 'realestate', 'realestate.use') returning id`,
    );
    const deal = await insert(
      admin$,
      sql`insert into app.custom_records (workspace_id, type_id, name) values (${ws}, ${dealKind}, '12 Elm St')
          returning id`,
    );
    expect(await preview(owner, 'custom_record', [deal])).toEqual([
      expect.objectContaining({
        rule: 'bin_record_addon',
        message: '12 Elm St belongs to the {addon:realestate} add-on, so it can only be archived.',
      }),
    ]);

    const held = await insert(
      admin$,
      sql`insert into app.custom_records (workspace_id, type_id, name) values (${ws}, ${pet}, 'Bella') returning id`,
    );
    await rows(
      admin$,
      sql`insert into app.record_holds (workspace_id, custom_record_id, kind, reason)
          values (${ws}, ${held}, 'legal', 'Dispute')`,
    );
    expect(await preview(owner, 'custom_record', [held])).toEqual([
      expect.objectContaining({
        rule: 'bin_record_kept',
        message: 'Bella is on a legal hold, so it has to stay. Archive it instead.',
      }),
    ]);
    expect((await expectPgError(() => bin(owner, 'custom_record', held))).detail).toBe(
      'bin_record_kept',
    );
  });
});

describe('a lead in the bin on its own', () => {
  it('goes with its customer when they’re emptied, and doesn’t come back before them', async () => {
    const dana = await person('Dana');
    const l = await lead('Heat pump', dana, null);
    const leadTask = await task('Price it', { lead: l });
    const f = await file('lead', l);
    const leadItem = await bin(owner, 'lead', l);
    const danaItem = await bin(owner, 'person', dana);

    const refused = await expectPgError(() => restore(owner, leadItem));
    expect(refused.detail).toBe('bin_restore_parent');
    expect(refused.message).toBe(
      'This lead is for Dana Reyes, who’s in the Deleted bin too. Bring them back first.',
    );

    const removed = await empty(danaItem, 1);
    expect(removed).toEqual([{ bucket: 'attachments', objectPath: f.path }]);
    for (const [table, ids] of [
      ['people', [dana]],
      ['leads', [l]],
      ['tasks', [leadTask]],
      ['files', [f.id]],
      ['bin_items', [leadItem, danaItem]],
    ] as const)
      expect([table, await left(table, [...ids])]).toEqual([table, 0]);
  });

  it('goes with its company when it’s only the company’s', async () => {
    const acme = await company(`Acme ${uniq()}`);
    const fleet = await lead('Fleet', null, acme);
    const leadItem = await bin(owner, 'lead', fleet);
    const acmeItem = await bin(owner, 'company', acme);
    expect((await expectPgError(() => restore(owner, leadItem))).message).toContain(
      'which is in the Deleted bin too. Bring it back first.',
    );
    await empty(acmeItem);
    expect(await left('leads', [fleet])).toBe(0);
    expect(await left('companies', [acme])).toBe(0);
    expect(await left('bin_items', [leadItem, acmeItem])).toBe(0);
  });
});

describe('found on the way', () => {
  it('a stage with a lead in the bin can be deleted: the lead moves to another of its kind', async () => {
    const { pipeline, first, second } = await worker()(async (tx) => {
      const pipeline = await insert(
        tx,
        sql`insert into app.pipelines (workspace_id, name) values (${ws}, ${`Installs ${uniq()}`}) returning id`,
      );
      const stageOf = (name: string, kind: string, position: number) =>
        insert(
          tx,
          sql`insert into app.pipeline_stages (workspace_id, pipeline_id, name, kind, position)
              values (${ws}, ${pipeline}, ${name}, ${kind}::app.stage_kind, ${position}) returning id`,
        );
      const first = await stageOf('New', 'open', 1);
      const second = await stageOf('Quoted', 'open', 2);
      await stageOf('Won', 'won', 3);
      await stageOf('Lost', 'lost', 4);
      return { pipeline, first, second };
    });
    const dana = await person('Dana');
    const l = await worker()((tx) =>
      insert(
        tx,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title)
            values (${ws}, ${pipeline}, ${first}, ${dana}, 'Boiler') returning id`,
      ),
    );
    const item = await bin(owner, 'lead', l);
    await rows(admin$, sql`delete from app.pipeline_stages where id = ${first}`);
    expect(await valueOf('leads', 'stage_id', l)).toBe(second);
    await restore(owner, item);
    expect(await seen(owner, 'leads', [l])).toEqual([l]);
  });
});
