/**
 * 0056: sync_window, the flag that keeps a phone's copy to recent history.
 *   - The worker's nightly sweep (private.sync_window_sweep) hides messages, calls and timeline entries older than
 *     12 months — never an open (or snoozed) conversation's — appointments that ended more than 90 days ago, and
 *     estimates and invoices 12 months after they closed, never an open one. It runs only for the business the
 *     worker is scoped to, a batch at a time.
 *   - Lines, payments and refunds follow their document; attendees and staff follow their appointment.
 *   - Things come back at once: a conversation that opens again, a visit moved into the window, a document that
 *     opens again, a time edited back into the last 12 months.
 *   - None of it moves updated_at, and a system timeline entry (otherwise immutable) can still be hidden.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
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
let other: TestUser;
let W: { ws: string; org: string };
let V: { ws: string; org: string };
let personId: string;
let calendarId: string;

const admin$ = dbs.admin.db;
const worker = () => asService({ workspaceId: W.ws, organizationId: W.org });

const sweep = async (limit = 10000) =>
  Object.fromEntries(
    (
      await worker()((tx) =>
        rows<{ table_name: string; hidden: number }>(
          tx,
          sql`select * from private.sync_window_sweep(${W.ws}, ${limit})`,
        ),
      )
    ).map((r) => [r.table_name, r.hidden]),
  ) as Record<string, number>;

const windowOf = async (table: string, id: string) =>
  (
    await rows<{ w: boolean }>(
      admin$,
      sql`select sync_window as w from app.${sql.raw(table)} where id = ${id}`,
    )
  )[0]!.w;

const updatedAtOf = async (table: string, id: string) =>
  (
    await rows<{ at: string }>(
      admin$,
      sql`select updated_at::text as at from app.${sql.raw(table)} where id = ${id}`,
    )
  )[0]!.at;

beforeAll(async () => {
  [owner, other] = await Promise.all([
    createTestUser('window-owner'),
    createTestUser('window-other'),
  ]);
  const w = await bootstrapOrganization(owner, 'Window Org', 'Window W');
  W = { ws: w.wsId, org: w.orgId };
  const v = await bootstrapOrganization(other, 'Window Other', 'Window V');
  V = { ws: v.wsId, org: v.orgId };
  await worker()(async (tx) => {
    const [p] = await rows<{ id: string }>(
      tx,
      sql`insert into app.people (workspace_id, first_name, last_name, phone_e164) values (${W.ws}, 'Old', 'Customer', '+15125550142') returning id`,
    );
    personId = p!.id;
    const [c] = await rows<{ id: string }>(
      tx,
      sql`insert into app.calendars (workspace_id, name, slug, status) values (${W.ws}, 'Visits', ${`visits-${uniq().toLowerCase()}`}, 'active') returning id`,
    );
    calendarId = c!.id;
  });
});
afterAll(closeAll);

async function conversation(tx: Tx, status: 'open' | 'snoozed' | 'closed', counterpart: string) {
  const [c] = await rows<{ id: string }>(
    tx,
    sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status, snoozed_until)
        values (${W.ws}, 'sms', ${counterpart}, ${personId}, ${status}, ${status === 'snoozed' ? sql`now() + interval '1 day'` : null})
        returning id`,
  );
  return c!.id;
}

async function message(tx: Tx, conversationId: string, ago: string) {
  const [m] = await rows<{ id: string }>(
    tx,
    sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
        values (${W.ws}, ${conversationId}, 'sms', 'inbound', 'received', 'Hi', now() - ${ago}::interval) returning id`,
  );
  return m!.id;
}

describe('messages and calls', () => {
  it('hides what is older than 12 months, except in a conversation that is still open', async () => {
    const ids = await worker()(async (tx) => {
      const closed = await conversation(tx, 'closed', '+15125550101');
      const open = await conversation(tx, 'open', '+15125550102');
      const snoozed = await conversation(tx, 'snoozed', '+15125550103');
      const [call] = await rows<{ id: string }>(
        tx,
        sql`insert into app.calls (workspace_id, conversation_id, direction, status, started_at)
            values (${W.ws}, ${closed}, 'inbound', 'completed', now() - interval '13 months') returning id`,
      );
      const [loneCall] = await rows<{ id: string }>(
        tx,
        sql`insert into app.calls (workspace_id, direction, status, started_at)
            values (${W.ws}, 'outbound', 'completed', now() - interval '400 days') returning id`,
      );
      return {
        closed,
        oldInClosed: await message(tx, closed, '13 months'),
        recentInClosed: await message(tx, closed, '11 months'),
        oldInOpen: await message(tx, open, '2 years'),
        oldInSnoozed: await message(tx, snoozed, '14 months'),
        call: call!.id,
        loneCall: loneCall!.id,
      };
    });
    const stamped = await updatedAtOf('messages', ids.oldInClosed);

    const hidden = await sweep();
    expect(hidden.messages).toBe(1);
    expect(hidden.calls).toBe(2);
    expect(await windowOf('messages', ids.oldInClosed)).toBe(false);
    expect(await windowOf('messages', ids.recentInClosed)).toBe(true);
    expect(await windowOf('messages', ids.oldInOpen)).toBe(true);
    expect(await windowOf('messages', ids.oldInSnoozed)).toBe(true);
    expect(await windowOf('calls', ids.call)).toBe(false);
    expect(await windowOf('calls', ids.loneCall)).toBe(false);
    expect(await updatedAtOf('messages', ids.oldInClosed)).toBe(stamped);
    // Nothing left to do on a second run.
    expect(Object.values(await sweep()).every((n) => n === 0)).toBe(true);

    // The customer writes again: the whole conversation comes back at once.
    await as(owner)((tx) =>
      tx.execute(sql`update app.conversations set status = 'open' where id = ${ids.closed}`),
    );
    expect(await windowOf('messages', ids.oldInClosed)).toBe(true);
    expect(await windowOf('calls', ids.call)).toBe(true);
    expect(await windowOf('calls', ids.loneCall)).toBe(false);
    expect(await updatedAtOf('messages', ids.oldInClosed)).toBe(stamped);
  });

  it('brings back a message whose time is edited into the last 12 months', async () => {
    const id = await worker()(async (tx) =>
      message(tx, await conversation(tx, 'closed', '+15125550104'), '15 months'),
    );
    await sweep();
    expect(await windowOf('messages', id)).toBe(false);
    await worker()((tx) =>
      tx.execute(
        sql`update app.messages set occurred_at = now() - interval '1 month' where id = ${id}`,
      ),
    );
    expect(await windowOf('messages', id)).toBe(true);
  });

  it('works a batch at a time', async () => {
    await worker()(async (tx) => {
      const closed = await conversation(tx, 'closed', '+15125550105');
      for (const ago of ['13 months', '14 months', '15 months']) await message(tx, closed, ago);
    });
    expect((await sweep(2)).messages).toBe(2);
    expect((await sweep(2)).messages).toBe(1);
    expect((await sweep(2)).messages).toBe(0);
  });
});

describe('the timeline', () => {
  it('hides entries older than 12 months, system entries included, without changing what they say', async () => {
    const ids = await worker()(async (tx) => {
      const [system] = await rows<{ id: string }>(
        tx,
        sql`insert into app.activities (workspace_id, kind, person_id, body, occurred_at, actor_type)
            values (${W.ws}, 'system', ${personId}, 'Lead created', now() - interval '13 months', 'system') returning id`,
      );
      return { system: system!.id };
    });
    const [note] = await as(owner)((tx) =>
      rows<{ id: string }>(
        tx,
        sql`insert into app.activities (workspace_id, kind, person_id, body, occurred_at, author_user_id)
            values (${W.ws}, 'note', ${personId}, 'Gate code 4411', now() - interval '2 years', ${owner.id}) returning id`,
      ),
    );
    const hidden = await sweep();
    expect(hidden.activities).toBe(2);
    expect(await windowOf('activities', ids.system)).toBe(false);
    expect(await windowOf('activities', note!.id)).toBe(false);
    // A system entry is still immutable in every other way.
    expect(
      (
        await expectPgError(() =>
          rows(admin$, sql`update app.activities set body = 'Edited' where id = ${ids.system}`),
        )
      ).detail,
    ).toBe('system_activity_immutable');
    // The author moves their note's time into the window: it comes back.
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.activities set occurred_at = now() - interval '2 days' where id = ${note!.id}`,
      ),
    );
    expect(await windowOf('activities', note!.id)).toBe(true);
  });
});

describe('appointments', () => {
  async function visit(tx: Tx, startsIn: string) {
    const [a] = await rows<{ id: string; sync_window: boolean }>(
      tx,
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source)
          values (${W.ws}, ${calendarId}, 1, 'Visit', now() + ${startsIn}::interval, now() + ${startsIn}::interval + interval '1 hour', 'staff')
          returning id, sync_window`,
    );
    const [seat] = await rows<{ id: string }>(
      tx,
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id) values (${W.ws}, ${a!.id}, ${personId}) returning id`,
    );
    await tx.execute(
      sql`insert into app.appointment_staff (workspace_id, appointment_id, user_id) values (${W.ws}, ${a!.id}, ${owner.id})`,
    );
    return { id: a!.id, window: a!.sync_window, seat: seat!.id };
  }
  const staffWindow = async (appointmentId: string) =>
    (
      await rows<{ w: boolean }>(
        admin$,
        sql`select sync_window as w from app.appointment_staff where appointment_id = ${appointmentId}`,
      )
    )[0]!.w;

  it('keeps 90 days back, with their attendees and staff, and brings a moved visit back at once', async () => {
    const [old, recent, future] = await worker()(async (tx) => [
      await visit(tx, '-100 days'),
      await visit(tx, '-60 days'),
      await visit(tx, '3 days'),
    ]);
    // Worked out as the visit is written: nothing for the sweep to do.
    expect([old.window, recent.window, future.window]).toEqual([false, true, true]);
    expect(await windowOf('appointment_attendees', old.seat)).toBe(false);
    expect(await staffWindow(old.id)).toBe(false);
    expect(await staffWindow(recent.id)).toBe(true);

    // Moved to next week.
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.appointments set starts_at = now() + interval '7 days', ends_at = now() + interval '7 days 1 hour' where id = ${old.id}`,
      ),
    );
    expect(await windowOf('appointments', old.id)).toBe(true);
    expect(await windowOf('appointment_attendees', old.seat)).toBe(true);
    expect(await staffWindow(old.id)).toBe(true);

    // Time passes (a visit written 60 days ago, now 91): the sweep hides it and its seats.
    await rows(
      admin$,
      sql`update app.appointments set starts_at = now() - interval '91 days', ends_at = now() - interval '91 days' + interval '1 hour' where id = ${recent.id}`,
    );
    expect(await windowOf('appointments', recent.id)).toBe(false);
    expect(await windowOf('appointment_attendees', recent.seat)).toBe(false);
    expect(await staffWindow(recent.id)).toBe(false);
  });

  it('hides visits the sweep finds past the window', async () => {
    const id = await worker()(async (tx) => (await visit(tx, '10 days')).id);
    // Written as if it had been in the window when it was saved (the flag is otherwise worked out on every write).
    await rows(
      admin$,
      sql`update app.appointments set starts_at = now() - interval '120 days', ends_at = now() - interval '120 days' + interval '1 hour'
          where id = ${id}`,
    );
    await admin$.transaction(async (tx) => {
      await tx.execute(sql`alter table app.appointments disable trigger appointments_sync_window`);
      await tx.execute(sql`update app.appointments set sync_window = true where id = ${id}`);
      await tx.execute(sql`alter table app.appointments enable trigger appointments_sync_window`);
    });
    expect(await windowOf('appointments', id)).toBe(true);
    expect((await sweep()).appointments).toBeGreaterThanOrEqual(1);
    expect(await windowOf('appointments', id)).toBe(false);
  });
});

describe('estimates and invoices', () => {
  async function paidInvoice(paidAgo: string) {
    const [inv] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.invoices (workspace_id, person_id, title, status, number, sent_at, paid_at, subtotal_cents, taxable_base_cents, total_cents)
          values (${W.ws}, ${personId}, 'Old job', 'paid', ${`W-${uniq()}`}, now() - ${paidAgo}::interval - interval '10 days',
            now() - ${paidAgo}::interval, 20000, 20000, 20000)
          returning id`,
    );
    const [line] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.invoice_lines (workspace_id, invoice_id, name, quantity, unit_price_cents, amount_cents)
          values (${W.ws}, ${inv!.id}, 'Labour', 1, 20000, 20000) returning id`,
    );
    const [payment] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.payments (workspace_id, invoice_id, amount_cents, method, status, received_at)
          values (${W.ws}, ${inv!.id}, 20000, 'cash', 'succeeded', now() - ${paidAgo}::interval) returning id`,
    );
    const [refund] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.refunds (workspace_id, payment_id, invoice_id, amount_cents, status, refunded_at)
          values (${W.ws}, ${payment!.id}, ${inv!.id}, 1000, 'succeeded', now() - ${paidAgo}::interval) returning id`,
    );
    return { id: inv!.id, line: line!.id, payment: payment!.id, refund: refund!.id };
  }

  it('hide a document 12 months after it closed, with its lines, payments and refunds, and never an open one', async () => {
    const old = await paidInvoice('13 months');
    const recent = await paidInvoice('6 months');
    const [ancientDraft] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.invoices (workspace_id, person_id, title, created_at, updated_at) values (${W.ws}, ${personId}, 'Never sent', now() - interval '3 years', now() - interval '3 years')
          returning id`,
    );
    const [voided] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.estimates (workspace_id, person_id, title, status, voided_at) values (${W.ws}, ${personId}, 'Withdrawn', 'void', now() - interval '14 months')
          returning id`,
    );
    const [sentLongAgo] = await rows<{ id: string }>(
      admin$,
      sql`insert into app.estimates (workspace_id, person_id, title, status, number, sent_at) values (${W.ws}, ${personId}, 'Still out', 'sent', ${`E-${uniq()}`}, now() - interval '2 years')
          returning id`,
    );
    const stamped = await updatedAtOf('invoices', old.id);
    const paymentStamped = await updatedAtOf('payments', old.payment);

    const hidden = await sweep();
    expect(hidden.invoices).toBe(1);
    expect(hidden.estimates).toBe(1);
    expect(await windowOf('invoices', old.id)).toBe(false);
    for (const [table, id] of [
      ['invoice_lines', old.line],
      ['payments', old.payment],
      ['refunds', old.refund],
    ] as const)
      expect(await windowOf(table, id), table).toBe(false);
    expect(await windowOf('invoices', recent.id)).toBe(true);
    expect(await windowOf('payments', recent.payment)).toBe(true);
    expect(await windowOf('invoices', ancientDraft!.id)).toBe(true);
    expect(await windowOf('estimates', voided!.id)).toBe(false);
    expect(await windowOf('estimates', sentLongAgo!.id)).toBe(true);
    expect(await updatedAtOf('invoices', old.id)).toBe(stamped);
    expect(await updatedAtOf('payments', old.payment)).toBe(paymentStamped);

    // Opening it again brings it back at once, with its lines, payments and refunds.
    await worker()((tx) =>
      tx.execute(sql`update app.invoices set status = 'sent' where id = ${old.id}`),
    );
    expect(await windowOf('invoices', old.id)).toBe(true);
    for (const [table, id] of [
      ['invoice_lines', old.line],
      ['payments', old.payment],
      ['refunds', old.refund],
    ] as const)
      expect(await windowOf(table, id), table).toBe(true);
  });
});

describe('who may sweep', () => {
  it('the worker, for the business it is scoped to, and nobody else', async () => {
    const elsewhere = await expectPgError(() =>
      asService({ workspaceId: V.ws, organizationId: V.org })((tx) =>
        rows(tx, sql`select * from private.sync_window_sweep(${W.ws}, 10)`),
      ),
    );
    expect({ code: elsewhere.code, detail: elsewhere.detail }).toEqual({
      code: '42501',
      detail: 'sync_window_scope',
    });
    const unscoped = await expectPgError(() =>
      asService({ workspaceId: null, organizationId: null })((tx) =>
        rows(tx, sql`select * from private.sync_window_sweep(${W.ws}, 10)`),
      ),
    );
    expect(unscoped.detail).toBe('sync_window_scope');
    expect(
      (
        await expectPgError(() =>
          as(owner)((tx) => rows(tx, sql`select * from private.sync_window_sweep(${W.ws}, 10)`)),
        )
      ).code,
    ).toBe('42501');
  });
});
