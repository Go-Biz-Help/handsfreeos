/**
 * Real Estate Agent, round six, steps 8 and 9: what an agent notes in the field, and the final walkthrough. A note
 * made on the phone keeps its own id, so sending it again is the same note; a recording's words arrive from the
 * worker. The walkthrough's list comes from the repairs the seller agreed to, what the contract says stays and goes,
 * the inspection's findings nobody asked to fix, and each room; checking works item by item, and finishing turns
 * what isn't right into duties before closing.
 */
import { randomUUID } from 'node:crypto';
import { asUser, rows, sql } from '@hfos/db/client';
import { workspaceMemberships } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realestateAddonServer } from '../../src/addons/realestate/server';
import { walkthroughItems, walkthroughSummary } from '../../src/addons/realestate/walkthrough';
import {
  executeCommand,
  executeQuery,
  fileBeginUpload,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type SystemActor,
} from '../../src/server';
import { realestateBusiness } from './realestate-fixture';

describe('the walkthrough’s list', () => {
  it('walks the agreed repairs, what stays and goes, the findings left alone, then the rooms', () => {
    const items = walkthroughItems({
      agreedRepairs: [
        { findingId: 'a', title: 'Water heater past its life', ask: 'replace', creditCents: null },
        { findingId: 'b', title: 'GFCI outlets missing', ask: 'repair', creditCents: null },
        { findingId: 'c', title: 'Roof flashing loose', ask: 'credit', creditCents: 60_000 },
      ],
      includedItems: 'Fridge, washer and dryer; window coverings.',
      excludedItems: 'Dining room chandelier',
      findings: [
        { id: 'a', title: 'Water heater past its life', location: 'Garage', severity: 'safety' },
        { id: 'd', title: 'Cracked driveway', location: 'Front', severity: 'repair' },
        { id: 'e', title: 'Worn weather stripping', location: 'Doors', severity: 'minor' },
      ],
    });
    expect(items.map((i) => [i.source, i.title, i.detail])).toEqual([
      ['repair', 'Water heater past its life', 'Replaced'],
      ['repair', 'GFCI outlets missing', 'Repaired'],
      ['included', 'Fridge', 'Stays with the home'],
      ['included', 'washer', 'Stays with the home'],
      ['included', 'dryer', 'Stays with the home'],
      ['included', 'window coverings', 'Stays with the home'],
      ['excluded', 'Dining room chandelier', 'Goes with the sellers'],
      ['finding', 'Cracked driveway', 'Front · From the inspection, not in the repairs'],
      ['room', 'Kitchen', 'As it was when you last saw it'],
      ['room', 'Bathrooms', 'As it was when you last saw it'],
      ['room', 'Bedrooms', 'As it was when you last saw it'],
      ['room', 'Living areas', 'As it was when you last saw it'],
      ['room', 'Garage', 'As it was when you last saw it'],
      ['room', 'Outside and yard', 'As it was when you last saw it'],
    ]);
  });

  it('says how it went in a line', () => {
    expect(walkthroughSummary(['ok', 'ok', 'not_ok', 'unsure', 'unchecked'])).toBe(
      '2 of 5 OK, 1 to fix before closing, 1 not sure, 1 not checked',
    );
    expect(walkthroughSummary(['ok', 'ok'])).toBe('2 of 2 OK');
  });
});

// ---------- on the database ----------

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
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
const run = (name: string, input: Record<string, unknown>, as: TestUser = agent): Promise<Any> =>
  executeCommand(
    api(),
    op(name) as CommandDef,
    { workspaceId: ws, ...input },
    human(as),
    meta(),
  ).then((r) => r.output);
const ask = (name: string, input: Record<string, unknown>): Promise<Any> =>
  executeQuery(api(), op(name) as QueryDef, { workspaceId: ws, ...input }, human(agent), meta());
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
let ws: string;
let org: string;
let deal: string;
let other: string;

/** A file on a deal, as the phone uploads it. */
async function fileOn(dealId: string, name: string, mimeType: string): Promise<string> {
  const up = await executeCommand(
    api(),
    fileBeginUpload,
    {
      workspaceId: ws,
      recordType: 'custom_record',
      recordId: dealId,
      name,
      mimeType,
      sizeBytes: 4096,
    },
    human(agent),
    meta(),
  );
  await asUser(api(), agent.claims, (tx) =>
    rows(tx, sql`update app.files set status = 'ready' where id = ${up.output.fileId}`),
  );
  return up.output.fileId;
}

