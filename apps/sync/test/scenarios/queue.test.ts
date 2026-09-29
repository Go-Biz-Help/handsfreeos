/**
 * Changes made on a phone, and what the queue does with them (the plan's "A command runs once", "Send if fresh,
 * otherwise ask" and "The queue keeps order without jamming"; verification steps 4 and 5):
 *   - a change whose answer is lost is sent again under the same id, and runs once;
 *   - a text written 45 minutes ago waits for "Still send?", the changes behind it still go, and it goes once the
 *     person says yes;
 *   - a refused new customer holds the lead that depends on it, while an unrelated note still goes;
 *   - a refused change's optimistic rows are gone at the next checkpoint, and the outbox keeps why;
 *   - with the API down for longer than the uploader retries in place, the change is set aside, the phone receives
 *     everyone else's changes meanwhile, and the change goes once it's retried.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningApi, startApi } from '../harness/api';
import { admin, type Business, canText, customer, makeBusiness } from '../harness/business';
import { eventually, Phone, sleep } from '../harness/phone';

let api: RunningApi;
let b: Business;
let mariaId: string;
let dale: Phone;

const ws = () => b.workspaceId;
const nowIso = () => new Date().toISOString();

beforeAll(async () => {
  api = await startApi();
  b = await makeBusiness(api, `queue-${randomUUID().slice(0, 6)}`);
  await canText(b);
  mariaId = await customer(b, { phone: '(713) 555-0174', email: 'maria@example.com' });
  dale = await Phone.open({ api, user: b.dale, label: 'dale' });
  await dale.keepOffline(ws());
  await dale.online();
  await dale.synced();
  await eventually('Maria on Dale’s phone', () => dale.row('people', mariaId));
});

afterAll(async () => {
  await dale?.close();
  await api?.close();
  await closeTestDbs();
});

describe('a change sent twice', () => {
  it('runs once when its answer is lost and the phone sends it again under the same id', async () => {
    const body = `Replaced the capacitor ${randomUUID().slice(0, 6)}`;
    const localId = randomUUID();
    dale.network.loseResponses = 1;
    // No phone-made id on this note, so nothing but the command's receipt can tell the second try from a new note.
    const note = await dale.change(
      'activity.log',
      { workspaceId: ws(), personId: mariaId, kind: 'note', body },
      {
        optimistic: (tx) =>
          tx.execute(
            `INSERT INTO activities (id, workspace_id, kind, person_id, body, occurred_at, created_at, updated_at)
             VALUES (?, ?, 'note', ?, ?, ?, ?, ?)`,
            [localId, ws(), mariaId, body, nowIso(), nowIso(), nowIso()],
          ),
      },
    );
    const applied = await dale.settled(note, 'applied');
    const tries = dale.sent.filter((s) => s.commandId === note);
    expect(tries.map((t) => ({ status: t.status, lost: t.lost }))).toEqual([
      { status: 200, lost: true },
      { status: 200, lost: false },
    ]);
    expect(applied.attempts).toBe(1);

    const notes = await rows<{ id: string }>(
      admin(),
      sql`select id from app.activities where workspace_id = ${ws()} and body = ${body}`,
    );
    expect(notes).toHaveLength(1);
    expect(JSON.parse(applied.answer!)).toEqual({ activityId: notes[0]!.id });
    const receipts = await rows<{ outcome: string }>(
      admin(),
      sql`select outcome::text from app.command_receipts where user_id = ${b.dale.id} and command_id = ${note}`,
    );
    expect(receipts).toEqual([{ outcome: 'applied' }]);

    // The phone ends with the one note, under the server's id, and the receipt.
    const local = await eventually('one note on the phone', async () => {
      const found = await dale.all<{ id: string }>('SELECT id FROM activities WHERE body = ?', [
        body,
      ]);
      return found.length === 1 && found[0]!.id === notes[0]!.id ? found : null;
    });
    await eventually('the receipt on the phone', () =>
      dale.db.getOptional(
        `SELECT outcome FROM command_receipts WHERE command_id = ? AND outcome = 'applied'`,
        [note],
      ),
    );
    console.log(
      `lost answer: sent twice, ran once; the phone had the server's note ${local.ms} ms later`,
    );
  });

  it('runs once when the same change arrives twice at the same moment', async () => {
    const body = `Two taps ${randomUUID().slice(0, 6)}`;
    const token = await signInTestUser(b.dale);
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-hfos-client': 'mobile',
      'x-hfos-app-version': '1.0.0',
      'x-hfos-command-id': randomUUID(),
      'x-hfos-occurred-at': nowIso(),
      'x-hfos-sent-at': nowIso(),
    };
    const send = () =>
      fetch(`${api.url}/v1/commands/activity.log`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspaceId: ws(), personId: mariaId, kind: 'note', body }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const [one, two] = await Promise.all([send(), send()]);
    expect(one).toEqual(two);
    expect(one.status).toBe(200);
    const notes = await rows(
      admin(),
      sql`select id from app.activities where workspace_id = ${ws()} and body = ${body}`,
    );
    expect(notes).toHaveLength(1);
  });
});

describe('a text written a while ago', () => {
  it('waits for "Still send?", lets the queue move on, and goes once the person says yes', async () => {
    await dale.offline();
    const clientId = randomUUID();
    const localId = randomUUID();
    const words = 'Running about 20 minutes late, sorry!';
    const writtenAt = new Date(dale.now().getTime() - 45 * 60_000);
    const text = await dale.change(
      'message.send',
      { workspaceId: ws(), personId: mariaId, body: words, clientId },
      {
        doneAt: writtenAt,
        optimistic: (tx) =>
          tx.execute(
            `INSERT INTO messages (id, workspace_id, channel, direction, status, body_text, client_id, occurred_at, created_at)
             VALUES (?, ?, 'sms', 'outbound', 'queued', ?, ?, ?, ?)`,
            [localId, ws(), words, clientId, writtenAt.toISOString(), writtenAt.toISOString()],
          ),
      },
    );
    const noteBody = `After the text ${randomUUID().slice(0, 6)}`;
    const note = await dale.change('activity.log', {
      workspaceId: ws(),
      personId: mariaId,
      kind: 'note',
      body: noteBody,
    });
    await dale.online();

    const asked = await dale.settled(text, 'ask');
    expect(JSON.parse(asked.answer!)).toMatchObject({
      error: { rule: 'stale_action', disposition: 'ask', details: { freshMinutes: 30 } },
    });
    expect(asked.reason).toContain('waits for your OK');
    // Behind it, the note still went.
    await dale.settled(note, 'applied');
    // Nothing reached the customer, and nothing was recorded against the command's id: the answer can still change.
    const unsent = await rows(
      admin(),
      sql`select id from app.messages where workspace_id = ${ws()} and client_id = ${clientId}`,
    );
    expect(unsent).toHaveLength(0);
    const noReceipt = await rows(
      admin(),
      sql`select id from app.command_receipts where user_id = ${b.dale.id} and command_id = ${text}`,
    );
    expect(noReceipt).toHaveLength(0);
    // The optimistic bubble leaves the synced messages at the next checkpoint; the app shows it from the outbox.
    const gone = await eventually(
      'the optimistic text gone',
      async () => !(await dale.row('messages', localId)),
    );

    // "Still send?" — yes.
    await dale.stillSend(text);
    const sent = await dale.settled(text, 'applied');
    const { messageId, status } = JSON.parse(sent.answer!) as { messageId: string; status: string };
    expect(status).toBe('queued');
    const arrived = await eventually('the server’s text on the phone', () =>
      dale.db.getOptional<{ id: string; status: string; body_text: string }>(
        'SELECT id, status, body_text FROM messages WHERE client_id = ?',
        [clientId],
      ),
    );
    expect(arrived.value).toEqual({ id: messageId, status: 'queued', body_text: words });
    const stored = await rows(
      admin(),
      sql`select id from app.messages where workspace_id = ${ws()} and client_id = ${clientId}`,
    );
    expect(stored).toHaveLength(1);
    console.log(
      `stale text: asked, optimistic bubble gone ${gone.ms} ms later; after yes, on the phone in ${arrived.ms} ms`,
    );
  });
});

describe('a refused change', () => {
  it('holds the lead that depends on a refused new customer, while an unrelated note still goes', async () => {
    await dale.offline();
    const newPersonId = randomUUID();
    const newLeadId = randomUUID();
    const noteId = randomUUID();
    const createCustomer = await dale.change(
      'person.create',
      {
        workspaceId: ws(),
        id: newPersonId,
        firstName: 'Bad',
        lastName: 'Email',
        email: 'not-an-email',
      },
      {
        optimistic: (tx) =>
          tx.execute(
            `INSERT INTO people (id, workspace_id, first_name, last_name, email, created_at, updated_at)
             VALUES (?, ?, 'Bad', 'Email', 'not-an-email', ?, ?)`,
            [newPersonId, ws(), nowIso(), nowIso()],
          ),
      },
    );
    const createLead = await dale.change(
      'lead.create',
      { workspaceId: ws(), id: newLeadId, personId: newPersonId, title: 'New AC for Bad Email' },
      {
        dependsOn: [createCustomer],
        optimistic: (tx) =>
          tx.execute(
            `INSERT INTO leads (id, workspace_id, person_id, title, status, created_at, updated_at)
             VALUES (?, ?, ?, 'New AC for Bad Email', 'open', ?, ?)`,
            [newLeadId, ws(), newPersonId, nowIso(), nowIso()],
          ),
      },
    );
    // A follow-up for that lead waits behind it in turn.
    const followUp = await dale.change(
      'task.create',
      { workspaceId: ws(), id: randomUUID(), title: 'Measure for the new AC', leadId: newLeadId },
      { dependsOn: [createLead] },
    );
    const note = await dale.change(
      'activity.log',
      {
        workspaceId: ws(),
        id: noteId,
        personId: mariaId,
        kind: 'note',
        body: 'Asked about a second unit',
      },
      {
        optimistic: (tx) =>
          tx.execute(
            `INSERT INTO activities (id, workspace_id, kind, person_id, body, occurred_at, created_at, updated_at)
             VALUES (?, ?, 'note', ?, 'Asked about a second unit', ?, ?, ?)`,
            [noteId, ws(), mariaId, nowIso(), nowIso(), nowIso()],
          ),
      },
    );
    await dale.online();

    const refused = await dale.settled(createCustomer, 'refused');
    expect(JSON.parse(refused.answer!)).toMatchObject({
      error: { code: 'validation', disposition: 'final' },
    });
    const held = await dale.settled(createLead, 'held');
    expect(held.reason).toBe('Waiting on person.create (refused)');
    const heldInTurn = await dale.settled(followUp, 'held');
    expect(heldInTurn.reason).toBe('Waiting on lead.create (held)');
    await dale.settled(note, 'applied');
    // Neither the lead nor its follow-up ever left the phone.
    expect(dale.sent.map((s) => s.commandId)).not.toContain(createLead);
    expect(dale.sent.map((s) => s.commandId)).not.toContain(followUp);
    expect(dale.sent.filter((s) => s.commandId === createCustomer)).toHaveLength(1);

    const [server] = await rows<{ people: number; leads: number; notes: number }>(
      admin(),
      sql`select (select count(*)::int from app.people where id = ${newPersonId}) as people,
                 (select count(*)::int from app.leads where id = ${newLeadId}) as leads,
                 (select count(*)::int from app.activities where id = ${noteId}) as notes`,
    );
    expect(server).toEqual({ people: 0, leads: 0, notes: 1 });

    // At the next checkpoint the refused customer and the held lead are gone from the synced tables; the note stays.
    const gone = await eventually(
      'the refused customer and held lead gone',
      async () => !(await dale.row('people', newPersonId)) && !(await dale.row('leads', newLeadId)),
    );
    expect(await dale.row('activities', noteId)).toMatchObject({
      body: 'Asked about a second unit',
    });
    console.log(
      `refused customer: it and its held lead left the phone ${gone.ms} ms after the refusal`,
    );
  });

  it('is gone from the phone at the next checkpoint, and its refusal stays in the outbox and the receipts', async () => {
    const lead = await b.web.dale.command<{ leadId: string; stageId: string }>('lead.create', {
      workspaceId: ws(),
      personId: mariaId,
      title: 'Duct cleaning',
    });
    const won = await eventually('the lead and a won stage on the phone', async () => {
      const row = await dale.row<{ pipeline_id: string; stage_id: string }>('leads', lead.leadId);
      if (!row) return null;
      return dale.db.getOptional<{ id: string }>(
        `SELECT id FROM pipeline_stages WHERE pipeline_id = ? AND kind = 'won'`,
        [row.pipeline_id],
      );
    });
    await dale.offline();
    const timelineId = randomUUID();
    const move = await dale.change(
      'lead.move_stage',
      { workspaceId: ws(), leadId: lead.leadId, stageId: won.value.id },
      {
        optimistic: async (tx) => {
          await tx.execute(
            `UPDATE leads SET stage_id = ?, status = 'won', won_at = ? WHERE id = ?`,
            [won.value.id, nowIso(), lead.leadId],
          );
          await tx.execute(
            `INSERT INTO activities (id, workspace_id, kind, subtype, lead_id, person_id, body, occurred_at, created_at, updated_at)
             VALUES (?, ?, 'system', 'lead_won', ?, ?, 'Won', ?, ?, ?)`,
            [timelineId, ws(), lead.leadId, mariaId, nowIso(), nowIso(), nowIso()],
          );
        },
      },
    );
    // Meanwhile, on the web, Priya archives the lead.
    await b.web.priya.command('lead.archive', { workspaceId: ws(), leadId: lead.leadId });
    expect(await dale.row('leads', lead.leadId)).toMatchObject({ status: 'won' });

    await dale.online();
    const refused = await dale.settled(move, 'refused');
    expect(JSON.parse(refused.answer!)).toMatchObject({
      error: { rule: 'lead_archived', disposition: 'final' },
    });
    expect(refused.reason).toBe('This lead is archived. Restore it, then move it.');
    const back = await eventually(
      'the lead back as the server has it, the optimistic entry gone',
      async () => {
        const row = await dale.row<{
          stage_id: string;
          status: string;
          archived_at: string | null;
        }>('leads', lead.leadId);
        return row &&
          row.stage_id === lead.stageId &&
          row.status === 'open' &&
          row.archived_at !== null &&
          !(await dale.row('activities', timelineId))
          ? row
          : null;
      },
    );
    // A final refusal is kept against the command's id, and syncs back to the phone with the reason.
    const receipt = await eventually('the refusal’s receipt on the phone', () =>
      dale.db.getOptional<{ answer: string }>(
        `SELECT answer FROM command_receipts WHERE command_id = ? AND outcome = 'refused'`,
        [move],
      ),
    );
    expect(JSON.parse(receipt.value.answer)).toMatchObject({
      status: 409,
      error: { rule: 'lead_archived' },
    });
    console.log(`refused stage move: reverted on the phone ${back.ms} ms after the refusal`);
  });
});

describe('the API out of reach', () => {
  it('retries in place, then sets the change aside so the phone keeps receiving, and sends it later', async () => {
    const outage = await Phone.open({ api, user: b.dale, label: 'outage', retryInPlaceMs: 5000 });
    try {
      await outage.keepOffline(ws());
      await outage.online();
      await outage.synced();
      outage.network.apiUnreachable = true;
      const task = await outage.change('task.create', {
        workspaceId: ws(),
        id: randomUUID(),
        title: 'Order the filter',
        personId: mariaId,
      });
      // Within the retry window, the change waits in PowerSync's queue and nothing new arrives.
      await eventually(
        'tried a few times',
        async () => outage.sent.filter((s) => s.commandId === task).length >= 3,
      );
      const whileRetrying = await customer(b, { firstName: 'Nadia', lastName: 'Webb' });
      await sleep(700);
      expect(await outage.row('people', whileRetrying)).toBeNull();
      expect(await outage.queueEmpty()).toBe(false);

      // Past it, the change is set aside: the queue empties and everyone else's changes arrive, with the API still down.
      const aside = await outage.settled(task, 'retry', 15_000);
      expect(aside.reason).toBe('The API can’t be reached');
      const arrived = await eventually('the web’s new customer on the phone', () =>
        outage.row('people', whileRetrying),
      );
      expect(await outage.queueEmpty()).toBe(true);

      // Signal to the API again: the app sends what it set aside, in order.
      outage.network.apiUnreachable = false;
      await outage.retryLater();
      await outage.settled(task, 'applied');
      const tries = outage.sent.filter((s) => s.commandId === task).length;
      console.log(
        `API outage: ${tries - 1} tries in place, then set aside; the web's customer arrived ${arrived.ms} ms after that`,
      );
    } finally {
      await outage.close();
    }
  });
});
