/**
 * What reaches a phone changes as people's access does, and as time passes (the plan's "Who sees what", "How much
 * is on the phone", verification step 7):
 *   - Marco, a member, sees a job's invoice only once he is staffed on its visit, and it arrives within seconds;
 *   - removing him from the business deletes that business's rows from his phone;
 *   - the nightly sweep turning the 12-month window over takes old messages and timeline entries off the phone,
 *     except in a conversation that's still open.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningApi, startApi } from '../harness/api';
import { admin, type Business, customer, makeBusiness } from '../harness/business';
import { eventually, Phone } from '../harness/phone';

let api: RunningApi;
let b: Business;
const phones: Phone[] = [];
const ws = () => b.workspaceId;

beforeAll(async () => {
  api = await startApi();
  b = await makeBusiness(api, `access-${randomUUID().slice(0, 6)}`);
});

afterAll(async () => {
  for (const p of phones) await p.close();
  await api?.close();
  await closeTestDbs();
});

/** Tomorrow's visit for a customer, and the invoice for it: what a booking and its bill leave in the database. */
async function visitWithInvoice(personId: string) {
  const [calendar] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.calendars (workspace_id, name, slug, status)
        values (${ws()}, 'Service visits', ${`visits-${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  );
  const [visit] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source)
        values (${ws()}, ${calendar!.id}, 1, 'AC tune-up', now() + interval '1 day', now() + interval '1 day 1 hour', 'staff')
        returning id`,
  );
  const [attendee] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
        values (${ws()}, ${visit!.id}, ${personId}) returning id`,
  );
  const [invoice] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.invoices (workspace_id, person_id, attendee_id, title, subtotal_cents, taxable_base_cents, total_cents)
        values (${ws()}, ${personId}, ${attendee!.id}, 'AC tune-up', 18900, 18900, 18900) returning id`,
  );
  await rows(
    admin(),
    sql`insert into app.invoice_lines (workspace_id, invoice_id, name, quantity, unit_price_cents, amount_cents)
        values (${ws()}, ${invoice!.id}, 'Tune-up', 1, 18900, 18900)`,
  );
  return { visitId: visit!.id, invoiceId: invoice!.id };
}

describe('a member’s access', () => {
  it('brings a job’s invoice to him within seconds of being staffed on it, and removal deletes the business', async () => {
    const mariaId = await customer(b, { phone: '(713) 555-0174' });
    const { visitId, invoiceId } = await visitWithInvoice(mariaId);
    const marco = await Phone.open({ api, user: b.marco, label: 'marco' });
    phones.push(marco);
    await marco.keepOffline(ws());
    await marco.online();
    await marco.synced();
    await eventually('the business on Marco’s phone', () => marco.row('people', mariaId));
    // A member doesn't see money for jobs he isn't on.
    expect(await marco.row('invoices', invoiceId)).toBeNull();

    // Dale puts him on the visit, on the web.
    const staffed = Date.now();
    await b.web.dale.command('appointment.reassign', {
      workspaceId: ws(),
      appointmentId: visitId,
      userIds: [b.marco.id],
      acknowledgeWarnings: true,
      notify: false,
    });
    const invoice = await eventually(
      'the invoice on Marco’s phone',
      () => marco.row<{ total_cents: number }>('invoices', invoiceId),
      10_000,
    );
    const lines = await eventually('its line', async () => {
      const found = await marco.all('SELECT id FROM invoice_lines WHERE invoice_id = ?', [
        invoiceId,
      ]);
      return found.length === 1 ? found : null;
    });
    expect(invoice.value.total_cents).toBe(18900);
    const seconds = (Date.now() - staffed) / 1000;
    expect(seconds).toBeLessThan(5);

    // Dale removes him from the business: everything of it leaves his phone.
    const counts = () =>
      marco.db.get<{ n: number }>(
        `SELECT (SELECT count(*) FROM people WHERE workspace_id = ?) + (SELECT count(*) FROM invoices WHERE workspace_id = ?)
           + (SELECT count(*) FROM invoice_lines WHERE workspace_id = ?) + (SELECT count(*) FROM workspaces WHERE id = ?)
           + (SELECT count(*) FROM workspace_access WHERE workspace_id = ?)
           + (SELECT count(*) FROM workspace_memberships WHERE workspace_id = ?) AS n`,
        [ws(), ws(), ws(), ws(), ws(), ws()],
      );
    expect((await counts()).n).toBeGreaterThan(4);
    const removed = Date.now();
    await b.web.dale.command('membership.remove', { workspaceId: ws(), userId: b.marco.id });
    const wiped = await eventually(
      'the business gone from Marco’s phone',
      async () => (await counts()).n === 0,
      10_000,
    );
    console.log(
      `staffed: invoice on the phone ${invoice.ms} ms after the command returned (line ${lines.ms} ms), ${seconds.toFixed(2)} s in all; ` +
        `removed: business gone ${wiped.ms} ms after, ${((Date.now() - removed) / 1000).toFixed(2)} s in all`,
    );
  });
});

