/**
 * Real Estate Agent's duties and documents (step 9), on the database, following the specification's acceptance
 * scenarios (§22): a human-only duty finished only with a person's own word; a verbal "done" that can't close a
 * repair needing its invoice, and the exception that can, with its reason kept; a blocked item whose due date stays;
 * a signed contract locked for good and replaced only by a newer version; an amendment's signed source on its dates;
 * a changed wire held until a phone check; and a duty written on one deal.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  fileDelete,
  type CommandDef,
  type HumanActor,
  type QueryDef,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = (channel: 'test' | 'assistant' = 'test') => ({
  correlationId: randomUUID(),
  channel,
});
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const op = (name: string) =>
  [...realestateAddonServer.commands!, ...realestateAddonServer.queries!].find(
    (x) => x.name === name,
  )!;
const run = (
  who: TestUser,
  name: string,
  input: Record<string, unknown>,
  channel: 'test' | 'assistant' = 'test',
): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(who),
    meta(channel),
  ).then((r) => r.output);
const ask = (who: TestUser, name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(who), meta());
async function refused(p: Promise<unknown>): Promise<{ rule: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { rule?: string; code?: string; message: string };
    return { rule: err.rule ?? err.code ?? '', message: err.message };
  }
  throw new Error('It was allowed.');
}

let owner: TestUser;
let agent: TestUser;
let other: TestUser;
let ws: string;

const open = (input: Record<string, unknown>) =>
  run(agent, 'realestate.deal.open', input).then((o) => o.dealId as string);
const dutyId = async (dealId: string, key: string, pass = 1) => {
  const [d] = await rows<{ id: string }>(
    admin(),
    sql`select id from addon_realestate.duties
        where deal_record_id = ${dealId} and duty_key = ${key} and pass = ${pass}`,
  );
  if (!d) throw new Error(`no ${key} on the deal`);
  return d.id;
};
const statusOf = async (id: string) =>
  (
    await rows<{ status: string; exception: boolean; due_at: string | null }>(
      admin(),
      sql`select status, exception, due_at::text from addon_realestate.duties where id = ${id}`,
    )
  )[0]!;
/** A file on the deal, uploaded. */
async function fileOn(dealId: string, name: string) {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: dealId,
      name,
      mimeType: 'application/pdf',
      sizeBytes: 2048,
    },
    human(agent),
    meta(),
  );
  // As the uploader: only they confirm it (core's own rule).
  await asUser(api(), agent.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  return up.output.fileId;
}

beforeAll(async () => {
  [owner, agent, other] = await Promise.all([
    createTestUser('rdu-owner'),
    createTestUser('rdu-agent'),
    createTestUser('rdu-other'),
  ]);
  ws = await realestateBusiness(owner, 'Harbor Realty');
  await admin()
    .insert(workspaceMemberships)
    .values(
      [agent, other].map((u) => ({ workspaceId: ws, userId: u.id, role: 'member' as const })),
    );
}, 90_000);

afterAll(closeTestDbs);

describe('A human-only duty', () => {
  it('is finished only with its proof, and only a person gives their word', async () => {
    const deal = await open({ side: 'buyer', name: 'Inlet purchase', stage: 'under_contract' });
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'acceptance',
      date: '2026-10-05',
    });
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'inspection_end',
      date: '2026-10-15',
    });
    const attend = await dutyId(deal, 'B-20'); // Attend inspection
    const first = await refused(run(agent, 'realestate.duty.complete', { dutyId: attend }));
    expect(first.rule).toBe('duty_needs_proof');
    expect(first.message).toContain(
      'your word that “I was at the inspection” or a note of what was done',
    );
    // The Assistant never says it was there.
    expect(
      (
        await refused(
          run(
            agent,
            'realestate.duty.add_evidence',
            { dutyId: attend, kind: 'attestation', body: 'I was at the inspection' },
            'assistant',
          ),
        )
      ).rule,
    ).toBe('realestate_attest_in_person');
    const added = await run(agent, 'realestate.duty.add_evidence', {
      dutyId: attend,
      kind: 'attestation',
      body: 'I was at the inspection',
    });
    expect(added.missing).toBe('');
    await run(agent, 'realestate.duty.complete', { dutyId: attend });
    const got = await ask(agent, 'realestate.duty.get', { dutyId: attend });
    expect(got.duty).toMatchObject({ status: 'completed', exception: false });
    expect(got.log.map((l: Any) => [l.what, l.actorType])).toEqual(
      expect.arrayContaining([
        ['completed', 'person'],
        ['evidence_added', 'person'],
        ['created', 'person'],
      ]),
    );
    expect(got.proof.attestations).toEqual(['I was at the inspection']);
  });
});

