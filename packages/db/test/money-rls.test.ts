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

/** Org A's owner (also workspace A's owner). */
let owner: TestUser;
/** Workspace A's admin. */
let admin: TestUser;
/** The tech whose jobs we follow, and a second one whose jobs are none of his business. */
let tech: TestUser;
let mate: TestUser;
/** Org B's owner. */
let outsider: TestUser;

interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;

const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const failure = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};
const code = async (fn: () => Promise<unknown>) => (await expectPgError(fn)).code;
const issued = { code: '42501', detail: 'money_document_issued' };
const acceptanceProtected = { code: '42501', detail: 'money_acceptance_protected' };
const actorMismatch = { code: '42501', detail: 'money_actor_mismatch' };

/** Everything one business's money hangs off. */
interface World {
  readonly personId: string;
  readonly calendarId: string;
  /** The tech's job, and his mate's. */
  readonly techAttendeeId: string;
  readonly mateAttendeeId: string;
  /** A lead assigned to the tech, and one assigned to nobody. */
  readonly techLeadId: string;
  readonly looseLeadId: string;
}
let a: World;
/** The other business, so nothing of A's is ever reachable from it. */
let b: World;

beforeAll(async () => {
  [owner, admin, tech, mate, outsider] = await Promise.all([
    createTestUser('money-owner'),
    createTestUser('money-admin'),
    createTestUser('money-tech'),
    createTestUser('money-mate'),
    createTestUser('money-outsider'),
  ]);
  const orgA = await bootstrapOrganization(owner, 'Money Org A', 'Money A');
  A = { ws: orgA.wsId, org: orgA.orgId };
  const orgB = await bootstrapOrganization(outsider, 'Money Org B', 'Money B');
  B = { ws: orgB.wsId, org: orgB.orgId };
  await dbs.admin.db.insert(workspaceMemberships).values([
    { workspaceId: A.ws, userId: admin.id, role: 'admin' },
    { workspaceId: A.ws, userId: tech.id, role: 'member' },
    { workspaceId: A.ws, userId: mate.id, role: 'member' },
  ]);
  a = await buildWorld(A, tech, mate);
  b = await buildWorld(B, outsider, outsider);
});
afterAll(closeAll);

/** A customer, two jobs a day apart with one person of that business on each, and two leads. */
async function buildWorld(b: Business, first: TestUser, second: TestUser): Promise<World> {
  return worker(b)(async (tx) => {
    const [p] = await rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name) values (${b.ws}, 'Maria', 'Lopez') returning id`,
    );
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.calendars (workspace_id, name, slug, status, public)
          values (${b.ws}, 'Tune-ups', ${`money-${uniq().toLowerCase()}`}, 'active', true) returning id`,
    );
    const [stage] = await rows<{ id: string; pipeline_id: string }>(
      tx,
      sql`select id, pipeline_id from app.pipeline_stages
          where workspace_id = ${b.ws} and kind = 'open' order by position limit 1`,
    );
    const lead = async (assignee: string | null) => {
      const [l] = await rows<{ id: string }>(
        tx,
        sql`insert into app.leads (workspace_id, pipeline_id, stage_id, person_id, title, value_cents, assignee_user_id)
            values (${b.ws}, ${stage!.pipeline_id}, ${stage!.id}, ${p!.id}, 'AC replacement', 1850000, ${assignee})
            returning id`,
      );
      return l!.id;
    };
    const job = async (staffUserId: string, hoursOut: number) => {
      const [ap] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, kind, capacity, title,
              starts_at, ends_at, source)
            values (${b.ws}, ${c!.id}, 1, 'booking', 1, 'AC tune-up',
              now() + make_interval(hours => ${hoursOut}), now() + make_interval(hours => ${hoursOut + 1}), 'staff')
            returning id`,
      );
      await tx.execute(
        sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id)
            values (${b.ws}, ${ap!.id}, ${staffUserId})`,
      );
      const [seat] = await rows<{ id: string }>(
        tx,
        sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
            values (${b.ws}, ${ap!.id}, ${p!.id}) returning id`,
      );
      return seat!.id;
    };
    return {
      personId: p!.id,
      calendarId: c!.id,
      techAttendeeId: await job(first.id, 24),
      mateAttendeeId: await job(second.id, 48),
      techLeadId: await lead(first.id),
      looseLeadId: await lead(null),
    };
  });
}

interface Link {
  readonly leadId?: string | null;
  readonly attendeeId?: string | null;
}

/** A draft invoice for Maria, linked to a job, a lead, both or neither. */
async function invoice(
  b: Business,
  w: World,
  link: Link = {},
  totalCents = 45000,
): Promise<string> {
  const [row] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.invoices (workspace_id, person_id, lead_id, attendee_id, title, subtotal_cents,
            taxable_base_cents, tax_cents, total_cents, tax_rate_bp, tax_label)
          values (${b.ws}, ${w.personId}, ${link.leadId ?? null}, ${link.attendeeId ?? null},
            'AC tune-up', ${totalCents}, ${totalCents}, 0, ${totalCents}, 0, 'Sales tax')
          returning id`,
    ),
  );
  await worker(b)((tx) =>
    tx.execute(
      sql`insert into app.invoice_lines (workspace_id, invoice_id, name, quantity, unit_price_cents, amount_cents)
          values (${b.ws}, ${row!.id}, 'AC tune-up', 1, ${totalCents}, ${totalCents})`,
    ),
  );
  return row!.id;
}

