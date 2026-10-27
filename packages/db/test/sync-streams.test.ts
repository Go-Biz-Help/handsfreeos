/**
 * apps/sync/sync-config.yaml sends no one a row, or a column, that RLS and the grants wouldn't let them read.
 *
 * One business gets a row in every table a stream reads. Then every stream query is run in Postgres for four people
 * (its owner, a member, an agency admin who reaches it only through the agency, and a stranger subscribing to it
 * anyway): once past RLS, as PowerSync reads, which is what that person's phone would be sent; and once as the
 * person, through RLS and column grants. The two must be the same rows with the same values. Each query keeps its
 * own filter and lookups (`access`, `managed`, `my_agencies`), with the person and the subscribed business written
 * in, so a gate or filter looser than RLS fails here. The copy each stream exists for isn't empty, so no query passes
 * by comparing nothing, and the last tests check that the gates actually shut.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import { randomInt } from 'node:crypto';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  type TestUser,
  retryDeadlock,
} from './harness';
import { readSyncConfig, type SyncQuery } from './sync-config';

afterAll(closeAll);

const admin$ = dbs.admin.db;
const { queries } = readSyncConfig();

let owner: TestUser;
let member: TestUser;
let agencyAdmin: TestUser;
let stranger: TestUser;
let business: string;

/** A row in every table a stream reads. The member is on the lead, the visit and its invoice; not on the other. */
const FIXTURE = `
do $fixture$
declare
  ws uuid := current_setting('streams.ws')::uuid;
  member uuid := current_setting('streams.member')::uuid;
  suffix text := substr(md5(random()::text), 1, 8);
  person uuid; lead uuid; tag uuid; conversation uuid; teammate uuid; workflow uuid; version uuid; run uuid;
  calendar uuid; service uuid; schedule uuid; connection uuid; appointment uuid; attendee uuid; job uuid; product uuid;
  estimate uuid; staffed_invoice uuid; other_invoice uuid; invoice uuid; payment uuid;
  form uuid; form_version uuid;
begin
  insert into app.people (workspace_id, first_name, last_name, phone_e164) values (ws, 'Maria', 'Lopez', '+15125550170') returning id into person;
  insert into app.companies (workspace_id, name) values (ws, 'Lopez Dental');
  insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, assignee_user_id)
    select ws, s.pipeline_id, s.id, person, 'New system', member from app.pipeline_stages s
    where s.workspace_id = ws and s.kind = 'open' order by s.position limit 1 returning id into lead;
  insert into app.tasks (workspace_id, title, person_id, assignee_user_id) values (ws, 'Call back', person, member);
  insert into app.tags (workspace_id, name) values (ws, 'VIP ' || suffix) returning id into tag;
  insert into app.record_tags (workspace_id, tag_id, record_type, record_id) values (ws, tag, 'person', person);
  insert into app.activities (workspace_id, kind, person_id, body) values (ws, 'note', person, 'Gate code 4411');
  insert into app.files (workspace_id, record_type, record_id, object_path, name, status) values
    (ws, 'person', person, ws || '/people/' || suffix || '-a.jpg', 'photo.jpg', 'ready'),
    (ws, 'knowledge', ws, ws || '/knowledge/' || suffix || '-b.pdf', 'price-list.pdf', 'ready');

  insert into app.conversations (workspace_id, channel, counterpart, person_id, status) values (ws, 'sms', '+15125550170', person, 'open')
    returning id into conversation;
  insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text) values (ws, conversation, 'sms', 'inbound', 'received', 'Hi');
  insert into app.calls (workspace_id, conversation_id, person_id, direction, status) values (ws, conversation, person, 'inbound', 'completed');
  insert into app.opt_outs (workspace_id, counterpart_e164, source) values (ws, '+15125550171', 'manual');
  insert into app.email_suppressions (workspace_id, address, reason) values (ws, 'bounced-' || suffix || '@example.test', 'manual');
  insert into app.phone_numbers (workspace_id, e164, number_type, status)
    values (ws, '+1512' || lpad((floor(random() * 1e7))::int::text, 7, '0'), 'local', 'active');
  insert into app.email_addresses (workspace_id, local_part, address, display_name)
    values (ws, 'office' || suffix, 'office' || suffix || '@example.test', 'Lopez Office');

  insert into app.attention_items (workspace_id, kind, subject_type, subject_id, lead_id, title, fingerprint)
    values (ws, 'hot_lead', 'lead', lead, lead, 'Hot lead', 'hot:' || lead);
  insert into app.ai_teammates (workspace_id, name) values (ws, 'Ava') returning id into teammate;
  insert into app.ai_teammate_drafts (workspace_id, teammate_id, conversation_id, kind, client_id) values (ws, teammate, conversation, 'reply', suffix);
  insert into app.workflows (workspace_id, name) values (ws, 'Follow up') returning id into workflow;
  insert into app.workflow_versions (workspace_id, workflow_id, version, definition, definition_version, revision)
    values (ws, workflow, 1, '{}', 1, 1) returning id into version;
  insert into app.workflow_runs (workspace_id, workflow_id, version_id, dedupe_key, person_id)
    values (ws, workflow, version, 'streams:' || suffix, person) returning id into run;
  insert into app.workflow_approvals (workspace_id, workflow_id, run_id, step_key, preview) values (ws, workflow, run, 'approve#1', '{}');

  insert into app.calendars (workspace_id, name, slug, status) values (ws, 'Visits', 'visits-' || suffix, 'active') returning id into calendar;
  insert into app.services (workspace_id, name) values (ws, 'Tune-up') returning id into service;
  insert into app.calendar_members (workspace_id, calendar_id, user_id) values (ws, calendar, member);
  insert into app.calendar_services (workspace_id, calendar_id, service_id) values (ws, calendar, service);
  insert into app.service_staff (workspace_id, service_id, user_id) values (ws, service, member);
  insert into app.schedules (workspace_id, owner_kind, owner_id) values (ws, 'user', member) returning id into schedule;
  insert into app.schedule_exceptions (workspace_id, schedule_id, starts_at, ends_at) values (ws, schedule, now() + interval '3 days', now() + interval '4 days');
  insert into app.calendar_connections (workspace_id, user_id, provider) values (ws, member, 'google') returning id into connection;
  insert into app.calendar_busy_blocks (workspace_id, connection_id, user_id, starts_at, ends_at)
    values (ws, connection, member, now() + interval '1 day', now() + interval '1 day 1 hour');
  insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source)
    values (ws, calendar, 1, 'Visit', now() + interval '2 days', now() + interval '2 days 1 hour', 'staff') returning id into appointment;
  insert into app.appointment_attendees (workspace_id, appointment_id, person_id) values (ws, appointment, person) returning id into attendee;
  insert into app.appointment_staff (workspace_id, appointment_id, user_id) values (ws, appointment, member);
  -- An open job for the visit (0098), so business_v1's jobs stream has something to send.
  insert into app.jobs (workspace_id, person_id, title) values (ws, person, 'Visit') returning id into job;
  update app.appointments set job_id = job where id = appointment;

  insert into app.products (workspace_id, name, unit_price_cents) values (ws, 'Filter', 5000) returning id into product;
  insert into app.plans (workspace_id, name, price_cents) values (ws, 'Comfort Club', 2900);
  insert into app.subscriptions (workspace_id, person_id, plan_name, price_cents) values (ws, person, 'Comfort Club', 2900);
  insert into app.estimates (workspace_id, person_id, lead_id, title, subtotal_cents, taxable_base_cents, total_cents)
    values (ws, person, lead, 'New system', 5000, 5000, 5000) returning id into estimate;
  insert into app.estimate_lines (workspace_id, estimate_id, product_id, name, quantity, unit_price_cents, amount_cents)
    values (ws, estimate, product, 'Filter', 1, 5000, 5000);
  insert into app.invoices (workspace_id, person_id, attendee_id, title, subtotal_cents, taxable_base_cents, total_cents)
    values (ws, person, attendee, 'Visit', 5000, 5000, 5000) returning id into staffed_invoice;
  insert into app.invoices (workspace_id, person_id, title, subtotal_cents, taxable_base_cents, total_cents)
    values (ws, person, 'Counter sale', 7000, 7000, 7000) returning id into other_invoice;
  foreach invoice in array array[staffed_invoice, other_invoice] loop
    insert into app.invoice_lines (workspace_id, invoice_id, name, quantity, unit_price_cents, amount_cents) values (ws, invoice, 'Labour', 1, 5000, 5000);
    insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at) values (ws, invoice, 2000, 'cash', 'succeeded', now())
      returning id into payment;
    insert into app.refunds (workspace_id, payment_id, invoice_id, amount_cents, status, refunded_at) values (ws, payment, invoice, 100, 'succeeded', now());
  end loop;

  -- A published form, so business_v1's forms and form_versions have something to send. 0085 added both
  -- streams and nothing here created one, so "every stream sends something" had two arms asserting an
  -- empty fixture. is_active is not set by hand: the forms_sync_active trigger sets it when
  -- active_version_id moves, which is the thing worth proving anyway.
  insert into app.forms (workspace_id, name, slug, definition, revision)
    values (ws, 'New system enquiry', 'enquiry-' || suffix, '{}', 1) returning id into form;
  insert into app.form_versions (workspace_id, form_id, version, definition, definition_version, revision)
    values (ws, form, 1, '{}', 1, 1) returning id into form_version;
  update app.forms set active_version_id = form_version, status = 'live' where id = form;

  insert into app.command_receipts (user_id, command_id, workspace_id, command, input_hash, outcome, answer, occurred_at)
    values (member, gen_random_uuid(), ws, 'task.create', repeat('e', 64), 'applied', '{}', now());
  insert into app.push_devices (user_id, platform, expo_push_token, app_version) values (member, 'android', 'ExponentPushToken[' || suffix || ']', '1.0.0');
  insert into app.notifications (user_id, workspace_id, push_id, collapse_key, category, title, body, path, sent_at)
    values (member, ws, gen_random_uuid(), 'conversation-' || suffix, 'customer_message', 'Mike Johnson', 'Is anyone there?',
      '/app/w/' || ws || '/inbox', now());
  insert into app.user_phones (user_id, e164) values (member, '+15125550172');
end
$fixture$`;

