/**
 * 0056: the rows a phone's sync is decided by, held to RLS.
 *   - app.workspace_access is each person's private.effective_workspace_role() in each business, agency roles
 *     flattened in, through every membership change (and "manages money" is has_permission('money.manage')).
 *   - users.member_workspace_ids / member_organization_ids are the person's direct memberships.
 *   - member_viewer_ids on estimates, invoices, their lines, payments and refunds are exactly the members the 0050
 *     member policies let see each row — checked as each member, through RLS itself, after staffing, unstaffing, a
 *     cancelled visit, reassigning a lead, a role change and removal — and nobody can write them by hand.
 *   - None of that bookkeeping moves updated_at (drafts use it as their revision), while a save still does, and a
 *     sent document's lines still take their viewers (the definer steps past the line guard).
 *   - The SQL parity helpers (0060) agree, and notice a mismatch planted behind the triggers' backs.
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
  uniq,
  type TestUser,
} from './harness';

/** The agency's owner, who also owns business A directly. */
let owner: TestUser;
/** Business A's admin. */
let admin: TestUser;
/** Two members of A: the tech whose jobs we follow, and his mate. */
let tech: TestUser;
let mate: TestUser;
/** An agency admin with no direct membership anywhere. */
let agencyAdmin: TestUser;
/** Another agency's owner. */
let outsider: TestUser;

let A: { ws: string; org: string };
/** A second business in the same agency. */
let A2: string;
let B: { ws: string; org: string };

const MONEY_TABLES = [
  'estimates',
  'estimate_lines',
  'invoices',
  'invoice_lines',
  'payments',
  'refunds',
] as const;
type MoneyTable = (typeof MONEY_TABLES)[number];

const worker = (ws: string, org: string) => asService({ workspaceId: ws, organizationId: org });
const admin$ = dbs.admin.db;

interface World {
  personId: string;
  techLeadId: string;
  looseLeadId: string;
  techAppointmentId: string;
  mateAppointmentId: string;
  techAttendeeId: string;
  mateAttendeeId: string;
}
let w: World;
const docs = {} as {
  techJobInvoice: string;
  mateJobInvoice: string;
  techLeadEstimate: string;
  techLeadInvoice: string;
  looseLeadInvoice: string;
  orphanInvoice: string;
};