async function estimate(b: Business, w: World, link: Link = {}): Promise<string> {
  const [row] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.estimates (workspace_id, person_id, lead_id, title, subtotal_cents,
            taxable_base_cents, total_cents, tax_rate_bp)
          values (${b.ws}, ${w.personId}, ${link.leadId ?? null}, 'AC replacement', 1850000, 1850000, 1850000, 0)
          returning id`,
    ),
  );
  await worker(b)((tx) =>
    tx.execute(
      sql`insert into app.estimate_lines (workspace_id, estimate_id, name, quantity, unit_price_cents, amount_cents)
          values (${b.ws}, ${row!.id}, 'New condenser', 1, 1850000, 1850000)`,
    ),
  );
  return row!.id;
}

/** Sends a document the way the command will: a number off the counter and the clock's stamp. */
async function send(b: Business, table: 'estimates' | 'invoices', id: string, number: string) {
  await worker(b)((tx) =>
    tx.execute(
      sql`update app.${sql.raw(table)} set status = 'sent', number = ${number}, sent_at = now() where id = ${id}`,
    ),
  );
}

/** A cash payment, as invoice.record_cash_payment will record one. */
async function cash(user: TestUser, b: Business, invoiceId: string, amountCents: number) {
  const [row] = await as(user)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at, recorded_by)
          values (${b.ws}, ${invoiceId}, ${amountCents}, 'cash', 'succeeded', now(), ${user.id})
          returning id`,
    ),
  );
  return row!.id;
}

const seenBy = (user: TestUser, table: string, id: string) =>
  as(user)((tx) =>
    rows<{ id: string }>(tx, sql`select id from app.${sql.raw(table)} where id = ${id}`),
  ).then((r) => r.length === 1);