/**
 * Round six (records_v1): an add-on phones keep, with a private kind (a deal the owner is on), a shared kind, a
 * table that follows the deal (kept by whoever sees every deal too) and one of the business's own (its vendors),
 * and what hangs off the deal: a task, a timeline line, a file, an appointment and its customer, a portal thread
 * and its message, Home cards (an add-on's for everyone, and the task's, sealed), and links (the deal's client,
 * sealed with it; the home's owner, open).
 */
const PHONE_ADDON = `fx${Array.from({ length: 8 }, () => String.fromCharCode(97 + randomInt(26))).join('')}`;
const PHONE_FIXTURE = `
do $phone$
declare
  ws uuid := current_setting('streams.ws')::uuid;
  owner uuid := current_setting('streams.owner')::uuid;
  addon text := current_setting('streams.addon');
  kind uuid; shared_kind uuid; deal uuid; home uuid; task uuid; conv uuid; alert uuid; person uuid; appt uuid; cal uuid;
  client_of uuid; owner_of uuid;
begin
  execute format('create schema addon_%s', addon);
  execute format('create table addon_%s.items (id uuid primary key default gen_random_uuid(), '
    'workspace_id uuid not null references app.workspaces (id) on delete cascade, '
    'deal_id uuid references app.custom_records (id) on delete cascade, title text not null)', addon);
  execute format('create table addon_%s.vendors (id uuid primary key default gen_random_uuid(), '
    'workspace_id uuid not null references app.workspaces (id) on delete cascade, name text not null)', addon);
  perform private.addon_table_policies(format('addon_%s.items', addon)::regclass, addon || '.use', addon || '.use',
    null, 'deal_id');
  perform private.addon_table_policies(format('addon_%s.vendors', addon)::regclass, addon || '.use', addon || '.use');
  perform private.addon_phone_addon(addon, addon || '.use');
  perform private.addon_phone_table(format('addon_%s.items', addon)::regclass, 'deal_id', array['title'], 'all');
  perform private.addon_phone_table(format('addon_%s.vendors', addon)::regclass, null, array['name'], 'team');

  insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission, kept_to_team,
      see_all_permission)
    values (ws, addon || '_deal', 'Deal', 'Deals', addon, addon || '.use', true, addon || '.all_deals') returning id into kind;
  insert into app.custom_record_types (workspace_id, key, singular, plural, addon_id, write_permission)
    values (ws, addon || '_home', 'Home', 'Homes', addon, addon || '.use') returning id into shared_kind;
  insert into app.custom_records (workspace_id, type_id, name, owner_user_id)
    values (ws, kind, 'Smith purchase', owner) returning id into deal;
  insert into app.custom_records (workspace_id, type_id, name) values (ws, shared_kind, '418 Maple Ave')
    returning id into home;
  execute format('insert into addon_%s.items (workspace_id, deal_id, title) values ($1, $2, $3)', addon)
    using ws, deal, 'Binder to the lender';
  execute format('insert into addon_%s.vendors (workspace_id, name) values ($1, $2)', addon) using ws, 'Lone Star Inspections';

  select id into person from app.people where workspace_id = ws order by created_at limit 1;
  select id into cal from app.calendars where workspace_id = ws order by created_at limit 1;
  -- Links: the deal's client (sealed with the deal), and the home's owner (open, as the home is).
  insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_record_type_id, b_label, addon_id, addon_key)
    values (ws, 'person', 'Client', 'custom_record', kind, 'Deals', addon, addon || '_client') returning id into client_of;
  insert into app.relationship_types (workspace_id, a_end, a_label, b_end, b_record_type_id, b_label, addon_id, addon_key)
    values (ws, 'person', 'Owner', 'custom_record', shared_kind, 'Homes owned', addon, addon || '_owner') returning id into owner_of;
  insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id) values (ws, client_of, person, deal);
  insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id) values (ws, owner_of, person, home);
  insert into app.tasks (workspace_id, title, custom_record_id) values (ws, 'Order the appraisal', deal) returning id into task;
  insert into app.activities (workspace_id, kind, custom_record_id, body) values (ws, 'note', deal, 'Lender called');
  insert into app.files (workspace_id, record_type, record_id, object_path, name, status)
    values (ws, 'custom_record', deal, ws || '/custom_record/' || deal || '/contract.pdf', 'contract.pdf', 'ready');
  insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source, custom_record_id)
    values (ws, cal, 1, 'Inspection', now() + interval '2 days', now() + interval '2 days 1 hour', 'staff', deal)
    returning id into appt;
  insert into app.appointment_attendees (workspace_id, appointment_id, person_id) values (ws, appt, person);
  insert into app.conversations (workspace_id, channel, counterpart, person_id, status, custom_record_id)
    values (ws, 'portal', 'portal:' || person || ':' || deal, person, 'open', deal) returning id into conv;
  insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
    values (ws, conv, 'portal', 'inbound', 'received', 'Is the roof something we should push on?');
  insert into app.addon_alerts (workspace_id, addon_id, key, severity, title, href, permission)
    values (ws, addon, 'everyone', 'attention', 'For everyone', '/a/' || addon, addon || '.use') returning id into alert;
  insert into app.attention_items (workspace_id, kind, subject_type, subject_id, title, fingerprint)
    values (ws, 'addon_alert', 'addon_alert', alert, 'For everyone', 'a:' || alert);
  insert into app.attention_items (workspace_id, kind, subject_type, subject_id, title, fingerprint)
    values (ws, 'overdue_task', 'task', task, 'Order the appraisal', 't:' || task);
  -- The business's booking site, and a client given the portal.
  insert into app.booking_sites (workspace_id, slug, name) values (ws, 'streams-' || substr(md5(ws::text), 1, 8), 'Streams Realty');
  insert into app.portal_access (workspace_id, person_id, public_ref) values (ws, person, substr(md5(random()::text), 1, 8));
  -- The owner's own check-in at the home, and their safety contact.
  insert into app.safety_contacts (workspace_id, user_id, name, phone_e164) values (ws, owner, 'Sam Reyes', '+15125550199');
  insert into app.safety_checkins (id, workspace_id, user_id, place, started_at, planned_end_at)
    values (gen_random_uuid(), ws, owner, '418 Maple Ave', now(), now() + interval '45 minutes');
end
$phone$`;