beforeAll(async () => {
  [owner, admin, tech, mate, agencyAdmin, outsider] = await Promise.all([
    createTestUser('access-owner'),
    createTestUser('access-admin'),
    createTestUser('access-tech'),
    createTestUser('access-mate'),
    createTestUser('access-agency-admin'),
    createTestUser('access-outsider'),
  ]);
  const a = await bootstrapOrganization(owner, 'Access Agency', 'Access A');
  A = { ws: a.wsId, org: a.orgId };
  const b = await bootstrapOrganization(outsider, 'Access Other', 'Access B');
  B = { ws: b.wsId, org: b.orgId };
  await admin$.insert(workspaceMemberships).values([
    { workspaceId: A.ws, userId: admin.id, role: 'admin' },
    { workspaceId: A.ws, userId: tech.id, role: 'member' },
    { workspaceId: A.ws, userId: mate.id, role: 'member' },
  ]);
  await rows(
    admin$,
    sql`insert into app.organization_memberships (organization_id, user_id, role) values (${A.org}, ${agencyAdmin.id}, 'admin')`,
  );
  const [second] = await rows<{ id: string }>(
    admin$,
    sql`insert into app.workspaces (organization_id, name, slug) values (${A.org}, 'Access A2', ${`access-a2-${uniq()}`})
        returning id`,
  );
  A2 = second!.id;

  w = await worker(
    A.ws,
    A.org,
  )(async (tx) => {
    const [p] = await rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name) values (${A.ws}, 'Maria', 'Lopez') returning id`,
    );
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.calendars (workspace_id, name, slug, status) values (${A.ws}, 'Jobs', ${`jobs-${uniq().toLowerCase()}`}, 'active')
          returning id`,
    );
    const [stage] = await rows<{ id: string; pipeline_id: string }>(
      tx,
      sql`select id, pipeline_id from app.pipeline_stages where workspace_id = ${A.ws} and kind = 'open' order by position limit 1`,
    );
    const lead = async (assignee: string | null) => {
      const [l] = await rows<{ id: string }>(
        tx,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, assignee_user_id)
            values (${A.ws}, ${stage!.pipeline_id}, ${stage!.id}, ${p!.id}, 'New system', ${assignee}) returning id`,
      );
      return l!.id;
    };
    const job = async (staff: string, hoursOut: number) => {
      const [ap] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source)
            values (${A.ws}, ${c!.id}, 1, 'Tune-up', now() + make_interval(hours => ${hoursOut}),
              now() + make_interval(hours => ${hoursOut + 1}), 'staff') returning id`,
      );
      await tx.execute(
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id) values (${A.ws}, ${ap!.id}, ${staff})`,
      );
      const [seat] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id) values (${A.ws}, ${ap!.id}, ${p!.id})
            returning id`,
      );
      return { appointment: ap!.id, attendee: seat!.id };
    };
    const techJob = await job(tech.id, 24);
    const mateJob = await job(mate.id, 48);
    return {
      personId: p!.id,
      techLeadId: await lead(tech.id),
      looseLeadId: await lead(null),
      techAppointmentId: techJob.appointment,
      mateAppointmentId: mateJob.appointment,
      techAttendeeId: techJob.attendee,
      mateAttendeeId: mateJob.attendee,
    };
  });

  docs.techJobInvoice = await invoice({ attendeeId: w.techAttendeeId });
  docs.mateJobInvoice = await invoice({ attendeeId: w.mateAttendeeId });
  docs.techLeadEstimate = await estimate(w.techLeadId);
  docs.techLeadInvoice = await invoice({ leadId: w.techLeadId });
  docs.looseLeadInvoice = await invoice({ leadId: w.looseLeadId });
  docs.orphanInvoice = await invoice({});
  // A cash payment on each invoice, and a refund on the tech's job.
  for (const id of [
    docs.techJobInvoice,
    docs.mateJobInvoice,
    docs.techLeadInvoice,
    docs.looseLeadInvoice,
  ])
    await as(owner)((tx) =>
      tx.execute(
        sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at, recorded_by)
            values (${A.ws}, ${id}, 20000, 'cash', 'succeeded', now(), ${owner.id})`,
      ),
    );
  await worker(
    A.ws,
    A.org,
  )((tx) =>
    tx.execute(
      sql`insert into app.refunds (workspace_id, payment_id, invoice_id, amount_cents, status, refunded_at)
          select ${A.ws}, p.id, p.invoice_id, 500, 'succeeded', now() from app.payments p where p.invoice_id = ${docs.techJobInvoice}`,
    ),
  );
});
afterAll(closeAll);

async function invoice(link: { leadId?: string; attendeeId?: string }): Promise<string> {
  const [row] = await worker(
    A.ws,
    A.org,
  )((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.invoices (workspace_id, person_id, lead_id, attendee_id, title, subtotal_cents, taxable_base_cents, total_cents)
          values (${A.ws}, ${w.personId}, ${link.leadId ?? null}, ${link.attendeeId ?? null}, 'Job', 45000, 45000, 45000)
          returning id`,
    ),
  );
  await worker(
    A.ws,
    A.org,
  )((tx) =>
    tx.execute(
      sql`insert into app.invoice_lines (workspace_id, invoice_id, name, quantity, unit_price_cents, amount_cents)
          values (${A.ws}, ${row!.id}, 'Labour', 1, 45000, 45000)`,
    ),
  );
  return row!.id;
}

async function estimate(leadId: string): Promise<string> {
  const [row] = await worker(
    A.ws,
    A.org,
  )((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.estimates (workspace_id, person_id, lead_id, title, subtotal_cents, taxable_base_cents, total_cents)
          values (${A.ws}, ${w.personId}, ${leadId}, 'New system', 1850000, 1850000, 1850000) returning id`,
    ),
  );
  await worker(
    A.ws,
    A.org,
  )((tx) =>
    tx.execute(
      sql`insert into app.estimate_lines (workspace_id, estimate_id, name, quantity, unit_price_cents, amount_cents)
          values (${A.ws}, ${row!.id}, 'Condenser', 1, 1850000, 1850000)`,
    ),
  );
  return row!.id;
}

/** What RLS shows a person of a money table in business A. */
const visibleTo = async (user: TestUser, table: MoneyTable) =>
  (
    await as(user)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from app.${sql.raw(table)} where workspace_id = ${A.ws} order by id`,
      ),
    )
  ).map((r) => r.id);

