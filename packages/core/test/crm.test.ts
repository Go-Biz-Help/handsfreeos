import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import { decodeCursor, encodeCursor, page } from '../src/kernel/pagination';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import { normalizePhone, formatPhone } from '../src/crm/phone';
import { guessMapping, mapPersonRow } from '../src/crm/import-mapping';
import {
  activityDelete,
  activityLog,
  companyArchive,
  companyCreate,
  companyGet,
  companyList,
  fileList,
  importGet,
  importList,
  tagList,
  crmFindMatches,
  crmSummary,
  fileBeginUpload,
  fileConfirm,
  importCancel,
  importCreate,
  importStart,
  leadBoard,
  leadCreate,
  leadGet,
  leadList,
  leadMoveStage,
  leadSetNextAction,
  leadUpdate,
  membershipInvite,
  organizationCreate,
  personArchive,
  personCreate,
  personGet,
  personList,
  personUpdate,
  pipelineCreate,
  pipelineList,
  recordSetTags,
  stageCreate,
  stageDelete,
  stageReorder,
  tagCreate,
  taskComplete,
  taskCreate,
  taskDelete,
  taskList,
  taskReopen,
  timelineList,
} from '../src/server';

const db = () => testDbs().api.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (correlationId = randomUUID()): RequestMeta => ({ correlationId, channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(db(), cmd, input, human(u), meta());
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(db(), q, input, human(u), meta());

async function expectHfos(
  fn: () => Promise<unknown>,
  code: HfosError['code'],
  rule?: string,
): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect(err.code).toBe(code);
    if (rule) expect(err.rule).toBe(rule);
    return err;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

let owner: TestUser;
let member: TestUser;
let member2: TestUser;
let outsider: TestUser;
let orgId: string;
let wsId: string;
let otherWs: string;
let pipelineId: string;
let stages: { id: string; name: string; kind: string }[];
const stage = (n: string) => stages.find((s) => s.name === n)!;

beforeAll(async () => {
  [owner, member, member2, outsider] = await Promise.all([
    createTestUser('crm-owner'),
    createTestUser('crm-member'),
    createTestUser('crm-member2'),
    createTestUser('crm-outsider'),
  ]);
  const org = await run(
    organizationCreate,
    { businessName: 'Lone Star Test', organizationName: 'Test Agency' },
    owner,
  );
  orgId = org.output.organizationId;
  wsId = org.output.workspaceId;
  otherWs = (await run(organizationCreate, { businessName: 'Elsewhere Co' }, outsider)).output
    .workspaceId;
  // Members join through the invitation bootstrap function, as in production.
  for (const u of [member, member2]) {
    await rows(
      testDbs().admin.db,
      sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${wsId}, ${u.id}, 'member')`,
    );
  }
  const { pipelines } = await ask(pipelineList, { workspaceId: wsId }, owner);
  pipelineId = pipelines[0]!.id;
  stages = pipelines[0]!.stages;
});
afterAll(closeTestDbs);

describe('kernel additions', () => {
  it('cursors round-trip and a malformed cursor is a validation error, never a full scan', () => {
    const c = encodeCursor({ sort: '2026-09-11T00:00:00.000Z', id: randomUUID() });
    expect(decodeCursor(c)).toEqual({ sort: '2026-09-11T00:00:00.000Z', id: expect.any(String) });
    expect(() => decodeCursor('not-a-cursor')).toThrow(HfosError);
    const p = page([1, 2, 3], 2, (n) => ({ sort: String(n), id: 'x' }));
    expect(p.items).toEqual([1, 2]);
    expect(p.nextCursor).not.toBeNull();
    expect(page([1], 2, (n) => ({ sort: String(n), id: 'x' })).nextCursor).toBeNull();
  });

  it('normalizes phones to E.164 and formats them back for people', () => {
    expect(normalizePhone('(713) 555-0142')).toBe('+17135550142');
    expect(normalizePhone('713.555.0142')).toBe('+17135550142');
    expect(normalizePhone('not a phone')).toBeNull();
    expect(formatPhone('+17135550142')).toBe('(713) 555-0142');
  });

  it('guesses import columns from headers and maps a row', () => {
    const mapping = guessMapping(
      [
        'First Name',
        'Last Name',
        'Cell',
        'Email Address',
        'Company',
        'Street',
        'Zip',
        'Referred By',
      ],
      'people',
    );
    expect(mapping).toMatchObject({
      'First Name': 'first_name',
      'Last Name': 'last_name',
      Cell: 'phone',
      'Email Address': 'email',
      Company: 'company',
      Street: 'address_line1',
      Zip: 'postal_code',
    });
    const mapped = mapPersonRow(
      {
        'First Name': 'Mike',
        'Last Name': 'Johnson',
        Cell: '713-555-0142',
        'Email Address': 'MIKE@Example.com',
        Tags: 'VIP; Referral',
      },
      { ...mapping, Tags: 'tags' },
    );
    expect(mapped.firstName).toBe('Mike');
    expect(mapped.phone).toBe('713-555-0142');
    expect(mapped.tags).toEqual(['VIP', 'Referral']);
    expect(mapPersonRow({ Name: 'Sarah Jane Alvarez' }, { Name: 'full_name' })).toMatchObject({
      firstName: 'Sarah Jane',
      lastName: 'Alvarez',
    });
  });
});

describe('people and companies', () => {
  let mikeId: string;
  it('creates a person with a normalized phone, a system activity and an event that names them', async () => {
    const res = await run(
      personCreate,
      {
        workspaceId: wsId,
        firstName: 'Mike',
        lastName: 'Johnson',
        phone: '(713) 555-0142',
        email: 'Mike.Johnson@Example.com',
        address: { line1: '123 Main St', city: 'Houston', state: 'TX' },
      },
      member,
    );
    mikeId = res.output.personId;
    expect(res.eventIds).toHaveLength(1);
    const { person } = await ask(personGet, { workspaceId: wsId, personId: mikeId }, member2);
    expect(person.fullName).toBe('Mike Johnson');
    expect(person.phone).toBe('(713) 555-0142');
    expect(person.phoneE164).toBe('+17135550142');
    expect(person.email).toBe('mike.johnson@example.com');
    const [event] = await rows<{ payload: { name: string } }>(
      testDbs().admin.db,
      sql`select payload from app.events where id = ${res.eventIds[0]}`,
    );
    expect(event!.payload.name).toBe('Mike Johnson');
    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'person', recordId: mikeId },
      member,
    );
    expect(timeline.items.map((i) => i.subtype)).toEqual(['created']);
  });

  it('warns about duplicates by phone or email unless told to save anyway; find_matches shows them first', async () => {
    const err = await expectHfos(
      () =>
        run(
          personCreate,
          { workspaceId: wsId, firstName: 'Michael', phone: '713 555 0142' },
          member,
        ),
      'conflict',
      'duplicate',
    );
    expect(
      (err.details as { matches: { name: string; matchedOn: string }[] }).matches[0],
    ).toMatchObject({ name: 'Mike Johnson', matchedOn: 'phone' });
    const { matches } = await ask(
      crmFindMatches,
      { workspaceId: wsId, kind: 'person', email: 'mike.johnson@example.com' },
      member,
    );
    expect(matches[0]).toMatchObject({ name: 'Mike Johnson', matchedOn: 'email' });
    const forced = await run(
      personCreate,
      {
        workspaceId: wsId,
        firstName: 'Mike',
        lastName: 'Johnson II',
        phone: '713 555 0142',
        ignoreDuplicates: true,
      },
      member,
    );
    expect(forced.output.personId).not.toBe(mikeId);
    await run(personArchive, { workspaceId: wsId, personId: forced.output.personId }, owner);
  });

  it('updates touch only the fields sent: an absent phone or email is kept, an empty one clears', async () => {
    const p = await run(
      personCreate,
      {
        workspaceId: wsId,
        firstName: 'Patch',
        lastName: 'Person',
        phone: '713-555-0199',
        email: 'patch@example.com',
      },
      member,
    );
    const first = await run(
      personUpdate,
      { workspaceId: wsId, personId: p.output.personId, notes: 'Only notes' },
      member,
    );
    expect(first.output.updated).toEqual(['notes']);
    let got = await ask(personGet, { workspaceId: wsId, personId: p.output.personId }, member);
    expect(got.person).toMatchObject({ phone: '(713) 555-0199', email: 'patch@example.com' });
    await run(personUpdate, { workspaceId: wsId, personId: p.output.personId, email: '' }, member);
    got = await ask(personGet, { workspaceId: wsId, personId: p.output.personId }, member);
    expect(got.person.email).toBeNull();
    expect(got.person.phone).toBe('(713) 555-0199');
    await run(personArchive, { workspaceId: wsId, personId: p.output.personId }, owner);
  });

  it('a company change on a person moves their open leads; archiving with open leads needs force', async () => {
    const abc = await run(
      companyCreate,
      { workspaceId: wsId, name: 'ABC Dental', phone: '713-555-0110' },
      member,
    );
    const lead = await run(
      leadCreate,
      { workspaceId: wsId, title: 'Roof replacement', personId: mikeId, valueCents: 1250000 },
      member,
    );
    await run(
      personUpdate,
      { workspaceId: wsId, personId: mikeId, companyId: abc.output.companyId },
      member,
    );
    const { lead: card } = await ask(
      leadGet,
      { workspaceId: wsId, leadId: lead.output.leadId },
      member,
    );
    expect(card.company?.name).toBe('ABC Dental');
    const refused = await expectHfos(
      () => run(personArchive, { workspaceId: wsId, personId: mikeId }, owner),
      'conflict',
      'has_open_work',
    );
    expect(refused.details).toMatchObject({ openLeads: 1 });
    await expectHfos(
      () => run(personArchive, { workspaceId: wsId, personId: mikeId }, member),
      'forbidden',
    );
    await expectHfos(
      () => run(companyArchive, { workspaceId: wsId, companyId: abc.output.companyId }, owner),
      'conflict',
      'has_open_work',
    );
    const forced = await run(
      personArchive,
      { workspaceId: wsId, personId: mikeId, force: true },
      owner,
    );
    expect(forced.output.archivedLeads).toBe(1);
    const listed = await ask(personList, { workspaceId: wsId, q: 'johnson' }, member);
    expect(listed.items.map((p) => p.id)).not.toContain(mikeId);
    const withArchived = await ask(
      personList,
      { workspaceId: wsId, q: 'johnson', includeArchived: true },
      member,
    );
    expect(withArchived.items.map((p) => p.id)).toContain(mikeId);
    // Archiving Mike archived his lead too, so the company is free to go now.
    const company = await run(
      companyArchive,
      { workspaceId: wsId, companyId: abc.output.companyId },
      owner,
    );
    expect(company.output.archivedLeads).toBe(0);
  });

  it('lists page by name with a stable cursor even when rows share a timestamp', async () => {
    for (const n of ['Aaron', 'Abby', 'Adam', 'Alex', 'Amy'])
      await run(personCreate, { workspaceId: wsId, firstName: n, lastName: 'Same' }, member);
    const first = await ask(personList, { workspaceId: wsId, q: 'same', limit: 2 }, member);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await ask(
      personList,
      { workspaceId: wsId, q: 'same', limit: 2, cursor: first.nextCursor! },
      member,
    );
    const third = await ask(
      personList,
      { workspaceId: wsId, q: 'same', limit: 2, cursor: second.nextCursor! },
      member,
    );
    const all = [...first.items, ...second.items, ...third.items].map((p) => p.firstName);
    expect(all).toEqual(['Aaron', 'Abby', 'Adam', 'Alex', 'Amy']);
    expect(third.nextCursor).toBeNull();
  });

  it('company.list and company.get map raw rows (dates, phones, counts) and search by name', async () => {
    const created = await run(
      companyCreate,
      {
        workspaceId: wsId,
        name: 'Riverside Apartments',
        phone: '281-555-0121',
        email: 'Office@Riverside.example',
        address: { line1: '800 Riverside Dr', city: 'Houston', state: 'TX' },
      },
      member,
    );
    const p = await run(
      personCreate,
      {
        workspaceId: wsId,
        firstName: 'Maria',
        lastName: 'Santos',
        companyId: created.output.companyId,
      },
      member,
    );
    const listed = await ask(companyList, { workspaceId: wsId, q: 'riverside' }, member);
    const row = listed.items.find((c) => c.id === created.output.companyId)!;
    expect(row).toMatchObject({
      name: 'Riverside Apartments',
      phone: '(281) 555-0121',
      phoneE164: '+12815550121',
      email: 'office@riverside.example',
      peopleCount: 1,
      openLeads: 0,
      archivedAt: null,
    });
    expect(row.address.city).toBe('Houston');
    expect(new Date(row.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const got = await ask(
      companyGet,
      { workspaceId: wsId, companyId: created.output.companyId },
      member,
    );
    expect(got.company.name).toBe('Riverside Apartments');
    expect(got.people.map((x) => x.id)).toEqual([p.output.personId]);
    await expectHfos(
      () => ask(companyGet, { workspaceId: wsId, companyId: randomUUID() }, member),
      'not_found',
    );
    const paged = await ask(companyList, { workspaceId: wsId, limit: 1 }, member);
    expect(paged.items).toHaveLength(1);
    if (paged.nextCursor) {
      const next = await ask(
        companyList,
        { workspaceId: wsId, limit: 1, cursor: paged.nextCursor },
        member,
      );
      expect(next.items[0]?.id).not.toBe(paged.items[0]!.id);
    }
  });

  it('tags are workspace-wide and applied through record.set_tags', async () => {
    const vip = await run(tagCreate, { workspaceId: wsId, name: 'VIP', color: '#c43335' }, member);
    const p = await run(
      personCreate,
      { workspaceId: wsId, firstName: 'Tagged', lastName: 'Person' },
      member,
    );
    const set = await run(
      recordSetTags,
      {
        workspaceId: wsId,
        recordType: 'person',
        recordId: p.output.personId,
        tagIds: [vip.output.tagId],
      },
      member,
    );
    expect(set.output.tags.map((t) => t.name)).toEqual(['VIP']);
    await expectHfos(() => run(tagCreate, { workspaceId: wsId, name: 'vip' }, member), 'conflict');
    const { tags } = await ask(tagList, { workspaceId: wsId }, member);
    expect(tags.find((t) => t.id === vip.output.tagId)).toMatchObject({
      name: 'VIP',
      color: '#c43335',
      usage: 1,
    });
  });
});

describe('leads and stages', () => {
  let personId: string;
  let leadId: string;
  beforeAll(async () => {
    personId = (
      await run(
        personCreate,
        { workspaceId: wsId, firstName: 'Sarah', lastName: 'Alvarez', phone: '281-555-0199' },
        member,
      )
    ).output.personId;
  });

  it('a lead starts in the first open stage; moving it changes status, needs a lost reason, and records the story', async () => {
    const created = await run(
      leadCreate,
      { workspaceId: wsId, title: 'AC install', personId, valueCents: 890000 },
      member,
    );
    leadId = created.output.leadId;
    expect(created.output.stageId).toBe(stage('New').id);
    const won = await run(
      leadMoveStage,
      { workspaceId: wsId, leadId, stageId: stage('Won').id },
      member,
    );
    expect(won.output.status).toBe('won');
    await expectHfos(
      () => run(leadMoveStage, { workspaceId: wsId, leadId, stageId: stage('Lost').id }, member),
      'validation',
    );
    const lost = await run(
      leadMoveStage,
      {
        workspaceId: wsId,
        leadId,
        stageId: stage('Lost').id,
        lostReason: 'Went with another bidder',
      },
      member,
    );
    expect(lost.output.status).toBe('lost');
    const types = await rows<{ event_type: string }>(
      testDbs().admin.db,
      sql`select event_type from app.events where entity_id = ${leadId}`,
    );
    expect(types.map((t) => t.event_type).sort()).toEqual([
      'lead.created',
      'lead.lost',
      'lead.stage_changed',
      'lead.stage_changed',
      'lead.won',
    ]);
    const reopened = await run(
      leadMoveStage,
      { workspaceId: wsId, leadId, stageId: stage('Contacted').id },
      member,
    );
    expect(reopened.output.status).toBe('open');
    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'lead', recordId: leadId },
      member,
    );
    expect(timeline.items.map((i) => i.subtype)).toEqual([
      'reopened',
      'lost',
      'won',
      'lead_created',
    ]);
    const { lead } = await ask(leadGet, { workspaceId: wsId, leadId }, member);
    expect(lead.lostReason).toBeNull();
    expect(lead.needsNextAction).toBe(true);
  });

  it('next action can be set and cleared; the board flags leads without one', async () => {
    await run(
      leadSetNextAction,
      {
        workspaceId: wsId,
        leadId,
        text: 'Call Sarah',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      member,
    );
    const board = await ask(leadBoard, { workspaceId: wsId }, member);
    const contacted = board.stages.find((s) => s.name === 'Contacted')!;
    const card = contacted.leads.find((l) => l.id === leadId)!;
    expect(card.nextAction).toBe('Call Sarah');
    expect(card.needsNextAction).toBe(false);
    expect(contacted.valueCents).toBeGreaterThanOrEqual(890000);
    await run(leadSetNextAction, { workspaceId: wsId, leadId, text: null }, member);
    const again = await ask(leadGet, { workspaceId: wsId, leadId }, member);
    expect(again.lead.needsNextAction).toBe(true);
  });

  it('positions keep board order: after a card, at the top, at the bottom', async () => {
    const a = (await run(leadCreate, { workspaceId: wsId, title: 'A', personId }, member)).output
      .leadId;
    const b = (await run(leadCreate, { workspaceId: wsId, title: 'B', personId }, member)).output
      .leadId;
    const c = (await run(leadCreate, { workspaceId: wsId, title: 'C', personId }, member)).output
      .leadId;
    const order = async () =>
      (await ask(leadBoard, { workspaceId: wsId }, member)).stages
        .find((s) => s.name === 'New')!
        .leads.map((l) => l.title);
    expect(await order()).toEqual(['A', 'B', 'C']);
    await run(
      leadMoveStage,
      { workspaceId: wsId, leadId: c, stageId: stage('New').id, afterLeadId: null },
      member,
    );
    expect(await order()).toEqual(['C', 'A', 'B']);
    await run(
      leadMoveStage,
      { workspaceId: wsId, leadId: a, stageId: stage('New').id, afterLeadId: b },
      member,
    );
    expect(await order()).toEqual(['C', 'B', 'A']);
    await run(leadMoveStage, { workspaceId: wsId, leadId: b, stageId: stage('New').id }, member);
    expect(await order()).toEqual(['C', 'A', 'B']);
  });

  it('assigning emits lead.assigned with the name and writes a timeline entry', async () => {
    const res = await run(
      leadUpdate,
      { workspaceId: wsId, leadId, assigneeUserId: member2.id },
      member,
    );
    expect(res.output.updated).toEqual(['assigneeUserId']);
    const [ev] = await rows<{ payload: { assigneeName: string } }>(
      testDbs().admin.db,
      sql`select payload from app.events where entity_id = ${leadId} and event_type = 'lead.assigned'`,
    );
    expect(ev!.payload.assigneeName).toBe(member2.fullName);
  });

  it('stages reorder, add after another, and delete only into a stage of the same kind', async () => {
    const extra = await run(
      stageCreate,
      { workspaceId: wsId, pipelineId, name: 'Follow-up', afterStageId: stage('Contacted').id },
      owner,
    );
    const listed = (await ask(pipelineList, { workspaceId: wsId }, owner)).pipelines[0]!;
    expect(listed.stages.map((s) => s.name)).toEqual([
      'New',
      'Contacted',
      'Follow-up',
      'Estimate sent',
      'Won',
      'Lost',
    ]);
    await expectHfos(
      () => run(stageCreate, { workspaceId: wsId, pipelineId: listed.id, name: 'Nope' }, member),
      'forbidden',
    );
    const reversed = [...listed.stages].reverse().map((s) => s.id);
    await run(
      stageReorder,
      { workspaceId: wsId, pipelineId: listed.id, stageIds: reversed },
      owner,
    );
    const after = (await ask(pipelineList, { workspaceId: wsId }, owner)).pipelines[0]!;
    expect(after.stages.map((s) => s.name)).toEqual([
      'Lost',
      'Won',
      'Estimate sent',
      'Follow-up',
      'Contacted',
      'New',
    ]);
    await run(
      stageReorder,
      { workspaceId: wsId, pipelineId: listed.id, stageIds: listed.stages.map((s) => s.id) },
      owner,
    );
    await run(leadMoveStage, { workspaceId: wsId, leadId, stageId: extra.output.stageId }, member);
    await expectHfos(
      () => run(stageDelete, { workspaceId: wsId, stageId: extra.output.stageId }, owner),
      'rule_violation',
      'stage_has_leads',
    );
    await expectHfos(
      () =>
        run(
          stageDelete,
          { workspaceId: wsId, stageId: extra.output.stageId, moveLeadsToStageId: stage('Won').id },
          owner,
        ),
      'validation',
    );
    const del = await run(
      stageDelete,
      {
        workspaceId: wsId,
        stageId: extra.output.stageId,
        moveLeadsToStageId: stage('Contacted').id,
      },
      owner,
    );
    expect(del.output.movedLeads).toBe(1);
    await expectHfos(
      () => run(stageDelete, { workspaceId: wsId, stageId: stage('Won').id }, owner),
      'rule_violation',
      'last_stage_of_kind',
    );
    const second = await run(
      pipelineCreate,
      {
        workspaceId: wsId,
        name: 'Maintenance plans',
        stages: [
          { name: 'Due', kind: 'open' },
          { name: 'Renewed', kind: 'won' },
          { name: 'Lapsed', kind: 'lost' },
        ],
      },
      owner,
    );
    expect(second.output.pipelineId).toBeDefined();
    await expectHfos(
      () =>
        run(
          pipelineCreate,
          {
            workspaceId: wsId,
            name: 'Broken',
            stages: [
              { name: 'A', kind: 'open' },
              { name: 'B', kind: 'open' },
              { name: 'C', kind: 'open' },
            ],
          },
          owner,
        ),
      'validation',
    );
  });

  it('lead.list pages newest first with a composite cursor', async () => {
    const first = await ask(leadList, { workspaceId: wsId, limit: 2 }, member);
    expect(first.items).toHaveLength(2);
    const second = await ask(
      leadList,
      { workspaceId: wsId, limit: 2, cursor: first.nextCursor! },
      member,
    );
    expect(second.items.map((l) => l.id)).not.toContain(first.items[0]!.id);
  });

  it('lead.list narrows to leads that came in after a time, or to open leads without a next action', async () => {
    const create = async (title: string, nextAction?: string) =>
      (await run(leadCreate, { workspaceId: wsId, title, personId, nextAction }, member)).output
        .leadId;
    const fresh = await create('Fresh lead');
    const planned = await create('Planned lead', 'Send the estimate');
    const old = await create('Old lead');
    await rows(
      testDbs().admin.db,
      sql`update app.leads set created_at = now() - interval '3 days' where id = ${old}`,
    );
    const recent = await ask(
      leadList,
      {
        workspaceId: wsId,
        createdAfter: new Date(Date.now() - 86_400_000).toISOString(),
        limit: 100,
      },
      member,
    );
    const recentIds = recent.items.map((l) => l.id);
    expect(recentIds).toEqual(expect.arrayContaining([fresh, planned]));
    expect(recentIds).not.toContain(old);
    const waiting = await ask(
      leadList,
      { workspaceId: wsId, withoutNextAction: true, limit: 100 },
      member,
    );
    expect(waiting.items.length).toBeGreaterThan(0);
    expect(waiting.items.every((l) => l.needsNextAction)).toBe(true);
    const waitingIds = waiting.items.map((l) => l.id);
    expect(waitingIds).toEqual(expect.arrayContaining([fresh, old]));
    expect(waitingIds).not.toContain(planned);
  });
});

describe('tasks, activities and the home summary', () => {
  it('tasks complete and reopen; completion lands on the related timeline; only the author or an admin deletes', async () => {
    const personId = (
      await run(personCreate, { workspaceId: wsId, firstName: 'Tasky', lastName: 'Person' }, member)
    ).output.personId;
    const task = await run(
      taskCreate,
      {
        workspaceId: wsId,
        title: 'Call about the estimate',
        personId,
        assigneeUserId: member.id,
        dueAt: new Date().toISOString(),
      },
      member,
    );
    const mine = await ask(taskList, { workspaceId: wsId, scope: 'mine' }, member);
    expect(mine.items.map((t) => t.id)).toContain(task.output.taskId);
    expect(mine.items.find((t) => t.id === task.output.taskId)!.dueBucket).toBe('today');
    expect(mine.timezone).toBe('America/Chicago');
    await run(taskComplete, { workspaceId: wsId, taskId: task.output.taskId }, member);
    const timeline = await ask(
      timelineList,
      { workspaceId: wsId, recordType: 'person', recordId: personId },
      member,
    );
    expect(timeline.items[0]).toMatchObject({
      subtype: 'task_done',
      body: 'Call about the estimate',
    });
    await run(taskReopen, { workspaceId: wsId, taskId: task.output.taskId }, member);
    await expectHfos(
      () => run(taskDelete, { workspaceId: wsId, taskId: task.output.taskId }, member2),
      'forbidden',
    );
    await run(taskDelete, { workspaceId: wsId, taskId: task.output.taskId }, owner);
  });

  it('notes are logged by people and deleted only by their author or an admin', async () => {
    const personId = (
      await run(personCreate, { workspaceId: wsId, firstName: 'Noted', lastName: 'Person' }, member)
    ).output.personId;
    const note = await run(
      activityLog,
      { workspaceId: wsId, kind: 'note', body: 'Prefers texts', personId },
      member,
    );
    await expectHfos(
      () => run(activityDelete, { workspaceId: wsId, activityId: note.output.activityId }, member2),
      'forbidden',
    );
    await run(activityDelete, { workspaceId: wsId, activityId: note.output.activityId }, owner);
    await expectHfos(
      () => run(activityLog, { workspaceId: wsId, kind: 'note', body: 'x' }, member),
      'validation',
    );
  });

  it('task.list narrows to one teammate’s tasks', async () => {
    const create = async (title: string, assigneeUserId: string) =>
      (await run(taskCreate, { workspaceId: wsId, title, assigneeUserId }, member)).output.taskId;
    const mine = await create('Member task', member.id);
    const theirs = await create('Teammate task', member2.id);
    const listed = await ask(
      taskList,
      { workspaceId: wsId, scope: 'all', assigneeUserId: member2.id },
      member,
    );
    const ids = listed.items.map((t) => t.id);
    expect(ids).toContain(theirs);
    expect(ids).not.toContain(mine);
    expect(listed.items.every((t) => t.assignee?.id === member2.id)).toBe(true);
  });

  it('the summary counts open leads, missing next actions and tasks', async () => {
    const summary = await ask(crmSummary, { workspaceId: wsId }, member);
    expect(summary.openLeads).toBeGreaterThan(0);
    expect(summary.leadsWithoutNextAction).toBeGreaterThan(0);
    expect(summary.people).toBeGreaterThan(0);
  });
});

describe('files and imports', () => {
  it('begin_upload reserves a server-made path and confirm refuses before the object exists', async () => {
    const personId = (
      await run(personCreate, { workspaceId: wsId, firstName: 'Filed', lastName: 'Person' }, member)
    ).output.personId;
    const res = await run(
      fileBeginUpload,
      {
        workspaceId: wsId,
        recordType: 'person',
        recordId: personId,
        name: 'roof photo.heic',
        mimeType: 'image/heic',
        sizeBytes: 1024,
      },
      member,
    );
    expect(res.output.objectPath).toBe(
      `${wsId}/person/${personId}/${res.output.fileId}/roof-photo.heic`,
    );
    await expectHfos(
      () => run(fileConfirm, { workspaceId: wsId, fileId: res.output.fileId }, member),
      'rule_violation',
      'file_not_uploaded',
    );
    await expectHfos(
      () =>
        run(
          fileBeginUpload,
          {
            workspaceId: wsId,
            recordType: 'person',
            recordId: personId,
            name: 'evil.svg',
            mimeType: 'image/svg+xml',
            sizeBytes: 10,
          },
          member,
        ),
      'validation',
    );
    // Pending rows stay out of the list until confirmed.
    const { files } = await ask(
      fileList,
      { workspaceId: wsId, recordType: 'person', recordId: personId },
      member,
    );
    expect(files).toEqual([]);
  });

  it('imports are reserved, need the object to start, and can be cancelled', async () => {
    const res = await run(
      importCreate,
      { workspaceId: wsId, kind: 'people', fileName: 'customers.csv' },
      owner,
    );
    expect(res.output.objectPath).toBe(`${wsId}/${res.output.importId}.csv`);
    await expectHfos(
      () =>
        run(
          importStart,
          { workspaceId: wsId, importId: res.output.importId, mapping: { Name: 'full_name' } },
          owner,
        ),
      'rule_violation',
      'import_not_ready',
    );
    await expectHfos(
      () =>
        run(
          importStart,
          { workspaceId: wsId, importId: res.output.importId, mapping: { Name: 'bogus' } },
          owner,
        ),
      'validation',
    );
    await expectHfos(
      () => run(importCreate, { workspaceId: wsId, kind: 'people', fileName: 'x.csv' }, member),
      'forbidden',
    );
    const cancelled = await run(
      importCancel,
      { workspaceId: wsId, importId: res.output.importId },
      owner,
    );
    expect(cancelled.output.status).toBe('cancelled');
    const got = await ask(importGet, { workspaceId: wsId, importId: res.output.importId }, owner);
    expect(got.import).toMatchObject({
      kind: 'people',
      fileName: 'customers.csv',
      status: 'cancelled',
      totalRows: 0,
      startedAt: null,
    });
    expect(new Date(got.import.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(got.errors).toEqual([]);
    const listed = await ask(importList, { workspaceId: wsId }, owner);
    expect(listed.imports.map((i) => i.id)).toContain(res.output.importId);
    await expectHfos(() => ask(importList, { workspaceId: wsId }, member), 'forbidden');
  });
});

describe('the system actor', () => {
  const system = (
    workspaceId: string,
    organizationId: string,
    onBehalfOf: string,
  ): SystemActor => ({ type: 'system', workspaceId, organizationId, onBehalfOf });

  it('runs opted-in commands inside its scope without a permission check, recording who it worked for', async () => {
    const res = await executeCommand(
      testDbs().worker.db,
      personCreate,
      {
        workspaceId: wsId,
        firstName: 'Imported',
        lastName: 'Person',
        email: 'imported@example.com',
      },
      system(wsId, orgId, owner.id),
      meta(),
    );
    const [event] = await rows<{
      actor_type: string;
      actor_id: string | null;
      payload: { onBehalfOf: string };
    }>(
      testDbs().admin.db,
      sql`select actor_type::text as actor_type, actor_id, payload from app.events where id = ${res.eventIds[0]}`,
    );
    expect(event).toMatchObject({ actor_type: 'system', actor_id: null });
    expect(event!.payload.onBehalfOf).toBe(owner.id);
    const { person } = await ask(
      personGet,
      { workspaceId: wsId, personId: res.output.personId },
      member,
    );
    expect(person.fullName).toBe('Imported Person');
  });

  it('cannot reach another workspace and cannot run human-only commands', async () => {
    await expectHfos(
      () =>
        executeCommand(
          testDbs().worker.db,
          personCreate,
          { workspaceId: otherWs, firstName: 'Nope' },
          system(wsId, orgId, owner.id),
          meta(),
        ),
      'not_found',
    );
    await expectHfos(
      () =>
        executeCommand(
          testDbs().worker.db,
          membershipInvite,
          { workspaceId: wsId, email: 'x@example.com', role: 'member' },
          system(wsId, orgId, owner.id),
          meta(),
        ),
      'forbidden',
    );
    await expectHfos(
      () =>
        executeQuery(
          testDbs().worker.db,
          personList,
          { workspaceId: wsId },
          system(wsId, orgId, owner.id),
          meta(),
        ),
      'forbidden',
    );
  });
});