const countFor = (user: TestUser, table: string, ws: string) =>
  as(user)((tx) =>
    rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from app.${sql.raw(table)} where workspace_id = ${ws}`,
    ),
  ).then((r) => r[0]!.n);

describe('one business never sees another’s money', () => {
  it('an outsider sees nothing of workspace A, and A’s owner nothing of B', async () => {
    const mine = await invoice(A, a, { leadId: a.techLeadId });
    const theirs = await invoice(B, b, { leadId: b.techLeadId });
    expect(await seenBy(outsider, 'invoices', mine)).toBe(false);
    expect(await seenBy(owner, 'invoices', theirs)).toBe(false);
    expect(await countFor(outsider, 'invoices', A.ws)).toBe(0);
    expect(await countFor(owner, 'invoices', B.ws)).toBe(0);
  });

  it('a reference from another business is refused, whoever writes it', async () => {
    expect(
      await failure(() =>
        worker(A)((tx) =>
          tx.execute(
            sql`insert into app.invoices (workspace_id, person_id, lead_id, total_cents)
                values (${A.ws}, ${a.personId}, ${b.techLeadId}, 1000)`,
          ),
        ),
      ),
    ).toEqual({ code: '23514', detail: 'record_workspace_mismatch' });
  });
});

describe('who sees a document', () => {
  it('an owner and an admin see every document, its lines, its payments and its refunds', async () => {
    const id = await invoice(A, a, {});
    await cash(owner, A, id, 10000);
    for (const user of [owner, admin]) {
      expect(await seenBy(user, 'invoices', id)).toBe(true);
      expect(
        await as(user)((tx) =>
          rows(tx, sql`select id from app.invoice_lines where invoice_id = ${id}`),
        ),
      ).toHaveLength(1);
      expect(
        await as(user)((tx) => rows(tx, sql`select id from app.payments where invoice_id = ${id}`)),
      ).toHaveLength(1);
    }
  });

  it('a member sees the invoice for the job he worked, and its payments', async () => {
    const mine = await invoice(A, a, { attendeeId: a.techAttendeeId });
    const paymentId = await cash(owner, A, mine, 45000);
    expect(await seenBy(tech, 'invoices', mine)).toBe(true);
    expect(await seenBy(tech, 'payments', paymentId)).toBe(true);
    expect(
      await as(tech)((tx) =>
        rows(tx, sql`select id from app.invoice_lines where invoice_id = ${mine}`),
      ),
    ).toHaveLength(1);
  });

  it('a member sees the refunds on his own job, and not the next one’s', async () => {
    const mine = await invoice(A, a, { attendeeId: a.techAttendeeId });
    const next = await invoice(A, a, { attendeeId: a.mateAttendeeId });
    const [minePaid, nextPaid] = [
      await cash(owner, A, mine, 45000),
      await cash(owner, A, next, 45000),
    ];
    const refund = async (invoiceId: string, paymentId: string) => {
      const [r] = await worker(A)((tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into app.refunds (workspace_id, payment_id, invoice_id, amount_cents, status, refunded_at)
              values (${A.ws}, ${paymentId}, ${invoiceId}, 500, 'succeeded', now()) returning id`,
        ),
      );
      return r!.id;
    };
    expect(await seenBy(tech, 'refunds', await refund(mine, minePaid))).toBe(true);
    expect(await seenBy(tech, 'refunds', await refund(next, nextPaid))).toBe(false);
  });

  it('a member does not see the next job’s invoice or its payments', async () => {
    const theirs = await invoice(A, a, { attendeeId: a.mateAttendeeId });
    const paymentId = await cash(owner, A, theirs, 45000);
    expect(await seenBy(tech, 'invoices', theirs)).toBe(false);
    expect(await seenBy(tech, 'payments', paymentId)).toBe(false);
    expect(
      await as(tech)((tx) =>
        rows(tx, sql`select id from app.invoice_lines where invoice_id = ${theirs}`),
      ),
    ).toHaveLength(0);
    // …and the mate does see it: the rule is about who is on the job, not about seniority.
    expect(await seenBy(mate, 'invoices', theirs)).toBe(true);
  });

  it('a member sees a document on the lead he owns, and an estimate on a lead that is not his', async () => {
    const mine = await estimate(A, a, { leadId: a.techLeadId });
    const loose = await estimate(A, a, { leadId: a.looseLeadId });
    expect(await seenBy(tech, 'estimates', mine)).toBe(true);
    expect(await seenBy(tech, 'estimates', loose)).toBe(false);
    expect(
      await as(tech)((tx) =>
        rows(tx, sql`select id from app.estimate_lines where estimate_id = ${mine}`),
      ),
    ).toHaveLength(1);
    expect(
      await as(tech)((tx) =>
        rows(tx, sql`select id from app.estimate_lines where estimate_id = ${loose}`),
      ),
    ).toHaveLength(0);
  });

  it('a document with no booking and no lead of theirs is owner business', async () => {
    const orphan = await invoice(A, a, {});
    const paymentId = await cash(owner, A, orphan, 45000);
    const orphanEstimate = await estimate(A, a, {});
    for (const user of [tech, mate]) {
      expect(await seenBy(user, 'invoices', orphan)).toBe(false);
      expect(await seenBy(user, 'payments', paymentId)).toBe(false);
      expect(await seenBy(user, 'estimates', orphanEstimate)).toBe(false);
    }
    expect(await seenBy(owner, 'invoices', orphan)).toBe(true);
  });

  it('a member cannot write a document, a line or a payment, on his own job or anyone else’s', async () => {
    const mine = await invoice(A, a, { attendeeId: a.techAttendeeId });
    // Seeing a row is not reaching it: the update policy needs money.manage, so his UPDATE matches nothing.
    expect(
      await as(tech)((tx) =>
        rows(tx, sql`update app.invoices set title = 'mine now' where id = ${mine} returning id`),
      ),
    ).toHaveLength(0);
    expect(
      await code(() =>
        as(tech)((tx) =>
          tx.execute(
            sql`insert into app.invoice_lines (workspace_id, invoice_id, name, unit_price_cents, amount_cents)
                values (${A.ws}, ${mine}, 'Extra', 100, 100)`,
          ),
        ),
      ),
    ).toBe('42501');
    expect(await code(() => cash(tech, A, mine, 100))).toBe('42501');
  });

  it('a member reads the catalogue, and never sees a connected account', async () => {
    await worker(A)((tx) =>
      tx.execute(
        sql`insert into app.products (workspace_id, name, unit_price_cents) values (${A.ws}, ${`Filter ${uniq()}`}, 2400)`,
      ),
    );
    expect(await countFor(tech, 'products', A.ws)).toBeGreaterThan(0);
    await connection(A, 'stripe', `acct_${uniq()}`);
    expect(await countFor(tech, 'payment_connections', A.ws)).toBe(0);
    expect(await countFor(owner, 'payment_connections', A.ws)).toBeGreaterThan(0);
  });
});