beforeAll(async () => {
  [owner, member, agencyAdmin, stranger] = await Promise.all([
    createTestUser('streams-owner'),
    createTestUser('streams-member'),
    createTestUser('streams-agency-admin'),
    createTestUser('streams-stranger'),
  ]);
  const agency = await bootstrapOrganization(owner, 'Streams Agency', 'Streams Business');
  business = agency.wsId;
  await bootstrapOrganization(stranger, 'Streams Elsewhere', 'Streams Other Business');
  await rows(
    admin$,
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${business}, ${member.id}, 'member')`,
  );
  await rows(
    admin$,
    sql`insert into app.organization_memberships (organization_id, user_id, role) values (${agency.orgId}, ${agencyAdmin.id}, 'admin')`,
  );
  await admin$.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('streams.ws', ${business}, true), set_config('streams.member', ${member.id}, true)`,
    );
    await tx.execute(sql.raw(FIXTURE));
  });
  // The phone-kept add-on, installed and on as the commands and the worker leave it.
  await rows(
    admin$,
    sql`select private.register_addon_permissions(${PHONE_ADDON}, ${JSON.stringify([
      { key: `${PHONE_ADDON}.use`, defaultRoles: ['admin', 'member'], requires: [] },
      {
        key: `${PHONE_ADDON}.all_deals`,
        defaultRoles: ['admin'],
        requires: [`${PHONE_ADDON}.use`],
      },
    ])}::jsonb)`,
  );
  await as(owner)((tx) =>
    rows(
      tx,
      sql`select * from private.addon_move(${business}, ${PHONE_ADDON}, 'installing', '1.0.0', 1, 1)`,
    ),
  );
  await asService({ workspaceId: business, organizationId: agency.orgId })((tx) =>
    rows(
      tx,
      sql`update app.addon_installations set state = 'enabled'
          where workspace_id = ${business} and addon_id = ${PHONE_ADDON}`,
    ),
  );
  await retryDeadlock(() =>
    admin$.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('streams.ws', ${business}, true), set_config('streams.owner', ${owner.id}, true),
            set_config('streams.addon', ${PHONE_ADDON}, true)`,
      );
      await tx.execute(sql.raw(PHONE_FIXTURE));
    }),
  );
}, 60_000);

/** A stream query as Postgres runs it for one person subscribed to the business: every selected column, in id order. */
function postgresFor(q: SyncQuery, user: TestUser): string {
  const fill = (text: string) =>
    text
      .replace(
        /auth\.user_id\(\) IN ([a-z_]+)/g,
        (_, column: string) => `${column} @> array[auth.user_id()]`,
      )
      .replaceAll('auth.user_id()', `'${user.id}'::uuid`)
      .replaceAll("subscription.parameter('workspace_id')", `'${business}'::uuid`);
  const lookup = (name: string) => {
    const cte = queries.find((c) => c.cte && c.stream === q.stream && c.name === name);
    if (!cte) throw new Error(`${q.stream} has no lookup called ${name}`);
    return fill(cte.text);
  };
  const where: string[] = [];
  if (q.join) where.push(`${q.table}.${q.join.arrayColumn} && array(${lookup(q.join.cte)})`);
  if (q.where)
    where.push(
      fill(q.where).replace(/ IN ([a-z_]+)(?=\s|$)/g, (_, name: string) => ` IN (${lookup(name)})`),
    );
  const columns = [...q.expressions].map(([name, expr]) => `${expr} AS "${name}"`).join(', ');
  const from = `app.${q.table}${q.alias ? ` AS ${q.alias}` : ''}`;
  const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  return `SELECT to_jsonb(r) AS row FROM (SELECT ${columns} FROM ${from}${filter}) r ORDER BY r.id::text`;
}

type Row = Record<string, unknown>;

/** What PowerSync would send them. */
const sentTo = async (q: SyncQuery, user: TestUser) =>
  (await rows<{ row: Row }>(admin$, sql.raw(postgresFor(q, user)))).map((r) => r.row);

/** What they may read themselves. */
const readableBy = async (q: SyncQuery, user: TestUser) =>
  (await as(user)((tx) => rows<{ row: Row }>(tx, sql.raw(postgresFor(q, user))))).map((r) => r.row);

const query = (stream: string, output: string) => {
  const q = queries.find((x) => !x.cte && x.stream === stream && x.output === output);
  if (!q) throw new Error(`${stream} has no query for ${output}`);
  return q;
};

describe('every stream query, for each kind of person', () => {
  const people = () =>
    [
      ['the owner', owner],
      ['a member', member],
      ['an agency admin', agencyAdmin],
      ['a stranger', stranger],
    ] as const;
  /** Whose copy each stream is for, and so must not be empty. */
  const readerOf = (stream: string): TestUser => {
    const reader = {
      me_v1: member,
      business_v1: owner,
      agency_v1: agencyAdmin,
      records_v1: owner,
    }[stream];
    if (!reader) throw new Error(`No reader for ${stream} in this test`);
    return reader;
  };

  /**
   * The me_v1 arms that carry a member's own threads, and the AI's drafts on them, when a business turns
   * per-person inbox visibility on (0081). With it off — which is the default, and what the seed has —
   * `member_viewer_ids` is empty on every row and these correctly send nothing; business_v1 carries the whole
   * inbox instead.
   *
   * So they are asserted **empty** rather than skipped. If one of them ever starts sending rows while no
   * business has opted in, that is a member's phone being handed threads on the strength of a list that
   * should not exist yet, and this is where it shows up.
   */
  const EMPTY_WHILE_EVERYONE_SEES_EVERYTHING = new Set([
    'me_v1.conversations',
    'me_v1.messages',
    'me_v1.calls',
    'me_v1.attention_items',
    'me_v1.ai_teammate_drafts',
  ]);

  for (const q of queries.filter((x) => !x.cte))
    it(`${q.stream} ${q.output}`, async () => {
      for (const [who, user] of people())
        expect(await readableBy(q, user), `${who}: ${q.text}`).toEqual(await sentTo(q, user));
      const sent = (await sentTo(q, readerOf(q.stream))).length;
      if (EMPTY_WHILE_EVERYONE_SEES_EVERYTHING.has(`${q.stream}.${q.output}`))
        expect(sent, `${q.stream} ${q.output} sends nothing until a business opts in`).toBe(0);
      else expect(sent, `${q.stream} ${q.output} is empty`).toBeGreaterThan(0);
    });
});

describe('the gates', () => {
  const count = async (stream: string, output: string, user: TestUser) =>
    (await sentTo(query(stream, output), user)).length;

  it('send a business to its people and its agency, and to no one else', async () => {
    for (const user of [owner, member, agencyAdmin])
      expect(await count('business_v1', 'people', user)).toBe(1);
    for (const output of ['people', 'workspaces', 'users'])
      expect(await count('business_v1', output, stranger), output).toBe(0);
  });

  it('send its money to managers, and to a member only the money on their own work', async () => {
    expect(await count('business_v1', 'invoices', owner)).toBe(2);
    expect(await count('business_v1', 'invoices', agencyAdmin)).toBe(2);
    for (const output of ['invoices', 'payments', 'subscriptions'])
      expect(await count('business_v1', output, member), output).toBe(0);
    expect((await sentTo(query('me_v1', 'invoices'), member)).map((r) => r.title)).toEqual([
      'Visit',
    ]);
    for (const output of ['estimates', 'payments', 'refunds'])
      expect(await count('me_v1', output, member), output).toBe(1);
    for (const user of [owner, agencyAdmin, stranger])
      expect(await count('me_v1', 'invoices', user)).toBe(0);
  });

  it('send money by what the business lets each person do, not by their role (0106)', async () => {
    await rows(
      admin$,
      sql`insert into app.role_permission_overrides (workspace_id, role, permission, allowed)
          values (${business}, 'admin', 'money.manage', false)`,
    );
    await rows(
      admin$,
      sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
          values (${business}, ${member.id}, 'money.bill', true), (${business}, ${member.id}, 'money.manage', true)`,
    );
    try {
      // The admin it kept from money gets none of the business's; the member it handed money to gets all of it,
      // and no longer needs their own copy of the jobs they're on.
      expect(await count('business_v1', 'invoices', agencyAdmin)).toBe(0);
      expect(await count('business_v1', 'invoices', member)).toBe(2);
      expect(await count('business_v1', 'subscriptions', member)).toBeGreaterThan(0);
      expect(await count('me_v1', 'invoices', member)).toBe(0);
      // And each is still sent exactly what they may read.
      const money = queries.filter(
        (x) =>
          !x.cte &&
          [
            'estimates',
            'estimate_lines',
            'invoices',
            'invoice_lines',
            'payments',
            'refunds',
            'subscriptions',
          ].includes(x.output),
      );
      for (const q of money)
        for (const [who, user] of [
          ['the member', member],
          ['the agency admin', agencyAdmin],
        ] as const)
          expect(await readableBy(q, user), `${who}: ${q.stream} ${q.output}`).toEqual(
            await sentTo(q, user),
          );
    } finally {
      await rows(
        admin$,
        sql`delete from app.role_permission_overrides where workspace_id = ${business}`,
      );
      await rows(
        admin$,
        sql`delete from app.member_permission_overrides where workspace_id = ${business}`,
      );
    }
    // Back as they were: the member has only their own jobs again.
    expect(await count('business_v1', 'invoices', member)).toBe(0);
    expect(await count('business_v1', 'invoices', agencyAdmin)).toBe(2);
  });

  it('send the catalogue and the AI’s drafts only to whoever may see money and use the inbox', async () => {
    expect(await count('business_v1', 'products', member)).toBeGreaterThan(0);
    expect(await count('business_v1', 'ai_teammate_drafts', member)).toBeGreaterThan(0);
    await rows(
      admin$,
      sql`insert into app.role_permission_overrides (workspace_id, role, permission, allowed)
          values (${business}, 'member', 'money.read', false), (${business}, 'member', 'inbox.use', false)`,
    );
    try {
      for (const output of ['products', 'plans', 'ai_teammate_drafts'])
        expect(await count('business_v1', output, member), output).toBe(0);
      // And every query still sends a member the business took these from exactly what they may read.
      for (const q of queries.filter((x) => !x.cte))
        expect(await readableBy(q, member), `${q.stream} ${q.output}`).toEqual(
          await sentTo(q, member),
        );
    } finally {
      await rows(
        admin$,
        sql`delete from app.role_permission_overrides where workspace_id = ${business}`,
      );
    }
    expect(await count('business_v1', 'products', member)).toBeGreaterThan(0);
  });

  it('send an agency to its own people, and each person only their own things', async () => {
    expect(await count('agency_v1', 'organizations', agencyAdmin)).toBe(1);
    expect(await count('agency_v1', 'organizations', member)).toBe(0);
    for (const output of ['command_receipts', 'notifications', 'push_devices', 'user_phones']) {
      expect(await count('me_v1', output, member), output).toBe(1);
      expect(await count('me_v1', output, owner), output).toBe(0);
    }
    const [profile] = await sentTo(query('me_v1', 'my_profile'), member);
    expect(profile!.id).toBe(member.id);
  });
});