/** What the member stream would send that person: the rows whose viewer list names them. */
const listedFor = async (user: TestUser, table: MoneyTable) =>
  (
    await rows<{ id: string }>(
      admin$,
      sql`select id from app.${sql.raw(table)}
          where workspace_id = ${A.ws} and member_viewer_ids @> array[${user.id}::uuid] and sync_window
          order by id`,
    )
  ).map((r) => r.id);

/** Members: RLS and the lists agree on every money table. Managers: listed nowhere, and RLS shows them everything. */
async function expectMoneyParity() {
  for (const member of [tech, mate]) {
    const role = await roleIn(member, A.ws);
    for (const table of MONEY_TABLES) {
      if (role === 'member' || role === null)
        expect(await listedFor(member, table), `${member.fullName} ${table}`).toEqual(
          await visibleTo(member, table),
        );
      else expect(await listedFor(member, table), `${member.fullName} ${table}`).toEqual([]);
    }
  }
  for (const manager of [owner, admin])
    for (const table of MONEY_TABLES) expect(await listedFor(manager, table)).toEqual([]);
  expect(await rows(admin$, sql`select * from private.sync_viewer_mismatches(${A.ws})`)).toEqual(
    [],
  );
  expect(await rows(admin$, sql`select * from private.sync_access_mismatches(${A.ws})`)).toEqual(
    [],
  );
}

const roleIn = async (user: TestUser, ws: string) => {
  const [r] = await rows<{ role: string }>(
    admin$,
    sql`select role::text as role from app.workspace_access where user_id = ${user.id} and workspace_id = ${ws}`,
  );
  return r?.role ?? null;
};

/** The effective role RLS computes for a person, as that person. */
const effectiveRole = async (user: TestUser, ws: string) => {
  const [r] = await as(user)((tx) =>
    rows<{ role: string | null }>(tx, sql`select private.effective_workspace_role(${ws}) as role`),
  );
  return r!.role;
};

async function expectAccessParity(people: TestUser[], workspaces: string[]) {
  for (const person of people)
    for (const ws of workspaces)
      expect(await roleIn(person, ws), `${person.fullName} in ${ws}`).toBe(
        await effectiveRole(person, ws),
      );
}

const viewersOf = async (table: MoneyTable, id: string) => {
  const [r] = await rows<{ v: string[] }>(
    admin$,
    sql`select member_viewer_ids::text[] as v from app.${sql.raw(table)} where id = ${id}`,
  );
  return [...r!.v].sort();
};

