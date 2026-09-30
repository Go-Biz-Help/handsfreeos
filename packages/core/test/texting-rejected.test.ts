/**
 * Texting turned down, on the database (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6): a registration the
 * carriers refused opens a card quoting their reason, for the owners and admins only; it closes once the details
 * are sent again; and a refused row that isn't the business's newest opens nothing.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcile } from '../src/attention/load';
import { attentionList } from '../src/server';
import { admin, ask, setupTeam, type Team } from './calendar-helpers';

let t: Team;
let account: string;
let number: string;
let e164: string;

beforeAll(async () => {
  t = await setupTeam('texrej');
  [{ id: account }] = (await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_accounts (workspace_id, provider, account_sid, status)
        values (${t.wsId}, 'fake', ${`ACtr${randomUUID().slice(0, 8)}`}, 'active') returning id`,
  )) as [{ id: string }];
  e164 = `+1833555${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
  [{ id: number }] = (await rows<{ id: string }>(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, account_id, provider_sid, e164, number_type, status)
        values (${t.wsId}, ${account}, ${`PNtr${randomUUID().slice(0, 8)}`}, ${e164}, 'toll_free', 'active')
        returning id`,
  )) as [{ id: string }];
});
afterAll(closeTestDbs);

const registration = async (status: string, reason: string | null, createdAgo: string) => {
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.telephony_registrations
          (workspace_id, account_id, phone_number_id, kind, status, rejection_reason, submitted_at, created_at, updated_at)
        values (${t.wsId}, ${account}, ${number}, 'toll_free_verification', ${status}, ${reason},
          now() - interval '9 days', now() - ${createdAgo}::interval, now() - ${createdAgo}::interval)
        returning id`,
  );
  return r!.id;
};
const sweep = () => asWorker(testDbs().worker.db, t.scope, (tx) => reconcile(tx, t.wsId, 'all'));
const cardsFor = (id: string) =>
  rows<{ state: string; title: string; detail: string | null; resolution: string | null }>(
    admin(),
    sql`select state::text as state, title, detail, resolution from app.attention_items
        where workspace_id = ${t.wsId} and kind = 'texting_rejected' and subject_id = ${id}`,
  );

describe('texting turned down', () => {
  it('opens nothing for a refusal the business has moved past', async () => {
    const old = await registration('rejected', 'An old reason.', '20 days');
    await registration('approved', null, '10 days');
    await sweep();
    expect(await cardsFor(old)).toEqual([]);
  });

  it('quotes the carriers on a card for the owners and admins, and closes once it’s sent again', async () => {
    const id = await registration(
      'rejected',
      'The business address doesn’t match the EIN record.',
      '1 day',
    );
    await sweep();
    const [card] = await cardsFor(id);
    expect(card).toMatchObject({ state: 'open' });
    expect(card!.title).toMatch(/^The carriers turned down texting for \(833\) 555-/);
    expect(card!.detail).toContain(
      'Their reason: “The business address doesn’t match the EIN record.”',
    );

    // The owner sees it; a member, who can't set up texting, doesn't.
    const listFor = (u: Team['owner']) =>
      ask(attentionList, { workspaceId: t.wsId, scope: 'everyone' }, u).then((l) =>
        l.items.filter((i) => i.kind === 'texting_rejected').map((i) => i.subject.id),
      );
    expect(await listFor(t.owner)).toContain(id);
    expect(await listFor(t.member)).not.toContain(id);

    // Sent again: the worker records it, as it does for real.
    await asWorker(testDbs().worker.db, t.scope, (tx) =>
      rows(
        tx,
        sql`update app.telephony_registrations set status = 'submitted', rejection_reason = null
            where id = ${id}`,
      ),
    );
    await asWorker(testDbs().worker.db, t.scope, (tx) =>
      reconcile(tx, t.wsId, [{ type: 'registration', id }]),
    );
    expect(await cardsFor(id)).toEqual([
      expect.objectContaining({ state: 'resolved', resolution: 'sent_again' }),
    ]);
  });
});
