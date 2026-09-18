/**
 * The demo business an app-store reviewer signs into.
 *
 *   HFOS_DEMO_PASSWORD="$DEMO_PASSWORD" pnpm db:seed:demo
 *
 * Written through the same commands the app uses, so every row has its events and its audit trail, exactly like a
 * business that has been running a while. Read apps/mobile/store/reviewer-demo.md beside this: it says what a reviewer
 * is told, and what the login is for.
 *
 * Three rules shape everything here, and breaking any of them breaks the demo:
 *
 * 1. **Nothing leaves the building.** No text, no email, no charge. Every customer is a 555 number and an
 *    `example.com` address, documents are "sent" with an empty channel list (`channels: []`), appointments are made
 *    with `notify: false`, and the one payment is recorded as cash. So this script needs no carrier, no mailbox, no
 *    payment provider and no worker running — which is also why it is the one seed that can be run against the real
 *    hosted project, where the development stand-ins refuse to load.
 * 2. **One person.** The reviewer owns the business alone. Adding teammates means sending an invitation and accepting
 *    it from the email, and there is no mailbox at `brightpath.example` to accept from. A solo operator is a
 *    believable home-services business anyway, and it keeps the reviewer from finding a screen they can't reach.
 * 3. **It runs once, and can't be undone.** If the reviewer's account already exists the script says so and stops, so
 *    running it twice can't double the data. There is no removal: a business cannot be deleted from HandsFreeOS, and
 *    the comment above `seedDemo` says why and what to do instead.
 *
 * The password is never in this file or in any log. It comes from `HFOS_DEMO_PASSWORD`, and the script refuses to run
 * without one.
 */