describe('the 12-month window', () => {
  it('turning over takes old messages and timeline entries off the phone, but not an open conversation’s', async () => {
    const personId = await customer(b, {
      firstName: 'Old',
      lastName: 'Timer',
      phone: '(713) 555-0110',
    });
    const conversation = async (status: 'open' | 'closed', counterpart: string) => {
      const [c] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, status)
            values (${ws()}, 'sms', ${counterpart}, ${personId}, ${status}) returning id`,
      );
      return c!.id;
    };
    const message = async (conversationId: string, body: string, age: string) => {
      const [m] = await rows<{ id: string }>(
        admin(),
        sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, to_addresses, occurred_at)
            values (${ws()}, ${conversationId}, 'sms', 'inbound', 'received', ${body}, array['+18335550100'],
              now() - ${age}::interval) returning id`,
      );
      return m!.id;
    };
    const closed = await conversation('closed', '+17135550110');
    const open = await conversation('open', '+17135550111');
    const oldText = await message(closed, 'Can you come look at the furnace?', '13 months');
    const recentText = await message(closed, 'Thanks, all working now', '2 weeks');
    const oldButOpen = await message(open, 'Still waiting on that quote', '14 months');
    const [oldEntry] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.activities (workspace_id, kind, person_id, body, occurred_at)
          values (${ws()}, 'note', ${personId}, 'Replaced the blower motor', now() - interval '13 months') returning id`,
    );

    const dale = await Phone.open({ api, user: b.dale, label: 'dale' });
    phones.push(dale);
    await dale.keepOffline(ws());
    await dale.online();
    await dale.synced();
    for (const id of [oldText, recentText, oldButOpen])
      await eventually(`message ${id} on the phone`, () => dale.row('messages', id));
    await eventually('the old note on the phone', () => dale.row('activities', oldEntry!.id));

    // The worker's nightly sweep for this business (apps/worker/src/housekeeping/sync-window.ts).
    const swept = await asWorker(
      testDbs().worker.db,
      { workspaceId: ws(), organizationId: b.organizationId },
      (tx) =>
        rows<{ table_name: string; hidden: number }>(
          tx,
          sql`select table_name, hidden from private.sync_window_sweep(${ws()}, 2000)`,
        ),
    );
    expect(Object.fromEntries(swept.map((r) => [r.table_name, r.hidden]))).toMatchObject({
      messages: 1,
      activities: 1,
    });
    const gone = await eventually(
      'the old text and note off the phone',
      async () =>
        !(await dale.row('messages', oldText)) && !(await dale.row('activities', oldEntry!.id)),
    );
    expect(await dale.row('messages', recentText)).not.toBeNull();
    expect(await dale.row('messages', oldButOpen)).not.toBeNull();
    console.log(`window: old text and note left the phone ${gone.ms} ms after the sweep`);
  });
});