describe('The evidence rule', () => {
  it('won’t let a verbal “done” close a repair, and keeps the exception an owner makes', async () => {
    const deal = await open({ side: 'buyer', name: 'Cove purchase', stage: 'under_contract' });
    await run(agent, 'realestate.term.enter', { dealId: deal, key: 'closing', date: '2026-11-20' });
    await run(agent, 'realestate.deal.record_event', { dealId: deal, event: 'repairs_agreed' });
    const repair = await dutyId(deal, 'X-23'); // Repair completion verification
    await run(agent, 'realestate.duty.add_evidence', {
      dutyId: repair,
      kind: 'note',
      body: 'Seller says done',
    });
    const no = await refused(run(agent, 'realestate.duty.complete', { dutyId: repair }));
    expect(no.rule).toBe('duty_needs_proof');
    expect(no.message).toContain('an Invoice, Photo or Permit');
    // Only owners and admins make an exception, and never without a reason.
    expect(
      (
        await refused(
          run(agent, 'realestate.duty.complete_with_exception', { dutyId: repair, reason: 'x' }),
        )
      ).rule,
    ).toBe('forbidden');
    expect(
      (
        await refused(
          run(owner, 'realestate.duty.complete_with_exception', { dutyId: repair, reason: ' ' }),
        )
      ).rule,
    ).toBe('validation');
    await run(owner, 'realestate.duty.complete_with_exception', {
      dutyId: repair,
      reason: 'Seller’s contractor closed; the buyer saw the work at walkthrough.',
    });
    expect(await statusOf(repair)).toMatchObject({ status: 'completed', exception: true });
    const [audit] = await rows<{ actor_id: string; after: Any }>(
      admin(),
      sql`select actor_id, after from app.audit_logs
          where workspace_id = ${ws} and action = 'realestate.duty.complete_with_exception'
          order by created_at desc limit 1`,
    );
    expect(audit).toMatchObject({ actor_id: owner.id, after: { exception: true } });
    // Reopening puts it back to work, exception gone.
    await run(agent, 'realestate.duty.reopen', { dutyId: repair, reason: 'Buyer found a leak' });
    expect(await statusOf(repair)).toMatchObject({ status: 'in_progress', exception: false });
  });
});

describe('A blocked item', () => {
  it('says what’s in the way and whose it is, and its due date stays', async () => {
    const deal = await open({ side: 'buyer', name: 'Bay purchase', stage: 'under_contract' });
    await run(agent, 'realestate.term.enter', { dealId: deal, key: 'closing', date: '2026-11-20' });
    const walk = await dutyId(deal, 'X-24');
    const before = (await statusOf(walk)).due_at;
    expect(
      (await refused(run(agent, 'realestate.duty.set_status', { dutyId: walk, status: 'blocked' })))
        .rule,
    ).toBe('validation');
    await run(agent, 'realestate.duty.set_status', {
      dutyId: walk,
      status: 'blocked',
      blocker: {
        what: 'Roofer hasn’t finished',
        owner: 'Seller’s roofer',
        impact: 'Walkthrough can’t be booked',
        reviewAt: '2026-11-10T15:00:00Z',
      },
    });
    expect(await statusOf(walk)).toMatchObject({ status: 'blocked', due_at: before });
    const got = await ask(agent, 'realestate.duty.get', { dutyId: walk });
    expect(got.duty.blocker).toMatchObject({
      what: 'Roofer hasn’t finished',
      owner: 'Seller’s roofer',
    });
    await run(agent, 'realestate.duty.set_status', {
      dutyId: walk,
      status: 'waiting_external',
      waitingOn: 'The roofer',
    });
    expect((await ask(agent, 'realestate.duty.get', { dutyId: walk })).duty).toMatchObject({
      status: 'waiting_external',
      waitingOn: 'The roofer',
      blocker: null,
    });
  });

  it('keeps drafts from being finished until they’re started', async () => {
    const deal = await open({ side: 'buyer', name: 'Pier purchase', stage: 'under_contract' });
    const draft = await dutyId(deal, 'X-03');
    expect((await refused(run(agent, 'realestate.duty.complete', { dutyId: draft }))).rule).toBe(
      'realestate_duty_move',
    );
  });
});