describe('signed out', () => {
  it('anon reaches nothing at all', async () => {
    const e = await expectPgError(() =>
      dbs.admin.db.transaction(async (tx) => {
        await tx.execute(sql`set local role anon`);
        return tx.execute(sql`select id from app.invoices limit 1`);
      }),
    );
    expect(e.code).toBe('42501');
  });
});

describe('an issued document is frozen', () => {
  it('its number, its tax and its totals stop moving once it has gone out', async () => {
    const id = await invoice(A, a, {});
    await send(A, 'invoices', id, `INV-${uniq()}`);
    const change = (set: string) =>
      failure(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.invoices set ${sql.raw(set)} where id = ${id}`),
        ),
      );
    expect(await change(`total_cents = 99999`)).toEqual(issued);
    expect(await change(`tax_rate_bp = 825`)).toEqual(issued);
    expect(await change(`number = 'INV-0002'`)).toEqual(issued);
    expect(await change(`currency = 'EUR'`)).toEqual(issued);
    expect(await change(`sent_at = null, status = 'draft', number = null`)).toEqual(issued);
    // What is not frozen still moves: terms, notes, the due date and the assignee.
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.invoices set terms = 'Net 15', due_on = current_date + 15 where id = ${id}`,
      ),
    );
  });

  it('its lines are frozen with it: no adding, no changing, no removing', async () => {
    const id = await invoice(A, a, {});
    await send(A, 'invoices', id, `INV-${uniq()}`);
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`insert into app.invoice_lines (workspace_id, invoice_id, name, unit_price_cents, amount_cents)
                values (${A.ws}, ${id}, 'One more', 100, 100)`,
          ),
        ),
      ),
    ).toEqual(issued);
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.invoice_lines set name = 'Renamed' where invoice_id = ${id}`),
        ),
      ),
    ).toEqual(issued);
    expect(
      await failure(() =>
        as(owner)((tx) => tx.execute(sql`delete from app.invoice_lines where invoice_id = ${id}`)),
      ),
    ).toEqual(issued);
  });

  it('a draft is still a draft: totals and lines move freely until it is sent', async () => {
    const id = await estimate(A, a, {});
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.estimates set total_cents = 1900000, tax_rate_bp = 825 where id = ${id}`,
      ),
    );
    await as(owner)((tx) =>
      tx.execute(sql`delete from app.estimate_lines where estimate_id = ${id}`),
    );
    const [row] = await as(owner)((tx) =>
      rows<{ total_cents: string }>(
        tx,
        sql`select total_cents from app.estimates where id = ${id}`,
      ),
    );
    expect(Number(row!.total_cents)).toBe(1900000);
  });

  it('a voided document is finished', async () => {
    const id = await invoice(A, a, {});
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.invoices set status = 'void', voided_at = now(), voided_by = ${owner.id},
            void_reason = 'Wrong customer' where id = ${id}`,
      ),
    );
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.invoices set title = 'again' where id = ${id}`),
        ),
      ),
    ).toEqual(issued);
  });

  it('the database stamps when a document went out, not the caller', async () => {
    const id = await invoice(A, a, {});
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.invoices set status = 'sent', number = ${`INV-${uniq()}`},
            sent_at = now() - interval '300 days' where id = ${id}`,
      ),
    );
    const [row] = await as(owner)((tx) =>
      rows<{ fresh: boolean }>(
        tx,
        sql`select sent_at > now() - interval '1 minute' as fresh from app.invoices where id = ${id}`,
      ),
    );
    expect(row!.fresh).toBe(true);
  });
});

describe('what the customer did is the worker’s', () => {
  it('nobody marks an invoice viewed, paid or part paid by hand', async () => {
    const id = await invoice(A, a, {});
    const change = (set: string) =>
      failure(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.invoices set ${sql.raw(set)} where id = ${id}`),
        ),
      );
    expect(await change(`first_viewed_at = now()`)).toEqual(acceptanceProtected);
    expect(await change(`amount_paid_cents = 45000`)).toEqual(acceptanceProtected);
    expect(await change(`amount_refunded_cents = 100`)).toEqual(acceptanceProtected);
    expect(await change(`paid_at = now()`)).toEqual(acceptanceProtected);
    expect(await change(`reminder_state = '{"first": true}'::jsonb`)).toEqual(acceptanceProtected);
  });

  it('nobody fakes an acceptance the customer made on their own page', async () => {
    const id = await estimate(A, a, {});
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.estimates set status = 'accepted', accepted_at = now(), accepted_via = 'link',
                accepted_name = 'Maria L.' where id = ${id}`,
          ),
        ),
      ),
    ).toEqual(acceptanceProtected);
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.estimates set first_viewed_at = now() where id = ${id}`),
        ),
      ),
    ).toEqual(acceptanceProtected);
  });

  it('a person records a staff acceptance in their own name, and the clock stamps it', async () => {
    const id = await estimate(A, a, {});
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.estimates set status = 'accepted', accepted_at = now(), accepted_via = 'staff',
                accepted_by = ${admin.id}, accepted_name = 'Maria L.' where id = ${id}`,
          ),
        ),
      ),
    ).toEqual(actorMismatch);
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.estimates set status = 'accepted', accepted_at = now() - interval '9 days',
            accepted_via = 'staff', accepted_by = ${owner.id}, accepted_name = 'Maria said yes on the phone'
            where id = ${id}`,
      ),
    );
    const [row] = await as(owner)((tx) =>
      rows<{ fresh: boolean; accepted_via: string }>(
        tx,
        sql`select accepted_via, accepted_at > now() - interval '1 minute' as fresh
            from app.estimates where id = ${id}`,
      ),
    );
    expect(row).toMatchObject({ accepted_via: 'staff', fresh: true });
  });

  it('a staff mark can be taken back; a customer’s acceptance cannot', async () => {
    const mine = await estimate(A, a, {});
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.estimates set status = 'accepted', accepted_at = now(), accepted_via = 'staff',
            accepted_by = ${owner.id}, accepted_name = 'Maria L.' where id = ${mine}`,
      ),
    );
    await as(admin)((tx) =>
      tx.execute(
        sql`update app.estimates set status = 'sent', accepted_at = null, accepted_via = null,
            accepted_by = null, accepted_name = null where id = ${mine}`,
      ),
    );
    expect(
      await as(owner)((tx) =>
        rows<{ accepted_at: Date | null }>(
          tx,
          sql`select accepted_at from app.estimates where id = ${mine}`,
        ),
      ),
    ).toEqual([{ accepted_at: null }]);

    const theirs = await estimate(A, a, {});
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.estimates set status = 'accepted', accepted_at = now(), accepted_via = 'link',
            accepted_name = 'Maria L.', accepted_hash = ${'x'.repeat(64)} where id = ${theirs}`,
      ),
    );
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.estimates set status = 'sent', accepted_at = null, accepted_via = null,
                accepted_name = null, accepted_hash = null where id = ${theirs}`,
          ),
        ),
      ),
    ).toEqual(acceptanceProtected);
  });
});

/** What the roll-up has made of an invoice, as its owner reads it. */
async function paidState(id: string) {
  const [row] = await as(owner)((tx) =>
    rows<{
      amount_paid_cents: string;
      amount_refunded_cents: string;
      balance_cents: string;
      status: string;
      paid_at: Date | null;
    }>(
      tx,
      sql`select amount_paid_cents, amount_refunded_cents, balance_cents, status, paid_at
          from app.invoices where id = ${id}`,
    ),
  );
  return row!;
}

/** A refund the worker has recorded as gone through. */
async function refunded(b: Business, invoiceId: string, paymentId: string, amountCents: number) {
  await worker(b)((tx) =>
    tx.execute(
      sql`insert into app.refunds (workspace_id, payment_id, invoice_id, amount_cents, status, refunded_at)
          values (${b.ws}, ${paymentId}, ${invoiceId}, ${amountCents}, 'succeeded', now())`,
    ),
  );
}

describe('what an invoice has been paid is counted, not typed', () => {
  it('a cash payment a person records pays the invoice down, and a refund never puts it back', async () => {
    const id = await invoice(A, a, {}, 45000);
    await send(A, 'invoices', id, `INV-${uniq()}`);
    const paymentId = await cash(owner, A, id, 20000);
    expect(await paidState(id)).toMatchObject({
      amount_paid_cents: '20000',
      status: 'partly_paid',
    });
    expect((await paidState(id)).balance_cents).toBe('25000');
    await cash(owner, A, id, 25000);
    const paid = await paidState(id);
    expect(paid).toMatchObject({ amount_paid_cents: '45000', status: 'paid', balance_cents: '0' });
    expect(paid.paid_at).not.toBeNull();

    // Money given back is counted, and that is all it is: the invoice stays paid, from the day it was.
    await refunded(A, id, paymentId, 5000);
    const after = await paidState(id);
    expect(after).toMatchObject({
      amount_refunded_cents: '5000',
      status: 'paid',
      balance_cents: '0',
    });
    expect(after.paid_at).toEqual(paid.paid_at);
  });

  it('a full refund keeps the invoice paid, with nothing owed and the day it was paid kept', async () => {
    const id = await invoice(A, a, {}, 45000);
    await send(A, 'invoices', id, `INV-${uniq()}`);
    const paymentId = await cash(owner, A, id, 45000);
    const paid = await paidState(id);
    expect(paid).toMatchObject({ status: 'paid', balance_cents: '0' });
    await refunded(A, id, paymentId, 45000);
    const after = await paidState(id);
    expect(after).toMatchObject({
      amount_paid_cents: '45000',
      amount_refunded_cents: '45000',
      status: 'paid',
      balance_cents: '0',
    });
    expect(after.paid_at).not.toBeNull();
    expect(after.paid_at).toEqual(paid.paid_at);
  });

  it('paid more than was owed, then the extra given back: a credit first, then nothing owed', async () => {
    const id = await invoice(A, a, {}, 45000);
    await send(A, 'invoices', id, `INV-${uniq()}`);
    // Two payments crossing in the post: the worker records what arrived, whatever it adds up to.
    await cash(owner, A, id, 45000);
    const extra = await cash(owner, A, id, 5000);
    expect(await paidState(id)).toMatchObject({ status: 'paid', balance_cents: '-5000' });
    await refunded(A, id, extra, 2000);
    expect((await paidState(id)).balance_cents).toBe('-3000');
    await refunded(A, id, extra, 3000);
    expect(await paidState(id)).toMatchObject({
      amount_refunded_cents: '5000',
      status: 'paid',
      balance_cents: '0',
    });
  });

  it('part paid, then that part given back: only the unpaid part is owed', async () => {
    const id = await invoice(A, a, {}, 45000);
    await send(A, 'invoices', id, `INV-${uniq()}`);
    const paymentId = await cash(owner, A, id, 15000);
    await refunded(A, id, paymentId, 15000);
    const after = await paidState(id);
    expect(after).toMatchObject({
      amount_paid_cents: '15000',
      amount_refunded_cents: '15000',
      status: 'partly_paid',
      balance_cents: '30000',
    });
    expect(after.paid_at).toBeNull();
  });

  it('a payment that has not succeeded pays nothing down', async () => {
    const id = await invoice(A, a, {}, 45000);
    await worker(A)((tx) =>
      tx.execute(
        sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, provider, status,
              idempotency_key)
            values (${A.ws}, ${id}, 45000, 'ach', 'stripe', 'processing', ${`key-${uniq()}`})`,
      ),
    );
    const [row] = await as(owner)((tx) =>
      rows<{ amount_paid_cents: string; status: string }>(
        tx,
        sql`select amount_paid_cents, status from app.invoices where id = ${id}`,
      ),
    );
    expect(row).toMatchObject({ amount_paid_cents: '0', status: 'draft' });
  });
});