beforeAll(async () => {
  [owner, agent] = await Promise.all([
    createTestUser('rfn-owner'),
    createTestUser('rfn-agent', { fullName: 'Dana Reyes' }),
  ]);
  ws = await realestateBusiness(owner, 'Field Realty');
  const [w] = await rows<{ org: string }>(
    admin(),
    sql`select organization_id as org from app.workspaces where id = ${ws}`,
  );
  org = w!.org;
  await admin()
    .insert(workspaceMemberships)
    .values({ workspaceId: ws, userId: agent.id, role: 'member' });
  const client = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Linh', lastName: 'Nguyen' },
      human(agent),
      meta(),
    )
  ).output.personId;
  const open = (name: string) =>
    run('realestate.deal.open', {
      side: 'buyer',
      name,
      clientPersonId: client,
      stage: 'under_contract',
    });
  deal = (await open('Nguyen purchase')).dealId;
  other = (await open('Nguyen second home')).dealId;
  await run('realestate.term.enter', { dealId: deal, key: 'closing', date: '2026-11-06' });
}, 120_000);

afterAll(closeTestDbs);

describe('field notes', () => {
  it('keep the phone’s id: sent twice, it’s one note; on another deal, the id can’t be used', async () => {
    const id = randomUUID();
    const note = {
      dealId: deal,
      id,
      aboutKind: 'deal',
      body: 'Sellers leaving the shed; ask about the permit.',
    };
    expect(await run('realestate.field_note.add', note)).toEqual({ noteId: id });
    expect(await run('realestate.field_note.add', note)).toEqual({ noteId: id });
    const list = await ask('realestate.field_notes', { dealId: deal });
    expect(list.notes.filter((n: { id: string }) => n.id === id)).toHaveLength(1);
    expect(
      (await refused(run('realestate.field_note.add', { ...note, dealId: other }))).message,
    ).toContain('Discard it and add it again');
  });

  it('wait for a recording’s words, which only the worker gives', async () => {
    const audio = await fileOn(deal, 'Note at 12 Oak.m4a', 'audio/mp4');
    const id = randomUUID();
    await run('realestate.field_note.add', {
      dealId: deal,
      id,
      aboutKind: 'deal',
      audioFileId: audio,
    });
    const before = (await ask('realestate.field_notes', { dealId: deal })).notes.find(
      (n: { id: string }) => n.id === id,
    );
    expect(before).toMatchObject({
      transcriptState: 'waiting',
      transcript: null,
      audioFileId: audio,
    });
    // A person can't say what a recording said.
    expect(
      (
        await refused(
          run('realestate.field_note.transcribed', { noteId: id, transcript: 'Made up' }),
        )
      ).rule,
    ).toBe('forbidden');
    const system: SystemActor = {
      type: 'system',
      workspaceId: ws,
      organizationId: org,
      onBehalfOf: null,
    };
    const done = await executeCommand(
      testDbs().worker.db,
      op('realestate.field_note.transcribed') as CommandDef,
      { workspaceId: ws, noteId: id, transcript: '  Roof looks newer than the listing says.  ' },
      system,
      meta(),
    );
    expect(done.output).toEqual({ noteId: id, state: 'done' });
    const after = (await ask('realestate.field_notes', { dealId: deal })).notes.find(
      (n: { id: string }) => n.id === id,
    );
    expect(after).toMatchObject({
      transcriptState: 'done',
      transcript: 'Roof looks newer than the listing says.',
    });
  });

  it('only carry the deal’s own photos', async () => {
    const elsewhere = await fileOn(other, 'Kitchen.jpg', 'image/jpeg');
    expect(
      (
        await refused(
          run('realestate.field_note.add', {
            dealId: deal,
            id: randomUUID(),
            photoFileIds: [elsewhere],
          }),
        )
      ).message,
    ).toContain('isn’t on Nguyen purchase');
  });
});

