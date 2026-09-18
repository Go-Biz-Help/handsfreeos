import { zonedParts } from '@hfos/core';
import * as Crypto from 'expo-crypto';
import { router } from 'expo-router';

import { appVersion, setBelowMinimumVersion } from '@/lib/app-version';
import { session } from '@/lib/auth';
import { config, testToolsEnabled } from '@/lib/config';
import { appFetch } from '@/lib/network';

import { changes, newId } from './index';
import { setFixer } from './fixers';
import { keepLargeTestFile, takePhoto, type PhotoSource } from './photo-device';
import { appHeaders } from './send';

/**
 * Test builds only, until the screens exist (steps 13–17): the changes the screens will make, made from Settings → Test
 * changes on one customer, and the pretending the on-device checks need. Every change goes through `change()`, as the
 * screens' will.
 */

export interface Customer {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly phone: string | null;
  readonly phone_e164: string | null;
  readonly email: string | null;
}

const nowIso = () => new Date().toISOString();

function db() {
  const open = changes.open;
  if (!open) throw new Error('This phone’s copy isn’t open.');
  return open.db;
}

/** The customer the test changes are made for: Maria Lopez, or the business's first customer. */
export async function testCustomer(workspaceId: string): Promise<Customer | null> {
  return db().getOptional<Customer>(
    `SELECT id, first_name, last_name, phone, phone_e164, email FROM people
     WHERE workspace_id = ? AND archived_at IS NULL
     ORDER BY CASE WHEN first_name = 'Maria' AND last_name = 'Lopez' THEN 0 ELSE 1 END, created_at
     LIMIT 1`,
    [workspaceId],
  );
}

/** Add a note to a customer. */
export function addNote(
  workspaceId: string,
  personId: string,
  body: string,
  dependsOn: string[] = [],
) {
  const id = newId();
  const at = nowIso();
  return changes.change(
    'activity.log',
    { workspaceId, id, personId, kind: 'note', body },
    {
      dependsOn,
      optimistic: (tx) =>
        tx.execute(
          `INSERT INTO activities (id, workspace_id, kind, person_id, body, occurred_at, created_at, updated_at)
           VALUES (?, ?, 'note', ?, ?, ?, ?, ?)`,
          [id, workspaceId, personId, body, at, at, at],
        ),
    },
  );
}

/** Change a customer's phone and email: only those two details, with what the phone showed. */
export function changePhoneAndEmail(workspaceId: string, customer: Customer) {
  const n = String(Math.floor(Math.random() * 90) + 10);
  const phone = `(713) 555-01${n}`;
  const email = `maria.lopez+${n}@example.com`;
  return changes.change(
    'person.update',
    {
      workspaceId,
      personId: customer.id,
      phone,
      email,
      base: { phone: customer.phone_e164 ?? customer.phone, email: customer.email },
    },
    {
      optimistic: (tx) =>
        tx.execute('UPDATE people SET phone = ?, email = ?, updated_at = ? WHERE id = ?', [
          phone,
          email,
          nowIso(),
          customer.id,
        ]),
    },
  );
}

/** Create a customer and a lead for them: the lead waits for the customer. */
export async function newCustomerAndLead(workspaceId: string, email: string) {
  const personId = newId();
  const leadId = newId();
  const at = nowIso();
  const person = await changes.change(
    'person.create',
    {
      workspaceId,
      id: personId,
      firstName: 'Rosa',
      lastName: 'Delgado',
      phone: '(713) 555-0156',
      email,
      address: { line1: '1406 Oak Hollow Dr', city: 'Houston', state: 'TX', postalCode: '77006' },
    },
    {
      optimistic: (tx) =>
        tx.execute(
          `INSERT INTO people (id, workspace_id, first_name, last_name, phone, email, created_at, updated_at)
           VALUES (?, ?, 'Rosa', 'Delgado', '(713) 555-0156', ?, ?, ?)`,
          [personId, workspaceId, email, at, at],
        ),
    },
  );
  const lead = await changes.change(
    'lead.create',
    { workspaceId, id: leadId, personId, title: 'AC tune-up' },
    {
      dependsOn: [person.id],
      optimistic: (tx) =>
        tx.execute(
          `INSERT INTO leads (id, workspace_id, person_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, 'AC tune-up', 'open', ?, ?)`,
          [leadId, workspaceId, personId, at, at],
        ),
    },
  );
  return { person, lead };
}