import {
  activityLog,
  appointmentCreate,
  calendarCreate,
  companyCreate,
  estimateCreate,
  executeCommand,
  executeQuery,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  leadCreate,
  leadMoveStage,
  organizationCreate,
  personCreate,
  pipelineCreate,
  pipelineList,
  tagCreate,
  taskComplete,
  taskCreate,
  type CommandDef,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

/** The business. Names, numbers and addresses are all invented; the domains can never receive mail (RFC 2606). */
const BUSINESS = 'Bright Path Home Services';
const REVIEWER = {
  email: process.env.HFOS_DEMO_EMAIL ?? 'app-review@handsfreeos.com',
  name: 'Sam Rivera',
};
const TIMEZONE = 'America/Chicago';

const TAGS = [
  ['Residential', '#2d69d8'],
  ['Commercial', '#7c3aed'],
  ['Maintenance plan', '#008743'],
  ['Referral', '#996300'],
  ['VIP', '#c43335'],
] as const;

const COMPANIES = [
  {
    name: 'Kirby Court Apartments',
    phone: '713-555-0142',
    email: 'office@kirbycourt.example',
    line1: '4120 Kirby Dr',
    city: 'Houston',
    postalCode: '77098',
    tags: ['Commercial'],
  },
  {
    name: 'Bayou City Dental',
    phone: '713-555-0118',
    email: 'front@bayoucitydental.example',
    line1: '908 Heights Blvd',
    city: 'Houston',
    postalCode: '77008',
    tags: ['Commercial', 'Maintenance plan'],
  },
  {
    name: 'Westheimer Storage',
    phone: '832-555-0163',
    email: 'manager@westheimerstorage.example',
    line1: '7715 Westheimer Rd',
    city: 'Houston',
    postalCode: '77063',
    tags: ['Commercial'],
  },
] as const;

const PEOPLE = [
  {
    first: 'Marisol',
    last: 'Vega',
    phone: '713-555-0201',
    email: 'marisol.vega@example.com',
    line1: '318 Oak Hollow Dr',
    city: 'Katy',
    postalCode: '77494',
    tags: ['Residential', 'Maintenance plan'],
    source: 'Google',
    notes: 'Two-storey, upstairs unit is the old one. Gate code 4417, dog is friendly.',
  },
  {
    first: 'Trey',
    last: 'Whitfield',
    phone: '281-555-0214',
    email: 'trey.whitfield@example.com',
    line1: '1204 Pecan Grove Ln',
    city: 'Sugar Land',
    postalCode: '77479',
    tags: ['Residential'],
    source: 'Referral',
    notes: 'Referred by Marisol Vega. Works nights, so mornings are bad.',
  },
  {
    first: 'Dana',
    last: 'Okafor',
    phone: '832-555-0228',
    email: 'dana.okafor@example.com',
    line1: '55 Bayou Bend Ct',
    city: 'Houston',
    postalCode: '77019',
    tags: ['Residential', 'VIP'],
    source: 'Repeat',
    notes: 'Third job this year. Pays by cheque on the day.',
  },
  {
    first: 'Priya',
    last: 'Raman',
    phone: '713-555-0233',
    company: 'Bayou City Dental',
    email: 'priya.raman@example.com',
    tags: ['Commercial', 'Maintenance plan'],
    source: 'Website',
    notes: 'Signs off anything over $2,500. Wants the quiet unit for the waiting room.',
  },
  {
    first: 'Luis',
    last: 'Barrera',
    phone: '281-555-0247',
    company: 'Kirby Court Apartments',
    email: 'luis.barrera@example.com',
    tags: ['Commercial'],
    source: 'Website',
    notes: 'Property manager for 48 units. One work order at a time, in writing.',
  },
  {
    first: 'Angela',
    last: 'Duffy',
    phone: '832-555-0252',
    email: 'angela.duffy@example.com',
    line1: '2201 Memorial Dr',
    city: 'Houston',
    postalCode: '77007',
    tags: ['Residential'],
    source: 'Facebook',
    notes: 'New build, everything still under warranty except the thermostat.',
  },
  {
    first: 'Ray',
    last: 'Kowalski',
    phone: '713-555-0266',
    email: 'ray.kowalski@example.com',
    line1: '640 Cypress Creek Pkwy',
    city: 'Spring',
    postalCode: '77373',
    tags: ['Residential', 'Maintenance plan'],
    source: 'Google',
    notes: 'Plan renews in March. Filters are the 20x25x4.',
  },
  {
    first: 'Nina',
    last: 'Petrov',
    phone: '281-555-0279',
    email: 'nina.petrov@example.com',
    line1: '19 Shepherd Dr',
    city: 'Houston',
    postalCode: '77007',
    tags: ['Residential'],
    source: 'Referral',
    notes: 'Wants the whole job written down before anyone starts.',
  },
  {
    first: 'Omar',
    last: 'Haddad',
    phone: '832-555-0284',
    company: 'Westheimer Storage',
    email: 'omar.haddad@example.com',
    tags: ['Commercial'],
    source: 'Cold call',
    notes: 'Office unit only. The warehouse is not ours.',
  },
  {
    first: 'Ellen',
    last: 'Byrd',
    phone: '713-555-0291',
    email: 'ellen.byrd@example.com',
    line1: '883 Main St',
    city: 'Pearland',
    postalCode: '77584',
    tags: ['Residential'],
    source: 'Google',
    notes: 'Older system, keeps it going rather than replacing it.',
  },
  {
    first: 'Gus',
    last: 'Delgado',
    phone: '281-555-0303',
    email: 'gus.delgado@example.com',
    line1: '77 The Woodlands Pkwy',
    city: 'The Woodlands',
    postalCode: '77380',
    tags: ['Residential'],
    source: 'Referral',
    notes: 'Asked about a maintenance plan. Follow up after the spring service.',
  },
  {
    first: 'Bea',
    last: 'Nakamura',
    phone: '832-555-0318',
    email: 'bea.nakamura@example.com',
    line1: '410 Pasadena Blvd',
    city: 'Pasadena',
    postalCode: '77502',
    tags: ['Residential'],
    source: 'Website',
    notes: 'Rental she manages for her father. Bill her, not the tenant.',
  },
] as const;

/** The pipeline, and the leads on it. `stage` is a stage name; anything but the first is moved there afterwards. */
const LEADS = [
  {
    title: 'Upstairs unit replacement',
    person: 'Marisol Vega',
    stage: 'Quoted',
    value: 742_500,
    source: 'Google',
    next: 'Walk the attic with her on Thursday',
    nextIn: 2,
  },
  {
    title: 'Waiting room unit, two options',
    person: 'Priya Raman',
    stage: 'Quoted',
    value: 1_285_000,
    source: 'Website',
    next: 'Drop off the quiet-unit option',
    nextIn: 1,
  },
  {
    title: '48 units: spring service contract',
    person: 'Luis Barrera',
    stage: 'New',
    value: 2_160_000,
    source: 'Website',
    next: 'Get the work-order form he wants',
    nextIn: 4,
  },
  {
    title: 'Thermostat and zoning',
    person: 'Angela Duffy',
    stage: 'Scheduled',
    value: 96_000,
    source: 'Facebook',
    next: null,
    nextIn: undefined,
  },
  {
    title: 'Ductwork repair, back bedrooms',
    person: 'Nina Petrov',
    stage: 'New',
    value: 315_000,
    source: 'Referral',
    next: 'Write the whole job down for her',
    nextIn: 0,
  },
  {
    title: 'Coil clean and refrigerant',
    person: 'Dana Okafor',
    stage: 'Won',
    value: 48_000,
    source: 'Repeat',
    next: null,
    nextIn: undefined,
  },
  {
    title: 'Office split system',
    person: 'Omar Haddad',
    stage: 'Lost',
    value: 530_000,
    source: 'Cold call',
    next: null,
    nextIn: undefined,
  },
] as const;

const TASKS = [
  { title: 'Order the 20x25x4 filters for Ray', person: 'Ray Kowalski', due: 1, done: false },
  {
    title: 'Send Nina the written scope she asked for',
    person: 'Nina Petrov',
    lead: 'Ductwork repair, back bedrooms',
    due: 0,
    done: false,
  },
  {
    title: 'Chase the permit for the Kirby Court work',
    person: 'Luis Barrera',
    due: 3,
    done: false,
  },
  { title: 'Call Gus about the maintenance plan', person: 'Gus Delgado', due: -1, done: true },
  { title: 'Invoice Dana for the coil clean', person: 'Dana Okafor', due: -2, done: true },
] as const;

const NOTES = [
  {
    kind: 'call',
    person: 'Marisol Vega',
    lead: 'Upstairs unit replacement',
    body: 'Talked through the two sizes. She wants the quieter one if it fits the attic.',
    daysAgo: 3,
  },
  {
    kind: 'visit',
    person: 'Dana Okafor',
    lead: 'Coil clean and refrigerant',
    body: 'Coil cleaned, half a pound of refrigerant in. She paid cash on the day.',
    daysAgo: 2,
  },
  {
    kind: 'note',
    person: 'Priya Raman',
    lead: 'Waiting room unit, two options',
    body: 'Anything over $2,500 needs her sign-off. Bring both options in writing.',
    daysAgo: 4,
  },
  {
    kind: 'call',
    person: 'Luis Barrera',
    lead: '48 units: spring service contract',
    body: 'One work order at a time, and everything in writing. He will send the form.',
    daysAgo: 5,
  },
  {
    kind: 'note',
    person: 'Angela Duffy',
    body: 'Builder covers the unit; the thermostat is ours. Booked for Thursday morning.',
    daysAgo: 1,
  },
  {
    kind: 'call',
    person: 'Omar Haddad',
    lead: 'Office split system',
    body: 'Went with the cheaper bid. Asked to be called again in the autumn.',
    daysAgo: 8,
  },
  {
    kind: 'visit',
    person: 'Ray Kowalski',
    body: 'Spring service done. Filters are the 20x25x4, ordering a case.',
    daysAgo: 6,
  },
  {
    kind: 'note',
    person: 'Bea Nakamura',
    body: 'Bill her, not the tenant. Tenant can let us in any weekday after ten.',
    daysAgo: 7,
  },
] as const;

/** Appointments, as days from today and the hour they start. */
const APPOINTMENTS = [
  { person: 'Angela Duffy', day: 0, hour: 9, minutes: 90, title: 'Thermostat and zoning' },
  { person: 'Marisol Vega', day: 0, hour: 14, minutes: 60, title: 'Attic walk-through' },
  { person: 'Ray Kowalski', day: 1, hour: 8, minutes: 60, title: 'Filter change' },
  { person: 'Priya Raman', day: 2, hour: 11, minutes: 60, title: 'Drop off both options' },
  { person: 'Ellen Byrd', day: 3, hour: 13, minutes: 120, title: 'Keep the old system going' },
  { person: 'Bea Nakamura', day: 4, hour: 10, minutes: 90, title: 'Rental service call' },
] as const;

const days = (n: number): Date => new Date(Date.now() + n * 86_400_000);
const at = (n: number, hour: number): string => {
  const d = days(n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

/**
 * There is no `--remove`, and the reason is worth knowing before anyone tries to write one.
 *
 * A business cannot be deleted from HandsFreeOS, on purpose. Tried on the local stack: deleting the organization row
 * cascades to its memberships, and `private.protect_last_org_owner()` stops it — "An organization must keep at least
 * one Owner". Get past that, and `app.events` and `app.audit_logs` both point at the organization and the workspace
 * with ON DELETE RESTRICT. Delete those first, and `private.forbid_change()` answers "app.audit_logs is append-only".
 *
 * Three separate guards, all deliberate, and the same design that makes `account.delete` anonymize a person rather
 * than delete them. So a demo business seeded by mistake is not something to undo with SQL — undoing it would mean
 * deleting the audit trail, which is exactly what the audit trail exists to prevent.
 *
 * To build a different one:
 *   - locally, `pnpm db:reset` and seed again;
 *   - on a real project, seed a second one under another address (`HFOS_DEMO_EMAIL`) and point App Store Connect and
 *     Play Console at that. The old one sits there costing nothing.
 *
 * Which is why the guard below matters: this script runs once per address, and says so rather than doubling the data.
 */
export async function seedDemo(): Promise<void> {
  const password = process.env.HFOS_DEMO_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error(
      'Set HFOS_DEMO_PASSWORD to the password the reviewer will type (12 characters or more).\n' +
        '  HFOS_DEMO_PASSWORD="$DEMO_PASSWORD" pnpm db:seed:demo',
    );
  }

  const { api, admin } = testDbs();
  const step = (msg: string): void => console.log(`• ${msg}`);
  const actor = (user: TestUser): HumanActor => ({
    type: 'human',
    userId: user.id,
    email: user.email,
    claims: user.claims,
  });
  const meta = (): RequestMeta => ({
    correlationId: randomUUID(),
    channel: 'cli',
    reason: 'Demo business for app review',
  });

  const already = await rows<{ id: string }>(
    admin.db,
    sql`select id from app.users where email = ${REVIEWER.email}`,
  );
  if (already.length > 0) {
    console.log(
      `The demo business is already here (${REVIEWER.email} exists). Delete that account, or reset the database, before seeding it again.`,
    );
    return;
  }

  step(`The reviewer's account: ${REVIEWER.email}`);
  const reviewer = await createTestUser('app-review', {
    email: REVIEWER.email,
    password,
    fullName: REVIEWER.name,
  });
  /** Every change below is the reviewer's own, through the same command the app would run. */
  const as = async <I extends z.ZodType, O extends z.ZodType>(
    command: CommandDef<I, O>,
    input: z.input<I>,
  ): Promise<z.infer<O>> =>
    (await executeCommand(api.db, command, input, actor(reviewer), meta())).output;

  step(`${BUSINESS}, owned by the reviewer alone`);
  const org = await as(organizationCreate, { businessName: BUSINESS, timezone: TIMEZONE });
  const workspaceId = org.workspaceId;

  step('Tags');
  const tagIds = new Map<string, string>();
  for (const [name, color] of TAGS) {
    const out = await as(tagCreate, { workspaceId, name, color });
    tagIds.set(name, out.tagId);
  }
  const tags = (names: readonly string[] = []): string[] =>
    names.map((n) => tagIds.get(n)).filter((id): id is string => Boolean(id));

  step(`${COMPANIES.length} companies`);
  const companyIds = new Map<string, string>();
  for (const c of COMPANIES) {
    const out = await as(companyCreate, {
      workspaceId,
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: { line1: c.line1, city: c.city, state: 'TX', postalCode: c.postalCode },
      tagIds: tags(c.tags),
      ignoreDuplicates: true,
    });
    companyIds.set(c.name, out.companyId);
  }

  step(`${PEOPLE.length} customers`);
  const personIds = new Map<string, string>();
  for (const p of PEOPLE) {
    const company = 'company' in p ? companyIds.get(p.company) : undefined;
    const out = await as(personCreate, {
      workspaceId,
      firstName: p.first,
      lastName: p.last,
      phone: p.phone,
      email: p.email,
      companyId: company ?? null,
      address:
        'line1' in p
          ? { line1: p.line1, city: p.city, state: 'TX', postalCode: p.postalCode }
          : undefined,
      tagIds: tags(p.tags),
      source: p.source,
      notes: p.notes,
      ownerUserId: reviewer.id,
      ignoreDuplicates: true,
    });
    personIds.set(`${p.first} ${p.last}`, out.personId);
  }
  const person = (name: string): string => {
    const id = personIds.get(name);
    if (!id) throw new Error(`No such customer in the demo data: ${name}`);
    return id;
  };

  step('The Jobs pipeline, and leads across its stages');
  const pipeline = await as(pipelineCreate, {
    workspaceId,
    name: 'Jobs',
    stages: [
      { name: 'New', kind: 'open' },
      { name: 'Quoted', kind: 'open' },
      { name: 'Scheduled', kind: 'open' },
      { name: 'Won', kind: 'won' },
      { name: 'Lost', kind: 'lost' },
    ],
  });
  const { pipelines } = await executeQuery(
    api.db,
    pipelineList,
    { workspaceId },
    actor(reviewer),
    meta(),
  );
  const board = pipelines.find((p) => p.id === pipeline.pipelineId);
  if (!board) throw new Error('The pipeline just created is not in pipeline.list');
  const stage = (name: string): string => {
    const found = board.stages.find((s) => s.name === name);
    if (!found) throw new Error(`No such stage: ${name}`);
    return found.id;
  };

  const leadIds = new Map<string, string>();
  for (const l of LEADS) {
    const created = await as(leadCreate, {
      workspaceId,
      title: l.title,
      personId: person(l.person),
      pipelineId: pipeline.pipelineId,
      valueCents: l.value,
      assigneeUserId: reviewer.id,
      source: l.source,
      nextAction: l.next,
      nextActionAt: l.nextIn === undefined ? null : at(l.nextIn, 9),
    });
    leadIds.set(l.title, created.leadId);
    if (l.stage !== 'New') {
      await as(leadMoveStage, {
        workspaceId,
        leadId: created.leadId,
        stageId: stage(l.stage),
        ...(l.stage === 'Lost' ? { lostReason: 'Went with a cheaper bid' } : {}),
      });
    }
  }
  const lead = (title: string): string => {
    const id = leadIds.get(title);
    if (!id) throw new Error(`No such lead in the demo data: ${title}`);
    return id;
  };

  step(`${TASKS.length} tasks, two of them done`);
  for (const t of TASKS) {
    const out = await as(taskCreate, {
      workspaceId,
      title: t.title,
      personId: person(t.person),
      leadId: 'lead' in t ? lead(t.lead) : null,
      assigneeUserId: reviewer.id,
      dueAt: at(t.due, 12),
      allDay: true,
    });
    if (t.done) await as(taskComplete, { workspaceId, taskId: out.taskId });
  }

  step(`${NOTES.length} notes, calls and visits on the timeline`);
  for (const n of NOTES) {
    await as(activityLog, {
      workspaceId,
      kind: n.kind,
      body: n.body,
      personId: person(n.person),
      leadId: 'lead' in n ? lead(n.lead) : null,
      occurredAt: at(-n.daysAgo, 9 + (n.daysAgo % 6)),
    });
  }

  // The calendar stays a draft, which is what `calendar.create` makes. Draft only stops a *customer* booking online
  // (`calendar.set_status` to active is the step that opens that, and it refuses while the calendar has gaps to fill);
  // staff booking is allowed on anything but an archived calendar, so the reviewer's day and week fill up as they
  // should. Nothing in this demo uses the public booking page.
  step('A calendar, and this week booked up');
  const calendar = await as(calendarCreate, {
    workspaceId,
    name: 'Service calls',
    preset: 'scratch',
    teammates: [reviewer.id],
    color: '#2d69d8',
  });
  for (const a of APPOINTMENTS) {
    await as(appointmentCreate, {
      workspaceId,
      calendarId: calendar.calendarId,
      startsAt: at(a.day, a.hour),
      durationMinutes: a.minutes,
      userIds: [reviewer.id],
      personId: person(a.person),
      title: a.title,
      // Nothing reaches a customer from this script, and a booking confirmation is the easiest way to break that.
      notify: false,
      acknowledgeWarnings: true,
    });
  }

  step('Two estimates waiting, and three invoices — one of them paid in cash');
  await as(estimateCreate, {
    workspaceId,
    personId: person('Marisol Vega'),
    leadId: lead('Upstairs unit replacement'),
    assigneeUserId: reviewer.id,
    title: 'Upstairs unit replacement',
    lines: [
      { name: '3-ton condenser and coil', quantity: 1, unitPriceCents: 585_000 },
      { name: 'Labour, two days', quantity: 2, unitLabel: 'day', unitPriceCents: 68_000 },
      { name: 'Attic platform and pan', quantity: 1, unitPriceCents: 21_500 },
    ],
  });
  await as(estimateCreate, {
    workspaceId,
    personId: person('Priya Raman'),
    leadId: lead('Waiting room unit, two options'),
    assigneeUserId: reviewer.id,
    title: 'Waiting room: the quiet unit',
    lines: [
      { name: 'Quiet-series 4-ton system', quantity: 1, unitPriceCents: 1_120_000 },
      { name: 'Labour and duct transition', quantity: 1, unitPriceCents: 165_000 },
    ],
  });

  const paid = await as(invoiceCreate, {
    workspaceId,
    personId: person('Dana Okafor'),
    leadId: lead('Coil clean and refrigerant'),
    assigneeUserId: reviewer.id,
    title: 'Coil clean and refrigerant',
    lines: [
      { name: 'Coil clean', quantity: 1, unitPriceCents: 32_000 },
      { name: 'Refrigerant, half a pound', quantity: 0.5, unitLabel: 'lb', unitPriceCents: 32_000 },
    ],
  });
  // `channels: []` takes the invoice out of draft — it gets its number and freezes — and sends nothing to anyone.
  await as(invoiceSend, { workspaceId, invoiceId: paid.invoiceId, channels: [] });
  await as(invoiceRecordCashPayment, {
    workspaceId,
    invoiceId: paid.invoiceId,
    amountCents: 48_000,
    method: 'cash',
    receivedAt: at(-2, 15),
  });

  const open = await as(invoiceCreate, {
    workspaceId,
    personId: person('Ray Kowalski'),
    assigneeUserId: reviewer.id,
    title: 'Spring service and filters',
    lines: [
      { name: 'Spring service', quantity: 1, unitPriceCents: 18_900 },
      { name: '20x25x4 filter', quantity: 2, unitPriceCents: 4_200 },
    ],
  });
  await as(invoiceSend, { workspaceId, invoiceId: open.invoiceId, channels: [] });

  await as(invoiceCreate, {
    workspaceId,
    personId: person('Bea Nakamura'),
    assigneeUserId: reviewer.id,
    title: 'Rental service call',
    lines: [{ name: 'Service call', quantity: 1, unitPriceCents: 14_500 }],
  });

  step('Making it look lived-in');
  // Customers that all appeared in the last minute look like a seed. Their own creation times are spread out;
  // everything with a date on its face (leads, tasks, notes, appointments, invoices) already has a real one.
  await rows(
    admin.db,
    sql`update app.people set created_at = created_at - ((abs(hashtext(id::text)) % 150 + 7) || ' days')::interval where workspace_id = ${workspaceId}`,
  );
  await rows(
    admin.db,
    sql`update app.companies set created_at = created_at - ((abs(hashtext(id::text)) % 200 + 30) || ' days')::interval where workspace_id = ${workspaceId}`,
  );

  console.log(`
Done. The demo business is in.

  Business     ${BUSINESS}
  Workspace    ${workspaceId}
  Sign in      ${REVIEWER.email}
  Password     the one in HFOS_DEMO_PASSWORD (not printed)

  ${PEOPLE.length} customers, ${COMPANIES.length} companies, ${LEADS.length} leads, ${TASKS.length} tasks, ${NOTES.length} timeline entries,
  ${APPOINTMENTS.length} appointments, 2 estimates and 3 invoices (one paid in cash).

  The inbox and the call log are empty: both need a phone number on the business, which costs real money at a real
  carrier. apps/mobile/store/reviewer-demo.md says what to do about that before the first submission.
`);
}

seedDemo()
  .then(() => closeTestDbs())
  .catch(async (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    await closeTestDbs().catch(() => undefined);
    process.exit(1);
  });