describe('app.workspace_access', () => {
  const everyone = () => [owner, admin, tech, mate, agencyAdmin, outsider];

  it('holds each person’s effective role, agency roles flattened in', async () => {
    await expectAccessParity(everyone(), [A.ws, A2, B.ws]);
    expect(await roleIn(owner, A.ws)).toBe('owner');
    expect(await roleIn(owner, A2)).toBe('owner');
    expect(await roleIn(agencyAdmin, A.ws)).toBe('admin');
    expect(await roleIn(agencyAdmin, A2)).toBe('admin');
    expect(await roleIn(tech, A.ws)).toBe('member');
    expect(await roleIn(tech, A2)).toBeNull();
    expect(await roleIn(outsider, A.ws)).toBeNull();
    expect(await rows(admin$, sql`select * from private.sync_access_mismatches(${A.ws})`)).toEqual(
      [],
    );
    expect(await rows(admin$, sql`select * from private.sync_access_mismatches(${A2})`)).toEqual(
      [],
    );
  });

  it('follows every change to memberships and agencies', async () => {
    const check = () => expectAccessParity(everyone(), [A.ws, A2]);
    // A direct role below the agency one: the higher wins.
    await admin$
      .insert(workspaceMemberships)
      .values({ workspaceId: A2, userId: agencyAdmin.id, role: 'member' });
    expect(await roleIn(agencyAdmin, A2)).toBe('admin');
    await check();
    // Promoted, then back.
    await rows(
      admin$,
      sql`update app.workspace_memberships set role = 'admin' where workspace_id = ${A.ws} and user_id = ${tech.id}`,
    );
    expect(await roleIn(tech, A.ws)).toBe('admin');
    await check();
    await rows(
      admin$,
      sql`update app.workspace_memberships set role = 'member' where workspace_id = ${A.ws} and user_id = ${tech.id}`,
    );
    expect(await roleIn(tech, A.ws)).toBe('member');
    // Joining the agency reaches every business in it; leaving it takes that away again.
    await rows(
      admin$,
      sql`insert into app.organization_memberships (organization_id, user_id, role) values (${A.org}, ${mate.id}, 'admin')`,
    );
    expect([await roleIn(mate, A.ws), await roleIn(mate, A2)]).toEqual(['admin', 'admin']);
    await check();
    await rows(
      admin$,
      sql`delete from app.organization_memberships where organization_id = ${A.org} and user_id = ${mate.id}`,
    );
    expect([await roleIn(mate, A.ws), await roleIn(mate, A2)]).toEqual(['member', null]);
    await check();
    // An agency role changing.
    await rows(
      admin$,
      sql`update app.organization_memberships set role = 'owner' where organization_id = ${A.org} and user_id = ${agencyAdmin.id}`,
    );
    expect(await roleIn(agencyAdmin, A2)).toBe('owner');
    await rows(
      admin$,
      sql`update app.organization_memberships set role = 'admin' where organization_id = ${A.org} and user_id = ${agencyAdmin.id}`,
    );
    await check();
    // A new business in the agency is reachable by its people at once.
    const [third] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.workspaces (organization_id, name, slug) values (${A.org}, 'Access A3', ${`access-a3-${uniq()}`}) returning id`,
    );
    expect(await roleIn(agencyAdmin, third!.id)).toBe('admin');
    expect(await roleIn(owner, third!.id)).toBe('owner');
    await expectAccessParity(everyone(), [third!.id]);
    // Leaving a business ends access to it.
    await rows(
      admin$,
      sql`delete from app.workspace_memberships where workspace_id = ${A2} and user_id = ${agencyAdmin.id}`,
    );
    expect(await roleIn(agencyAdmin, A2)).toBe('admin');
    await check();
    expect(await rows(admin$, sql`select * from private.sync_access_mismatches(${A.ws})`)).toEqual(
      [],
    );
  });

  it('lets a person read only their own rows, and the worker only its business’s', async () => {
    const [own] = await as(tech)((tx) =>
      rows<{ n: number; mine: number }>(
        tx,
        sql`select count(*)::int as n, count(*) filter (where user_id = ${tech.id})::int as mine from app.workspace_access`,
      ),
    );
    expect(own!.n).toBeGreaterThan(0);
    expect(own!.n).toBe(own!.mine);
    const [scoped] = await worker(
      A.ws,
      A.org,
    )((tx) =>
      rows<{ n: number; other: number }>(
        tx,
        sql`select count(*)::int as n, count(*) filter (where workspace_id <> ${A.ws})::int as other from app.workspace_access`,
      ),
    );
    expect(scoped!.n).toBeGreaterThan(0);
    expect(scoped!.other).toBe(0);
  });

  it('agrees with RLS for every person and business in the database', async () => {
    expect(await rows(admin$, sql`select * from private.sync_access_mismatches()`)).toEqual([]);
  });
});

describe('the businesses and agencies a person belongs to directly', () => {
  it('are exactly their memberships, for everyone', async () => {
    const [drift] = await rows<{ n: number }>(
      admin$,
      sql`select count(*)::int as n from app.users u
          where u.member_workspace_ids is distinct from coalesce((select array_agg(m.workspace_id order by m.workspace_id)
                  from app.workspace_memberships m where m.user_id = u.id), '{}')
             or u.member_organization_ids is distinct from coalesce((select array_agg(m.organization_id order by m.organization_id)
                  from app.organization_memberships m where m.user_id = u.id), '{}')`,
    );
    expect(drift!.n).toBe(0);
    const [t] = await rows<{ ws: string[]; orgs: string[] }>(
      admin$,
      sql`select member_workspace_ids::text[] as ws, member_organization_ids::text[] as orgs from app.users where id = ${agencyAdmin.id}`,
    );
    expect(t!.orgs).toEqual([A.org]);
  });

  it('don’t move a person’s updated_at', async () => {
    const before = await rows<{ at: string }>(
      admin$,
      sql`select updated_at::text as at from app.users where id = ${mate.id}`,
    );
    await admin$
      .insert(workspaceMemberships)
      .values({ workspaceId: B.ws, userId: mate.id, role: 'member' });
    const after = await rows<{ at: string; ws: string[] }>(
      admin$,
      sql`select updated_at::text as at, member_workspace_ids::text[] as ws from app.users where id = ${mate.id}`,
    );
    expect(after[0]!.ws).toContain(B.ws);
    expect(after[0]!.at).toBe(before[0]!.at);
    await rows(
      admin$,
      sql`delete from app.workspace_memberships where workspace_id = ${B.ws} and user_id = ${mate.id}`,
    );
  });
});

describe('member viewer lists', () => {
  it('name the members RLS lets see each document, its lines, payments and refunds', async () => {
    expect(await viewersOf('invoices', docs.techJobInvoice)).toEqual([tech.id]);
    expect(await viewersOf('invoices', docs.mateJobInvoice)).toEqual([mate.id]);
    expect(await viewersOf('estimates', docs.techLeadEstimate)).toEqual([tech.id]);
    expect(await viewersOf('invoices', docs.looseLeadInvoice)).toEqual([]);
    expect(await viewersOf('invoices', docs.orphanInvoice)).toEqual([]);
    await expectMoneyParity();
  });

  it('follow staffing, unstaffing and a cancelled visit', async () => {
    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id) values (${A.ws}, ${w.mateAppointmentId}, ${tech.id})`,
      ),
    );
    expect(await viewersOf('invoices', docs.mateJobInvoice)).toEqual([tech.id, mate.id].sort());
    await expectMoneyParity();

    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(
        sql`delete from app.appointment_staff where appointment_id = ${w.mateAppointmentId} and user_id = ${tech.id}`,
      ),
    );
    expect(await viewersOf('invoices', docs.mateJobInvoice)).toEqual([mate.id]);
    await expectMoneyParity();

    // Cancelling the visit leaves its staff inactive, so the tech stops seeing its invoice; restoring it brings it back.
    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(
        sql`update app.appointments set status = 'cancelled' where id = ${w.techAppointmentId}`,
      ),
    );
    expect(await viewersOf('invoices', docs.techJobInvoice)).toEqual([]);
    await expectMoneyParity();
    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(
        sql`update app.appointments set status = 'scheduled' where id = ${w.techAppointmentId}`,
      ),
    );
    expect(await viewersOf('invoices', docs.techJobInvoice)).toEqual([tech.id]);
    await expectMoneyParity();
  });

  it('follow a lead changing hands, as a person reassigns it', async () => {
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.leads set assignee_user_id = ${tech.id} where id = ${w.looseLeadId}`,
      ),
    );
    expect(await viewersOf('invoices', docs.looseLeadInvoice)).toEqual([tech.id]);
    await expectMoneyParity();
    await as(admin)((tx) =>
      tx.execute(
        sql`update app.leads set assignee_user_id = ${mate.id} where id = ${w.looseLeadId}`,
      ),
    );
    expect(await viewersOf('invoices', docs.looseLeadInvoice)).toEqual([mate.id]);
    await expectMoneyParity();
  });

  it('carry a sent document’s change to its lines, past the line guard, in a person’s own command', async () => {
    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(
        sql`update app.invoices set status = 'sent', number = ${`INV-${uniq()}`}, sent_at = now() where id = ${docs.looseLeadInvoice}`,
      ),
    );
    // A person can't touch a sent invoice's lines…
    const [line] = await rows<{ id: string }>(
      admin$,
      sql`select id from app.invoice_lines where invoice_id = ${docs.looseLeadInvoice}`,
    );
    await expect(
      as(owner)((tx) =>
        tx.execute(sql`update app.invoice_lines set name = 'Changed' where id = ${line!.id}`),
      ),
    ).rejects.toThrow();
    // …but reassigning the lead carries the new viewer to them.
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.leads set assignee_user_id = ${tech.id} where id = ${w.looseLeadId}`,
      ),
    );
    expect(await viewersOf('invoice_lines', line!.id)).toEqual([tech.id]);
    expect(
      await viewersOf(
        'payments',
        (
          await rows<{ id: string }>(
            admin$,
            sql`select id from app.payments where invoice_id = ${docs.looseLeadInvoice}`,
          )
        )[0]!.id,
      ),
    ).toEqual([tech.id]);
    await expectMoneyParity();
  });

  it('follow a role change and a removal', async () => {
    await rows(
      admin$,
      sql`update app.workspace_memberships set role = 'admin' where workspace_id = ${A.ws} and user_id = ${tech.id}`,
    );
    expect(await viewersOf('invoices', docs.techJobInvoice)).toEqual([]);
    expect(await viewersOf('estimates', docs.techLeadEstimate)).toEqual([]);
    await expectMoneyParity();
    await rows(
      admin$,
      sql`update app.workspace_memberships set role = 'member' where workspace_id = ${A.ws} and user_id = ${tech.id}`,
    );
    expect(await viewersOf('invoices', docs.techJobInvoice)).toEqual([tech.id]);
    expect(await viewersOf('estimates', docs.techLeadEstimate)).toEqual([tech.id]);
    await expectMoneyParity();

    await rows(
      admin$,
      sql`delete from app.workspace_memberships where workspace_id = ${A.ws} and user_id = ${mate.id}`,
    );
    expect(await viewersOf('invoices', docs.mateJobInvoice)).toEqual([]);
    for (const table of MONEY_TABLES) expect(await listedFor(mate, table)).toEqual([]);
    await expectMoneyParity();
    await admin$
      .insert(workspaceMemberships)
      .values({ workspaceId: A.ws, userId: mate.id, role: 'member' });
    expect(await viewersOf('invoices', docs.mateJobInvoice)).toEqual([mate.id]);
    await expectMoneyParity();
  });

  it('can’t be written by hand, by a person or the worker', async () => {
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.invoices set member_viewer_ids = array[${outsider.id}::uuid] where id = ${docs.orphanInvoice}`,
      ),
    );
    expect(await viewersOf('invoices', docs.orphanInvoice)).toEqual([]);
    const [forged] = await worker(
      A.ws,
      A.org,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.invoice_lines (workspace_id, invoice_id, name, quantity, unit_price_cents, amount_cents, member_viewer_ids, sync_window)
            values (${A.ws}, ${docs.techJobInvoice}, 'Filter', 1, 2000, 2000, array[${outsider.id}::uuid], false) returning id`,
      ),
    );
    expect(await viewersOf('invoice_lines', forged!.id)).toEqual([tech.id]);
    const [window] = await rows<{ w: boolean }>(
      admin$,
      sql`select sync_window as w from app.invoice_lines where id = ${forged!.id}`,
    );
    expect(window!.w).toBe(true);
  });

  it('never move updated_at, while a save that changes nothing still does', async () => {
    const stamps = async () =>
      (
        await rows<{ invoice: string; line: string; payment: string }>(
          admin$,
          sql`select i.updated_at::text as invoice, l.updated_at::text as line, p.updated_at::text as payment
              from app.invoices i join app.invoice_lines l on l.invoice_id = i.id join app.payments p on p.invoice_id = i.id
              where i.id = ${docs.mateJobInvoice} order by l.created_at limit 1`,
        )
      )[0]!;
    const before = await stamps();
    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id) values (${A.ws}, ${w.mateAppointmentId}, ${tech.id})`,
      ),
    );
    expect(await viewersOf('invoices', docs.mateJobInvoice)).toEqual([tech.id, mate.id].sort());
    expect(await stamps()).toEqual(before);
    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(
        sql`delete from app.appointment_staff where appointment_id = ${w.mateAppointmentId} and user_id = ${tech.id}`,
      ),
    );
    expect(await stamps()).toEqual(before);
    // A draft saved with nothing changed still takes a new revision (money-shared.ts reads updated_at as one).
    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(sql`update app.invoices set title = title where id = ${docs.mateJobInvoice}`),
    );
    expect((await stamps()).invoice).not.toBe(before.invoice);
  });

  it('leave the roll-up counting payments', async () => {
    const paidOf = async () =>
      (
        await rows<{ paid: number }>(
          admin$,
          sql`select amount_paid_cents::int as paid from app.invoices where id = ${docs.orphanInvoice}`,
        )
      )[0]!.paid;
    expect(await paidOf()).toBe(0);
    const [pay] = await worker(
      A.ws,
      A.org,
    )((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, provider, status)
            values (${A.ws}, ${docs.orphanInvoice}, 15000, 'card', 'stripe', 'processing') returning id`,
      ),
    );
    expect(await paidOf()).toBe(0);
    await worker(
      A.ws,
      A.org,
    )((tx) =>
      tx.execute(
        sql`update app.payments set status = 'succeeded', received_at = now() where id = ${pay!.id}`,
      ),
    );
    expect(await paidOf()).toBe(15000);
  });

  // Every document any test left behind: a local database only grows (sync-limits alone adds 2,000 documents a run),
  // so this gets the time a full, busy suite needs.
  it('agree with the members’ policies for every document in the database', async () => {
    expect(await rows(admin$, sql`select * from private.sync_viewer_mismatches()`)).toEqual([]);
  }, 120_000);

  it('are judged by helpers that notice a list gone wrong behind the triggers’ backs', async () => {
    const planted = await admin$
      .transaction(async (tx) => {
        await tx.execute(sql`alter table app.invoices disable trigger invoices_sync_columns`);
        await tx.execute(
          sql`update app.invoices set member_viewer_ids = '{}' where id = ${docs.techJobInvoice}`,
        );
        await tx.execute(
          sql`update app.workspace_access set role = 'owner' where user_id = ${mate.id} and workspace_id = ${A.ws}`,
        );
        // Listed where RLS hides the row: a member in their own business, and an owner (who reads money through
        // managing it, so only a list can name them), on a document and on a payment.
        await tx.execute(
          sql`update app.invoices set member_viewer_ids = array[${mate.id}, ${owner.id}]::uuid[] where id = ${docs.orphanInvoice}`,
        );
        await tx.execute(sql`alter table app.payments disable trigger payments_sync_columns`);
        const [payment] = await rows<{ id: string }>(
          tx,
          sql`update app.payments set member_viewer_ids = member_viewer_ids || ${owner.id}::uuid
              where id = (select id from app.payments where invoice_id = ${docs.mateJobInvoice} order by id limit 1)
              returning id`,
        );
        const viewers = await rows<{
          table_name: string;
          row_id: string;
          user_id: string;
          listed: boolean;
          visible: boolean;
        }>(tx, sql`select * from private.sync_viewer_mismatches(${A.ws})`);
        const access = await rows<{ user_id: string; stored_role: string; effective_role: string }>(
          tx,
          sql`select * from private.sync_access_mismatches(${A.ws})`,
        );
        throw Object.assign(new Error('rollback'), { viewers, access, paymentId: payment!.id });
      })
      .catch((e: { viewers?: unknown; access?: unknown; paymentId?: string }) => e);
    expect(planted.viewers).toContainEqual({
      table_name: 'invoices',
      row_id: docs.techJobInvoice,
      user_id: tech.id,
      listed: false,
      visible: true,
    });
    for (const user of [mate, owner])
      expect(planted.viewers).toContainEqual({
        table_name: 'invoices',
        row_id: docs.orphanInvoice,
        user_id: user.id,
        listed: true,
        visible: false,
      });
    expect(planted.viewers).toContainEqual({
      table_name: 'payments',
      row_id: planted.paymentId,
      user_id: owner.id,
      listed: true,
      visible: false,
    });
    expect(planted.access).toContainEqual(
      expect.objectContaining({ user_id: mate.id, stored_role: 'owner', effective_role: 'member' }),
    );
    // And nothing was kept.
    expect(await viewersOf('invoices', docs.techJobInvoice)).toEqual([tech.id]);
  });
});