/**
 * Give the customer another open lead, so a flow that moves one to Won can run again on a database it has already
 * run against. The seed's own open lead is used up the first time `moveLeadToWon` is pressed and nothing puts it
 * back, which is what made `changes-offline.yaml` pass once per seed and fail ever after.
 *
 * Press it with signal: the lead's pipeline and its stages are the server's to decide, and `moveLeadToWon` needs
 * them, so the change has to have gone before the lead can be moved.
 */
export async function addLeadFor(workspaceId: string, personId: string) {
  const leadId = newId();
  const at = nowIso();
  return changes.change(
    'lead.create',
    { workspaceId, id: leadId, personId, title: 'AC tune-up' },
    {
      optimistic: (tx) =>
        tx.execute(
          `INSERT INTO leads (id, workspace_id, person_id, title, status, created_at, updated_at)
           VALUES (?, ?, ?, 'AC tune-up', 'open', ?, ?)`,
          [leadId, workspaceId, personId, at, at],
        ),
    },
  );
}

/** Move the customer's first open lead to its pipeline's won stage. */
export async function moveLeadToWon(workspaceId: string, personId: string) {
  const lead = await db().getOptional<{ id: string; pipeline_id: string }>(
    `SELECT id, pipeline_id FROM leads WHERE workspace_id = ? AND person_id = ? AND status = 'open' AND archived_at IS NULL
     ORDER BY created_at LIMIT 1`,
    [workspaceId, personId],
  );
  if (!lead) throw new Error('This customer has no open lead to move.');
  const won = await db().getOptional<{ id: string }>(
    `SELECT id FROM pipeline_stages WHERE pipeline_id = ? AND kind = 'won' LIMIT 1`,
    [lead.pipeline_id],
  );
  if (!won) throw new Error('This pipeline has no Won stage.');
  return changes.change(
    'lead.move_stage',
    { workspaceId, leadId: lead.id, stageId: won.id },
    {
      optimistic: (tx) =>
        tx.execute(`UPDATE leads SET stage_id = ?, status = 'won', won_at = ? WHERE id = ?`, [
          won.id,
          nowIso(),
          lead.id,
        ]),
    },
  );
}

/** Text a customer. */
export async function textCustomer(workspaceId: string, personId: string, body: string) {
  const clientId = newId();
  const conversation = await db().getOptional<{ id: string }>(
    `SELECT id FROM conversations WHERE workspace_id = ? AND person_id = ? AND channel = 'sms' LIMIT 1`,
    [workspaceId, personId],
  );
  const at = nowIso();
  return changes.change(
    'message.send',
    { workspaceId, personId, body, clientId },
    {
      optimistic: conversation
        ? (tx) =>
            tx.execute(
              `INSERT INTO messages (id, workspace_id, conversation_id, channel, direction, status, body_text, client_id,
                 occurred_at, created_at, updated_at)
               VALUES (?, ?, ?, 'sms', 'outbound', 'queued', ?, ?, ?, ?, ?)`,
              [newId(), workspaceId, conversation.id, body, clientId, at, at, at],
            )
        : undefined,
    },
  );
}

/**
 * Bytes that don't compress, for the large test file, as fast as Hermes can make them: xorshift from the clock, not
 * for secrets (expo-crypto gives at most 1,024 random bytes a call).
 */
function noise(): (count: number) => Uint8Array {
  let state = (Date.now() % 0xffffffff) | 1;
  return (count) => {
    const words = new Uint32Array(Math.ceil(count / 4));
    for (let i = 0; i < words.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      words[i] = state >>> 0;
    }
    return new Uint8Array(words.buffer).slice(0, count);
  };
}