describe('Documents', () => {
  it('lock a signed contract for good, and count the newest signed version', async () => {
    const deal = await open({ side: 'buyer', name: 'Dune purchase', stage: 'under_contract' });
    const ratify = await dutyId(deal, 'B-17'); // signed contract, and acceptance confirmed
    const file1 = await fileOn(deal, 'contract.pdf');
    const v1 = await run(agent, 'realestate.document.add', {
      dealId: deal,
      fileId: file1,
      kind: 'contract',
    });
    expect(v1).toMatchObject({ version: 1, status: 'draft', controlling: false });
    await run(agent, 'realestate.duty.add_evidence', {
      dutyId: ratify,
      kind: 'document',
      documentId: v1.documentId,
    });
    const before = await refused(run(agent, 'realestate.duty.complete', { dutyId: ratify }));
    expect(before.message).toContain('a signed Purchase contract and contract accepted confirmed');
    const signed = await run(agent, 'realestate.document.mark_signed', {
      documentId: v1.documentId,
    });
    expect(signed).toMatchObject({ status: 'signed', controlling: true });
    // Its file is kept: nobody deletes it.
    expect(
      (
        await refused(
          executeCommand(
            api(),
            fileDelete,
            { workspaceId: ws, fileId: file1 },
            human(owner),
            meta(),
          ),
        )
      ).rule,
    ).toBe('file_locked');
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'acceptance',
      date: '2026-10-01',
    });
    await run(agent, 'realestate.duty.complete', { dutyId: ratify });
    // A counter-signed correction is a newer version; it counts once signed.
    const v2 = await run(agent, 'realestate.document.add', {
      dealId: deal,
      fileId: await fileOn(deal, 'contract-v2.pdf'),
      kind: 'contract',
      supersedesId: v1.documentId,
    });
    expect(v2.version).toBe(2);
    expect(
      (
        await refused(
          run(agent, 'realestate.document.add', {
            dealId: deal,
            fileId: await fileOn(deal, 'contract-v2b.pdf'),
            kind: 'contract',
            supersedesId: v1.documentId,
          }),
        )
      ).rule,
    ).toBe('realestate_document_not_latest');
    await run(agent, 'realestate.document.mark_signed', { documentId: v2.documentId });
    const docs = (await ask(agent, 'realestate.document.list', { dealId: deal })).documents;
    expect(docs.map((d: Any) => [d.version, d.status, d.controlling, d.locked])).toEqual([
      [2, 'signed', true, true],
      [1, 'superseded', false, true],
    ]);
    // Voided, it stays on the deal, locked, and no longer counts.
    const gone = await run(agent, 'realestate.document.void', {
      documentId: v2.documentId,
      reason: 'The contract was released',
    });
    expect(gone).toMatchObject({ status: 'void', controlling: false });
  });

  it('show the signed source of an amended date', async () => {
    const deal = await open({ side: 'listing', name: 'Reef listing', stage: 'under_contract' });
    const first = await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'closing',
      date: '2026-11-20',
    });
    const file = await fileOn(deal, 'extension.pdf');
    const amendment = await run(agent, 'realestate.document.add', {
      dealId: deal,
      fileId: file,
      kind: 'amendment',
    });
    await run(agent, 'realestate.document.mark_signed', { documentId: amendment.documentId });
    await run(agent, 'realestate.term.enter', {
      dealId: deal,
      key: 'closing',
      date: '2026-12-04',
      source: 'amendment',
      sourceRef: '§2',
      documentId: amendment.documentId,
      replaces: first.entryId,
    });
    const history = (await ask(agent, 'realestate.term.history', { dealId: deal, key: 'closing' }))
      .entries;
    expect(history.map((e: Any) => [e.date, e.live, e.source, e.documentId])).toEqual([
      ['2026-12-04', true, 'amendment', amendment.documentId],
      ['2026-11-20', false, 'typed', null],
    ]);
  });
});