describe('the final walkthrough', () => {
  let walkthroughId: string;

  it('is planned from the agreed repairs, the contract’s items and the findings left alone', async () => {
    const { inspectionId } = await run('realestate.inspection.add', {
      dealId: deal,
      kind: 'general',
      inspector: 'Lone Star Inspections',
    });
    for (const f of [
      {
        title: 'Water heater past its life',
        location: 'Garage',
        severity: 'safety',
        clientPriority: 'must_fix',
        ask: 'replace',
      },
      {
        title: 'Roof flashing loose',
        location: 'Chimney',
        severity: 'repair',
        clientPriority: 'would_like',
        ask: 'credit',
        creditCents: 60_000,
      },
      { title: 'Cracked driveway', location: 'Front', severity: 'repair', clientPriority: 'skip' },
    ])
      await run('realestate.finding.add', { inspectionId, ...f });
    const view = await ask('realestate.inspections', { dealId: deal });
    await run('realestate.repair.send', { dealId: deal, words: view.draft.words });
    await run('realestate.repair.record_answer', {
      dealId: deal,
      outcome: 'agreed',
      words: 'Seller will replace the water heater and credit $600.',
      creditCents: 60_000,
    });
    await run('realestate.term.enter', {
      dealId: deal,
      key: 'included_items',
      text: 'Fridge, washer',
    });
    await run('realestate.term.enter', { dealId: deal, key: 'excluded_items', text: 'Chandelier' });

    walkthroughId = randomUUID();
    const planned = await run('realestate.walkthrough.plan', { dealId: deal, id: walkthroughId });
    expect(planned).toEqual({ walkthroughId, items: 11 });
    // Planned again with the same id: the same walkthrough. Another while it's open: refused.
    expect(await run('realestate.walkthrough.plan', { dealId: deal, id: walkthroughId })).toEqual(
      planned,
    );
    expect(
      (await refused(run('realestate.walkthrough.plan', { dealId: deal, id: randomUUID() }))).rule,
    ).toBe('realestate_walkthrough_open');
    const w = (await ask('realestate.walkthrough', { dealId: deal })).walkthrough;
    expect(w.state).toBe('planned');
    expect(
      w.items.map((i: { source: string; title: string }) => `${i.source}: ${i.title}`),
    ).toEqual([
      'repair: Water heater past its life',
      'included: Fridge',
      'included: washer',
      'excluded: Chandelier',
      'finding: Cracked driveway',
      'room: Kitchen',
      'room: Bathrooms',
      'room: Bedrooms',
      'room: Living areas',
      'room: Garage',
      'room: Outside and yard',
    ]);
  });

  it('is checked item by item, and finishing turns what isn’t right into a duty before closing', async () => {
    const items = (await ask('realestate.walkthrough', { dealId: deal })).walkthrough.items as {
      id: string;
      title: string;
    }[];
    const photo = await fileOn(deal, 'Water heater.jpg', 'image/jpeg');
    for (const i of items)
      await run('realestate.walkthrough.check_item', {
        itemId: i.id,
        state: i.title === 'Water heater past its life' ? 'not_ok' : 'ok',
        ...(i.title === 'Water heater past its life'
          ? { note: 'Old heater still in; no receipt.', photoFileIds: [photo] }
          : {}),
      });
    const added = randomUUID();
    await run('realestate.walkthrough.add_item', {
      walkthroughId,
      id: added,
      title: 'Garage door opener remotes',
    });
    // Sent twice from a phone: one item.
    await run('realestate.walkthrough.add_item', {
      walkthroughId,
      id: added,
      title: 'Garage door opener remotes',
    });
    await run('realestate.walkthrough.check_item', { itemId: added, state: 'unsure' });
    const started = (await ask('realestate.walkthrough', { dealId: deal })).walkthrough;
    expect(started.state).toBe('started');
    expect(started.summary).toBe('10 of 12 OK, 1 to fix before closing, 1 not sure');

    const done = await run('realestate.walkthrough.finish', { walkthroughId, clientsAgreed: true });
    expect(done).toEqual({
      walkthroughId,
      summary: '10 of 12 OK, 1 to fix before closing, 1 not sure',
      dutiesAdded: 1,
    });
    // Finished twice from a phone: nothing more.
    expect(await run('realestate.walkthrough.finish', { walkthroughId })).toMatchObject({
      dutiesAdded: 0,
    });
    const [duty] = await rows<{ title: string; duty_key: string }>(
      admin(),
      sql`select definition ->> 'title' as title, duty_key from addon_realestate.duties
          where deal_record_id = ${deal} and definition ->> 'title' like 'Fix before closing:%'`,
    );
    expect(duty).toMatchObject({ title: 'Fix before closing: Water heater past its life' });
    const finished = (await ask('realestate.walkthrough', { dealId: deal })).walkthrough;
    expect(finished).toMatchObject({ state: 'done' });
    expect(finished.clientsAgreedAt).not.toBeNull();
    expect(finished.items[0]).toMatchObject({ state: 'not_ok', photoFileIds: [photo] });
    expect(finished.items[0].dutyId).toBeTruthy();
    // A finished walkthrough isn't checked again.
    expect(
      (await refused(run('realestate.walkthrough.check_item', { itemId: added, state: 'ok' })))
        .rule,
    ).toBe('realestate_walkthrough_done');
  });
});