/** Add a photo to a customer (taken, picked, or a large test file), with a note that waits for it. */
export async function addPhotoTo(
  workspaceId: string,
  personId: string,
  source: PhotoSource | 'large',
  withNote: boolean,
): Promise<string | null> {
  const open = changes.open;
  if (!open) throw new Error('This phone’s copy isn’t open.');
  const fileId = newId();
  let kept: { localName: string; sizeBytes: number };
  if (source === 'large') {
    kept = keepLargeTestFile({
      userId: open.userId,
      fileId,
      sizeBytes: 13_000_000,
      randomBytes: noise(),
    });
  } else {
    const taken = await takePhoto({ userId: open.userId, source, fileId });
    if (taken.kind === 'cancelled') return null;
    if (taken.kind === 'no-camera-permission')
      throw new Error('Allow HandsFreeOS to use the camera in Settings to take photos.');
    kept = taken.photo;
  }
  const photo = await changes.addPhoto(
    { workspaceId, recordType: 'person', recordId: personId },
    kept,
    { fileId },
  );
  if (withNote) await addNote(workspaceId, personId, 'Photo of the old unit', [photo.id]);
  return photo.id;
}

/**
 * Clears this phone's list of changes: discards every change that hasn't gone, and forgets the ones that went (a flow
 * that stopped halfway on a local phone leaves both behind). Returns how many changes it cleared.
 */
export async function clearEveryChange(): Promise<number> {
  const rows = await db().getAll<{ id: string; state: string }>('SELECT id, state FROM outbox');
  await changes.discard(rows.filter((r) => r.state !== 'sent').map((r) => r.id));
  await db().execute(`DELETE FROM outbox WHERE state = 'sent'`);
  await changes.refresh();
  return rows.length;
}

/** Make the newest change still waiting look 45 minutes old. */
export async function ageNewestChange(minutes = 45): Promise<string | null> {
  const row = await db().getOptional<{ id: string; made_at: string }>(
    `SELECT id, made_at FROM outbox WHERE track = 'queue' AND state != 'sent' ORDER BY seq DESC LIMIT 1`,
  );
  if (!row) return null;
  const aged = new Date(Date.parse(row.made_at) - minutes * 60_000).toISOString();
  await db().execute('UPDATE outbox SET made_at = ? WHERE id = ?', [aged, row.id]);
  await changes.refresh();
  return row.id;
}

/** Pretend to be a build below the API's minimum; going back sends what waited. */
export async function setOldVersion(old: boolean): Promise<void> {
  setBelowMinimumVersion(old);
  if (!old) await changes.retryNow();
}

/**
 * The business's quiet hours on HandsFreeOS itself, so a flow can text at any hour or ask about quiet hours: an
 * online-only settings command, sent as the app sends one (not a change the phone's contract has).
 */
export async function setQuietHours(
  workspaceId: string,
  enabled: boolean,
  window: { readonly start: string; readonly end: string } = { start: '20:00', end: '08:00' },
): Promise<void> {
  const token = await session.accessToken();
  const now = nowIso();
  const response = await appFetch(`${config.apiUrl}/v1/commands/phone.update_settings`, {
    method: 'POST',
    headers: appHeaders(
      { appVersion, now: Date.now },
      { commandId: Crypto.randomUUID(), madeAt: now, confirmedAt: null },
      token,
    ),
    body: JSON.stringify({ workspaceId, quietHours: { enabled, ...window } }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `HandsFreeOS answered ${response.status}.`);
  }
}

/** The screens the test changes reopen: fixing a new customer, and editing a text. */
export function registerTestFixers(): void {
  if (!testToolsEnabled) return;
  setFixer('person.create', (row) =>
    router.push(`/app/w/${row.workspace_id}/test-changes/fix/${row.id}`),
  );
  setFixer('message.send', (row) =>
    router.push(`/app/w/${row.workspace_id}/test-changes/text/${row.id}`),
  );
}

/**
 * Quiet hours that have already begun where the business is and end at 8:00 AM (9:00 AM between 8 and 9), so a text
 * sent now really waits for the morning on HandsFreeOS too, whatever the hour a flow runs at (step 14's held texts).
 */
export function quietWindowCoveringNow(
  timeZone: string,
  now = new Date(),
): { readonly start: string; readonly end: string } {
  const hour = zonedParts(now, timeZone).hour;
  const two = (n: number) => String(n).padStart(2, '0');
  return { start: `${two(hour)}:00`, end: hour === 8 ? '09:00' : '08:00' };
}