describe('A changed wire', () => {
  it('holds the deal until a person checks by phone', async () => {
    const deal = await open({ side: 'buyer', name: 'Tide purchase', stage: 'closing' });
    const out = await run(agent, 'realestate.deal.report_wire_change', {
      dealId: deal,
      how: 'email',
      from: 'Someone claiming to be the title company',
    });
    expect(await statusOf(out.dutyId)).toMatchObject({ status: 'not_started' });
    const again = await run(agent, 'realestate.deal.report_wire_change', {
      dealId: deal,
      how: 'text',
    });
    expect(again.dutyId).toBe(out.dutyId);
    const got = await ask(agent, 'realestate.duty.get', { dutyId: out.dutyId });
    expect(got.duty).toMatchObject({ key: 'W-00', materiality: 'critical', automation: 'AX' });
    expect(got.proof.missing).toContain('your word that');
    await run(agent, 'realestate.duty.add_evidence', {
      dutyId: out.dutyId,
      kind: 'attestation',
      body: got.proof.attestations[0],
    });
    await run(agent, 'realestate.duty.add_evidence', {
      dutyId: out.dutyId,
      kind: 'note',
      body: 'Called Lakeside Title at the number on their website; instructions unchanged. The email was fake.',
    });
    await run(agent, 'realestate.duty.complete', { dutyId: out.dutyId });
    const [event] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${ws} and event_type = 'realestate.deal.wire_change_reported'
            and payload ->> 'dutyId' = ${out.dutyId}`,
    );
    expect(event!.n).toBe(2);
  });
});

describe('A duty written on one deal', () => {
  it('is due when set, answered for by someone on the deal, and its due can be set by hand', async () => {
    const deal = await open({ side: 'listing', name: 'Harbor listing', stage: 'active' });
    expect(
      (
        await refused(
          run(agent, 'realestate.duty.add', {
            dealId: deal,
            title: 'Stage the porch',
            accountableUserId: other.id,
          }),
        )
      ).rule,
    ).toBe('realestate_not_on_deal');
    const added = await run(agent, 'realestate.duty.add', {
      dealId: deal,
      title: 'Stage the porch',
      proof: 'file',
      dueDate: '2026-10-20',
    });
    const got = await ask(agent, 'realestate.duty.get', { dutyId: added.dutyId });
    expect(got.duty).toMatchObject({
      key: 'W-01',
      dueDate: '2026-10-20',
      dueTime: '23:59',
      accountable: expect.objectContaining({ userId: agent.id }),
    });
    expect(got.duty.dueSetByHand).not.toBeNull();
    await run(agent, 'realestate.duty.set_due', {
      dutyId: added.dutyId,
      date: '2026-10-24',
      time: '17:00',
      reason: 'Stager moved to Saturday',
    });
    const moved = (await ask(agent, 'realestate.duty.get', { dutyId: added.dutyId })).duty;
    expect(moved).toMatchObject({ dueDate: '2026-10-24', dueTime: '17:00' });
    // A Saturday deadline keeps its date and says so.
    expect(moved.warnings).toEqual([expect.objectContaining({ code: 'not_a_business_day' })]);
    const second = await run(agent, 'realestate.duty.add', {
      dealId: deal,
      title: 'Order sign rider',
    });
    expect((await ask(agent, 'realestate.duty.get', { dutyId: second.dutyId })).duty.key).toBe(
      'W-02',
    );
    const mine = await ask(agent, 'realestate.duty.list', { mine: true, dealId: deal });
    expect(mine.duties.map((d: Any) => d.key)).toEqual(expect.arrayContaining(['W-01', 'W-02']));
    const view = await ask(agent, 'realestate.deal.get', { dealId: deal });
    expect(view.duties.find((d: Any) => d.key === 'W-01').proofMissing).toBe('a file');
  });

  it('is someone else’s only if they’re on the deal, and waiving takes an owner', async () => {
    const deal = await open({ side: 'buyer', name: 'Quay purchase' });
    const d = await dutyId(deal, 'B-31');
    expect(
      (await refused(run(agent, 'realestate.duty.assign', { dutyId: d, userId: other.id }))).rule,
    ).toBe('realestate_not_on_deal');
    await run(agent, 'realestate.duty.assign', { dutyId: d, userId: null });
    expect((await ask(agent, 'realestate.duty.get', { dutyId: d })).duty.accountable).toBeNull();
    expect(
      (await refused(run(agent, 'realestate.duty.waive', { dutyId: d, reason: 'Not needed' })))
        .rule,
    ).toBe('forbidden');
    await run(owner, 'realestate.duty.waive', {
      dutyId: d,
      reason: 'Client came through a referral',
    });
    expect(await statusOf(d)).toMatchObject({ status: 'waived' });
    expect(
      (
        await refused(
          run(agent, 'realestate.duty.set_status', { dutyId: d, status: 'in_progress' }),
        )
      ).rule,
    ).toBe('realestate_duty_finished');
  });
});