describe('a payment’s status only moves forward', () => {
  it('a late "processing" never un-pays an invoice', async () => {
    const id = await invoice(A, a, {}, 45000);
    await send(A, 'invoices', id, `INV-${uniq()}`);
    const key = `key-${uniq()}`;
    const [row] = await worker(A)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, provider, status,
              provider_payment_id, idempotency_key)
            values (${A.ws}, ${id}, 45000, 'ach', 'stripe', 'processing', ${`pi_${uniq()}`}, ${key})
            returning id`,
      ),
    );
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.payments set status = 'succeeded', received_at = now() where id = ${row!.id}`,
      ),
    );
    await worker(A)((tx) =>
      tx.execute(sql`update app.payments set status = 'processing' where id = ${row!.id}`),
    );
    const [after] = await as(owner)((tx) =>
      rows<{ status: string }>(tx, sql`select status from app.payments where id = ${row!.id}`),
    );
    expect(after!.status).toBe('succeeded');
    const [inv] = await as(owner)((tx) =>
      rows<{ status: string }>(tx, sql`select status from app.invoices where id = ${id}`),
    );
    expect(inv!.status).toBe('paid');
  });

  it('one idempotency key charges once', async () => {
    const id = await invoice(A, a, {}, 45000);
    const key = `key-${uniq()}`;
    const charge = () =>
      worker(A)((tx) =>
        tx.execute(
          sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, provider, status,
                connection_id, idempotency_key)
              values (${A.ws}, ${id}, 45000, 'card', 'stripe', 'requires_payment', null, ${key})`,
        ),
      );
    await charge();
    expect(await code(charge)).toBe('23505');
  });
});

/** A connected account, as the callback records one. */
async function connection(
  b: Business,
  provider: 'stripe' | 'square',
  externalId: string,
): Promise<string> {
  const [row] = await worker(b)((tx) =>
    rows<{ id: string }>(
      tx,
      sql`insert into app.payment_connections (workspace_id, provider, environment, status,
            external_account_id, display_name, token_enc, token_key_id, connected_at)
          values (${b.ws}, ${provider}::app.payment_provider, 'live', 'active', ${externalId},
            'Lone Star HVAC', ${`sealed-${uniq()}`}, 'key-1', now())
          returning id`,
    ),
  );
  return row!.id;
}

describe('a connected account keeps its secrets', () => {
  it('`authenticated` cannot read the sealed token or the sign-in state, even as the owner', async () => {
    await connection(A, 'stripe', `acct_${uniq()}`);
    for (const column of [
      'token_enc',
      'token_key_id',
      'pkce_verifier_enc',
      'oauth_state_hash',
      'oauth_state_expires_at',
    ]) {
      expect(
        await code(() =>
          as(owner)((tx) =>
            rows(
              tx,
              sql`select ${sql.raw(column)} from app.payment_connections where workspace_id = ${A.ws}`,
            ),
          ),
        ),
      ).toBe('42501');
    }
    // Everything a person is meant to see still reads.
    expect(
      await as(owner)((tx) =>
        rows(
          tx,
          sql`select id, provider, status, external_account_id, label, is_default
              from app.payment_connections where workspace_id = ${A.ws}`,
        ),
      ),
    ).not.toHaveLength(0);
  });

  it('people rename an account and choose the default while it is connected, and otherwise only disconnect it', async () => {
    const id = await connection(A, 'square', `msq_${uniq()}`);
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.payment_connections set label = 'Front desk', is_default = true where id = ${id}`,
      ),
    );
    await as(owner)((tx) =>
      tx.execute(sql`update app.payment_connections set status = 'disconnected' where id = ${id}`),
    );
    const [row] = await rows<{
      token_enc: string | null;
      pkce_verifier_enc: string | null;
      is_default: boolean;
      disconnected_reason: string | null;
    }>(
      dbs.admin.db,
      sql`select token_enc, pkce_verifier_enc, is_default, disconnected_reason
          from app.payment_connections where id = ${id}`,
    );
    expect(row).toMatchObject({
      token_enc: null,
      pkce_verifier_enc: null,
      is_default: false,
      disconnected_reason: 'person',
    });
    expect(
      await failure(() =>
        as(owner)((tx) =>
          tx.execute(sql`update app.payment_connections set label = 'Again' where id = ${id}`),
        ),
      ),
    ).toEqual({ code: '42501', detail: 'payment_connection_not_active' });
  });

  it('credentials are found by account id, disconnected or not', async () => {
    const externalId = `acct_${uniq()}`;
    const id = await connection(A, 'stripe', externalId);
    const lookup = () =>
      dbs.worker.db.transaction(async (tx) => {
        await tx.execute(sql`set local role service_actor`);
        return rows<{
          connection_id: string;
          workspace_id: string;
          organization_id: string;
          environment: string;
        }>(tx, sql`select * from private.payment_connection_by_account('stripe', ${externalId})`);
      });
    expect(await lookup()).toEqual([
      { connection_id: id, workspace_id: A.ws, organization_id: A.org, environment: 'live' },
    ]);
    await as(owner)((tx) =>
      tx.execute(sql`update app.payment_connections set status = 'disconnected' where id = ${id}`),
    );
    // A bank transfer settles days after a disconnect, and an old payment is still refundable.
    expect(await lookup()).toEqual([
      { connection_id: id, workspace_id: A.ws, organization_id: A.org, environment: 'live' },
    ]);
  });

  it('the OAuth callback finds a pending payment sign-in by its one-time state', async () => {
    const stateHash = `state-${uniq()}-${uniq()}`;
    await worker(A)((tx) =>
      tx.execute(
        sql`insert into app.payment_connections (workspace_id, provider, status, oauth_state_hash,
              oauth_state_expires_at)
            values (${A.ws}, 'square', 'pending', ${stateHash}, now() + interval '10 minutes')`,
      ),
    );
    const found = await dbs.worker.db.transaction(async (tx) => {
      await tx.execute(sql`set local role service_actor`);
      return rows<{ kind: string; workspace_id: string; user_id: string | null }>(
        tx,
        sql`select kind, workspace_id, user_id from private.oauth_connection_by_state(${stateHash})`,
      );
    });
    expect(found).toEqual([{ kind: 'payment', workspace_id: A.ws, user_id: null }]);
  });
});

describe('parity with core', () => {
  it('the attention kinds match core’s list, in the order the migrations added them', async () => {
    const [check] = await rows<{ def: string }>(
      dbs.admin.db,
      sql`select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'app.attention_items'::regclass and conname = 'attention_items_kind_check'`,
    );
    const live = [...(check?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    // The whole list, not a count. `toHaveLength(10)` was a magic number that said nothing about what
    // changed when the wallet added its three in 0081, and it could only ever fail unhelpfully.
    expect(live).toEqual([
      'hot_lead',
      'unanswered_lead',
      'stale_opportunity',
      'missing_next_action',
      'unconfirmed_appointment',
      'ai_approval',
      'customer_waiting',
      'overdue_task',
      'estimate_waiting',
      'invoice_overdue',
      'wallet_low',
      'wallet_empty',
      'wallet_card_declined',
      'job_not_thanked',
      'referral_mentioned',
      'maintenance_due',
    ]);
    await worker(A)((tx) =>
      tx.execute(
        sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, title, fingerprint)
            values (${A.ws}, 'invoice_overdue', 'invoice', gen_random_uuid(), 'Invoice 1042 is 9 days late',
              ${`fp-${uniq()}`})`,
      ),
    );
    expect(
      await code(() =>
        worker(A)((tx) =>
          tx.execute(
            sql`insert into app.attention_items (workspace_id, kind, subject_type, subject_id, title, fingerprint)
                values (${A.ws}, 'invoice_late', 'invoice', gen_random_uuid(), 'Nope', ${`fp-${uniq()}`})`,
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('money.read is everyone’s and money.manage is the owner’s and the admin’s', async () => {
    const live = await rows<{ role: string; permission: string }>(
      dbs.admin.db,
      sql`select role, permission from app.role_permissions where permission like 'money.%' order by 1, 2`,
    );
    expect(live).toEqual([
      { role: 'admin', permission: 'money.manage' },
      { role: 'admin', permission: 'money.read' },
      { role: 'member', permission: 'money.read' },
      { role: 'owner', permission: 'money.manage' },
      { role: 'owner', permission: 'money.read' },
    ]);
  });
});
