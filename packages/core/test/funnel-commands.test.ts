/**
 * Teammate funnels on the local database (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md stage 1): making and
 * saving one, turning it on, who's in it and how they move, pausing, the teammate's suggestions, one funnel at a
 * time, taking a stage out, archiving, the screens' reads, and row security. Christina's recruiting funnel is the
 * scenario.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  AiEmployeeActor,
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  aiTeammateCreate,
  aiTeammateSetStatus,
  funnelAddPerson,
  funnelArchive,
  funnelCreate,
  funnelDecideSuggestion,
  funnelGet,
  funnelList,
  funnelMovePerson,
  funnelNoteProgress,
  funnelOfPerson,
  funnelPause,
  funnelPausePerson,
  funnelPeopleList,
  funnelRemovePerson,
  funnelSave,
  funnelSuggest,
  funnelSuggestionList,
  funnelTurnOn,
  leadCreate,
  leadMoveStage,
  organizationCreate,
  personCreate,
} from '../src/server';
import { christinaFunnel, RECRUITING_STAGES, type RecruitingKey } from './funnel-fixtures';

const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (channel: RequestMeta['channel'] = 'test'): RequestMeta => ({
  correlationId: randomUUID(),
  channel,
});

const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

interface Biz {
  readonly owner: TestUser;
  readonly member: TestUser;
  readonly wsId: string;
  readonly orgId: string;
  teammateId: string;
}
let a: Biz;
let other: Biz;

const system = (biz: Biz): SystemActor => ({
  type: 'system',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
});
const sys = <I extends z.ZodType, O extends z.ZodType>(
  biz: Biz,
  cmd: CommandDef<I, O>,
  input: unknown,
) => executeCommand(worker(), cmd, input, system(biz), meta('worker')).then((r) => r.output);
const ava = (biz: Biz, conversationId: string): AiEmployeeActor => ({
  type: 'ai_employee',
  workspaceId: biz.wsId,
  organizationId: biz.orgId,
  teammateId: biz.teammateId,
  teammateName: 'Ava',
  runId: null,
  conversationId,
  approvedBy: null,
  origin: null,
  test: false,
});
const asAva = <I extends z.ZodType, O extends z.ZodType>(
  biz: Biz,
  conversationId: string,
  cmd: CommandDef<I, O>,
  input: unknown,
) =>
  executeCommand(worker(), cmd, input, ava(biz, conversationId), meta('ai_employee')).then(
    (r) => r.output,
  );

async function expectHfos(fn: () => Promise<unknown>, code: HfosError['code'], rule?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect({ code: err.code, rule: err.rule }).toMatchObject({ code, ...(rule ? { rule } : {}) });
    return err;
  }
  throw new Error(`expected ${code}${rule ? ` (${rule})` : ''}, but the call succeeded`);
}

async function setupBusiness(label: string): Promise<Biz> {
  const [owner, member] = await Promise.all([
    createTestUser(`funnel-${label}-owner`, { fullName: 'Christina Owner' }),
    createTestUser(`funnel-${label}-member`, { fullName: 'Marco Member' }),
  ]);
  const org = await run(organizationCreate, { businessName: `${label} Recruiting` }, owner);
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${org.workspaceId}, ${member.id}, 'member')`,
  );
  const biz: Biz = {
    owner,
    member,
    wsId: org.workspaceId,
    orgId: org.organizationId,
    teammateId: '',
  };
  biz.teammateId = (
    await run(
      aiTeammateCreate,
      { workspaceId: biz.wsId, preset: 'lead_responder', name: 'Ava', disclosure: 'when_asked' },
      owner,
    )
  ).teammateId;
  return biz;
}

let phoneSeq = 0;
async function customer(biz: Biz, firstName: string) {
  const { personId } = await run(
    personCreate,
    {
      workspaceId: biz.wsId,
      firstName,
      lastName: 'Recruit',
      phone: `+1713555${String(2000 + phoneSeq++).padStart(4, '0')}`,
      ignoreDuplicates: true,
    },
    biz.owner,
  );
  return personId;
}

/** A text conversation with the customer, handled by the AI teammate. */
async function aiConversation(biz: Biz, personId: string): Promise<string> {
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, handled_by, ai_teammate_id)
        values (${biz.wsId}, 'sms', ${`+1713555${String(9000 + phoneSeq++).padStart(4, '0')}`}, ${personId}, 'ai',
                ${biz.teammateId})
        returning id`,
  );
  return c!.id;
}

const eventsOf = (biz: Biz, type: string) =>
  rows<{ payload: Record<string, unknown> }>(
    admin(),
    sql`select payload from app.events where workspace_id = ${biz.wsId} and event_type = ${type} order by created_at`,
  );
const funnelRow = async (funnelPersonId: string) =>
  (
    await rows<{
      status: string;
      stage_id: string | null;
      lead_id: string | null;
      seen: string[];
      sent: string[];
      paused_reason: string | null;
      left_reason: string | null;
      appointment_id: string | null;
    }>(admin(), sql`select * from app.funnel_people where id = ${funnelPersonId}`)
  )[0]!;
const leadOf = async (leadId: string) =>
  (
    await rows<{ stage_id: string; status: string }>(
      admin(),
      sql`select stage_id, status from app.leads where id = ${leadId}`,
    )
  )[0]!;

// The recruiting funnel, made on a new pipeline of its own.
let funnelId: string;
let pipelineId: string;
let stage: Record<RecruitingKey, string>;
let revision: number;

beforeAll(async () => {
  [a, other] = await Promise.all([setupBusiness('fa'), setupBusiness('fb')]);
});
afterAll(async () => {
  await closeTestDbs();
});

describe('making a funnel', () => {
  it('makes one on a new pipeline from its stages, as a draft with a stage for each', async () => {
    const made = await run(
      funnelCreate,
      {
        workspaceId: a.wsId,
        name: 'Recruiting',
        newPipeline: {
          name: 'Recruiting',
          stages: RECRUITING_STAGES.map((s) => ({ name: s.name, kind: s.kind })),
        },
        description: 'How we take a new recruit to the three-way call.',
      },
      a.owner,
    );
    ({ funnelId, pipelineId, revision } = made);
    expect(revision).toBe(1);
    const list = await rows<{ id: string; name: string }>(
      admin(),
      sql`select id, name from app.pipeline_stages where pipeline_id = ${pipelineId} order by position`,
    );
    stage = Object.fromEntries(
      RECRUITING_STAGES.map((s) => [s.key, list.find((l) => l.name === s.name)!.id]),
    ) as Record<RecruitingKey, string>;
    const got = await ask(funnelGet, { workspaceId: a.wsId, funnelId }, a.owner);
    expect(got.funnel).toMatchObject({
      name: 'Recruiting',
      status: 'draft',
      pipelineName: 'Recruiting',
      people: 0,
    });
    expect(got.funnel.definition.stages.map((s) => s.stageId)).toEqual(list.map((l) => l.id));
    expect(got.funnel.definition.description).toBe(
      'How we take a new recruit to the three-way call.',
    );
    expect(await eventsOf(a, 'funnel.created')).toHaveLength(1);
  });

  it('runs one funnel a pipeline, and a name once', async () => {
    await expectHfos(
      () => run(funnelCreate, { workspaceId: a.wsId, name: 'Second', pipelineId }, a.owner),
      'rule_violation',
      'pipeline_has_funnel',
    );
    const [sales] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.pipelines where workspace_id = ${a.wsId} and id <> ${pipelineId} limit 1`,
    );
    await expectHfos(
      () =>
        run(
          funnelCreate,
          { workspaceId: a.wsId, name: 'recruiting', pipelineId: sales!.id },
          a.owner,
        ),
      'conflict',
      'funnel_name_taken',
    );
  });

  it('is for whoever runs the AI teammate', async () => {
    const [sales] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.pipelines where workspace_id = ${a.wsId} and id <> ${pipelineId} limit 1`,
    );
    await expectHfos(
      () =>
        run(funnelCreate, { workspaceId: a.wsId, name: 'Mine', pipelineId: sales!.id }, a.member),
      'forbidden',
    );
    await expectHfos(
      () => run(funnelSave, { workspaceId: a.wsId, funnelId, revision, definition: {} }, a.member),
      'forbidden',
    );
  });
});

describe('saving its steps', () => {
  it('saves the steps, and refuses a change made from an older copy', async () => {
    const saved = await run(
      funnelSave,
      { workspaceId: a.wsId, funnelId, revision, definition: christinaFunnel(stage) },
      a.owner,
    );
    expect(saved.revision).toBe(2);
    const stale = await expectHfos(
      () =>
        run(
          funnelSave,
          { workspaceId: a.wsId, funnelId, revision, definition: christinaFunnel(stage) },
          a.owner,
        ),
      'conflict',
      'funnel_changed',
    );
    expect(stale.message).toContain('another tab or window');
    revision = saved.revision;
    const [ev] = await eventsOf(a, 'funnel.saved');
    expect(ev!.payload).toMatchObject({ funnelId, revision: 2, status: 'draft' });
    expect((ev!.payload.changedStageIds as string[]).length).toBe(7);
  });

  it('refuses parts that aren’t real: a blank it can’t fill, a move out of a won stage, a missing form', async () => {
    const def = christinaFunnel(stage);
    const blank = structuredClone(def);
    blank.stages[0]!.messages[0]!.text = 'Hi {firstname}';
    const e1 = await expectHfos(
      () =>
        run(funnelSave, { workspaceId: a.wsId, funnelId, revision, definition: blank }, a.owner),
      'validation',
    );
    expect(JSON.stringify(e1.details)).toContain('{firstname}');
    const fromWon = structuredClone(def);
    fromWon.stages.find((s) => s.stageId === stage.call)!.moves = [
      { id: 'vback', kind: 'quiet', minutes: 60, to: stage.new },
    ];
    await expectHfos(
      () =>
        run(funnelSave, { workspaceId: a.wsId, funnelId, revision, definition: fromWon }, a.owner),
      'validation',
    );
    const form = structuredClone(def);
    form.entry.rules.push({ id: 'rform', kind: 'form', formId: randomUUID() });
    await expectHfos(
      () => run(funnelSave, { workspaceId: a.wsId, funnelId, revision, definition: form }, a.owner),
      'validation',
    );
  });
});

describe('turning it on', () => {
  it('needs the teammate on', async () => {
    const off = await expectHfos(
      () => run(funnelTurnOn, { workspaceId: a.wsId, funnelId }, a.owner),
      'rule_violation',
      'funnel_not_ready',
    );
    expect(off.message).toBe('Ava is off, so no funnel runs. Turn Ava on under AI teammate.');
    await run(
      aiTeammateSetStatus,
      { workspaceId: a.wsId, teammateId: a.teammateId, status: 'training' },
      a.owner,
    );
    const on = await run(funnelTurnOn, { workspaceId: a.wsId, funnelId }, a.owner);
    expect(on).toEqual({ funnelId, status: 'on', adding: 0 });
    expect((await eventsOf(a, 'funnel.turned_on'))[0]!.payload).toMatchObject({
      from: 'draft',
      addExisting: false,
    });
  });
});

// Sam, the recruit the funnel follows.
let sam: string;
let samRow: string;
let samLead: string;
let samConversation: string;

describe('who’s in it', () => {
  it('puts someone in by hand at the start, with a lead in its pipeline, once', async () => {
    sam = await customer(a, 'Sam');
    const added = await run(
      funnelAddPerson,
      { workspaceId: a.wsId, funnelId, personId: sam },
      a.member,
    );
    expect(added).toMatchObject({ stageId: stage.new, already: false });
    samRow = added.funnelPersonId;
    samLead = added.leadId;
    expect(await leadOf(samLead)).toEqual({ stage_id: stage.new, status: 'open' });
    expect(await funnelRow(samRow)).toMatchObject({
      status: 'active',
      stage_id: stage.new,
      lead_id: samLead,
    });
    expect((await eventsOf(a, 'funnel.person_added'))[0]!.payload).toMatchObject({
      funnelPersonId: samRow,
      personId: sam,
      addedBy: 'hand',
    });
    const [line] = await rows<{ subtype: string; meta: Record<string, unknown> }>(
      admin(),
      sql`select subtype, meta from app.activities where person_id = ${sam} and subtype = 'funnel_joined'`,
    );
    expect(line!.meta).toMatchObject({ funnel: 'Recruiting', stage: 'New lead', addedBy: 'hand' });
    const again = await run(
      funnelAddPerson,
      { workspaceId: a.wsId, funnelId, personId: sam },
      a.member,
    );
    expect(again).toMatchObject({ funnelPersonId: samRow, already: true });
  });

  it('notes what they did, what went and their booking, at their stage only', async () => {
    expect(
      await sys(a, funnelNoteProgress, {
        workspaceId: a.wsId,
        funnelPersonId: samRow,
        stageId: stage.new,
        seen: 'form.stopped',
        sent: ['mlink'],
      }),
    ).toEqual({ changed: true });
    expect(
      await sys(a, funnelNoteProgress, {
        workspaceId: a.wsId,
        funnelPersonId: samRow,
        stageId: stage.booked,
        sent: ['mhour'],
      }),
    ).toEqual({ changed: false });
    expect(await funnelRow(samRow)).toMatchObject({ seen: ['form.stopped'], sent: ['mlink'] });
    await expectHfos(
      () =>
        run(
          funnelNoteProgress,
          { workspaceId: a.wsId, funnelPersonId: samRow, stageId: stage.new },
          a.owner,
        ),
      'forbidden',
    );
  });

  it('follows their lead: a move on the board starts that stage afresh', async () => {
    await run(
      leadMoveStage,
      { workspaceId: a.wsId, leadId: samLead, stageId: stage.booked },
      a.member,
    );
    expect(await funnelRow(samRow)).toMatchObject({
      status: 'active',
      stage_id: stage.booked,
      seen: [],
      sent: [],
    });
    expect((await eventsOf(a, 'funnel.stage_reached')).at(-1)!.payload).toMatchObject({
      funnelPersonId: samRow,
      stageId: stage.booked,
      fromStageId: stage.new,
    });
  });

  it('moves them by the funnel’s moves, back a stage too, and only by a move in their stage', async () => {
    const missed = await sys(a, funnelMovePerson, {
      workspaceId: a.wsId,
      funnelPersonId: samRow,
      stageId: stage.missed,
      moveId: 'vnoshow',
    });
    expect(missed).toEqual({ funnelPersonId: samRow, stageId: stage.missed, changed: true });
    const [moved] = await rows<{ meta: Record<string, unknown> }>(
      admin(),
      sql`select meta from app.activities where lead_id = ${samLead} and subtype = 'stage_changed'
          order by occurred_at desc limit 1`,
    );
    expect(moved!.meta).toMatchObject({
      from: 'Booked',
      to: 'Missed',
      because: 'It ends without them',
    });
    // Missed → Booked is back up the pipeline: the funnel's rule may do that; HandsFreeOS on its own may not.
    await expectHfos(
      () => sys(a, leadMoveStage, { workspaceId: a.wsId, leadId: samLead, stageId: stage.booked }),
      'rule_violation',
      'forward_only',
    );
    await sys(a, funnelMovePerson, {
      workspaceId: a.wsId,
      funnelPersonId: samRow,
      stageId: stage.booked,
      moveId: 'vrebook',
    });
    expect(await leadOf(samLead)).toEqual({ stage_id: stage.booked, status: 'open' });
    await expectHfos(
      () =>
        sys(a, funnelMovePerson, {
          workspaceId: a.wsId,
          funnelPersonId: samRow,
          stageId: stage.after,
          moveId: 'vrebook',
        }),
      'rule_violation',
      'funnel_move_refused',
    );
    // A person's own move can't claim to be the funnel's.
    await expectHfos(
      () =>
        run(
          leadMoveStage,
          { workspaceId: a.wsId, leadId: samLead, stageId: stage.at, funnelId },
          a.owner,
        ),
      'validation',
    );
  });

  it('lets the teammate move them on by what they wrote, in its own conversation', async () => {
    samConversation = await aiConversation(a, sam);
    await sys(a, funnelMovePerson, {
      workspaceId: a.wsId,
      funnelPersonId: samRow,
      stageId: stage.at,
      moveId: 'vjoined',
    });
    await sys(a, funnelMovePerson, {
      workspaceId: a.wsId,
      funnelPersonId: samRow,
      stageId: stage.after,
      moveId: 'vended',
    });
    // It moves only by the reply moves.
    await expectHfos(
      () =>
        asAva(a, samConversation, funnelMovePerson, {
          workspaceId: a.wsId,
          funnelPersonId: samRow,
          stageId: stage.missed,
          moveId: 'vrebook',
        }),
      'rule_violation',
      'funnel_move_refused',
    );
    const moved = await asAva(a, samConversation, funnelMovePerson, {
      workspaceId: a.wsId,
      funnelPersonId: samRow,
      stageId: stage.interested,
      moveId: 'vyes',
      because: 'Said “I’m in, what’s next?”',
    });
    expect(moved.changed).toBe(true);
    const [line] = await rows<{ actor_type: string; meta: Record<string, unknown> }>(
      admin(),
      sql`select actor_type, meta from app.activities where lead_id = ${samLead} and subtype = 'stage_changed'
          order by occurred_at desc limit 1`,
    );
    expect(line).toMatchObject({
      actor_type: 'ai_employee',
      meta: { to: 'Interested', because: 'Said “I’m in, what’s next?”' },
    });
    // Someone else's customer is beyond its conversation.
    const other = await customer(a, 'Riley');
    const riley = await run(
      funnelAddPerson,
      { workspaceId: a.wsId, funnelId, personId: other },
      a.owner,
    );
    await expectHfos(
      () =>
        asAva(a, samConversation, funnelMovePerson, {
          workspaceId: a.wsId,
          funnelPersonId: riley.funnelPersonId,
          stageId: stage.funnel,
          moveId: 'vopened',
        }),
      'forbidden',
    );
  });

  it('pauses for a person, and picks up again only as it was paused', async () => {
    const paused = await run(
      funnelPausePerson,
      { workspaceId: a.wsId, funnelPersonId: samRow, paused: true },
      a.member,
    );
    expect(paused).toEqual({ funnelPersonId: samRow, status: 'paused', changed: true });
    expect(await funnelRow(samRow)).toMatchObject({ paused_reason: 'by_hand' });
    // Handing the conversation back doesn't pick up what a person paused.
    expect(
      await sys(a, funnelPausePerson, {
        workspaceId: a.wsId,
        funnelPersonId: samRow,
        paused: false,
      }),
    ).toMatchObject({ status: 'paused', changed: false });
    // Paused, nothing moves them on.
    expect(
      await sys(a, funnelMovePerson, {
        workspaceId: a.wsId,
        funnelPersonId: samRow,
        stageId: stage.call,
        moveId: 'vthree',
      }),
    ).toMatchObject({ changed: false });
    await run(
      funnelPausePerson,
      { workspaceId: a.wsId, funnelPersonId: samRow, paused: false },
      a.member,
    );
    await sys(a, funnelPausePerson, {
      workspaceId: a.wsId,
      funnelPersonId: samRow,
      paused: true,
      reason: 'taken_over',
    });
    expect(await funnelRow(samRow)).toMatchObject({
      status: 'paused',
      paused_reason: 'taken_over',
    });
    await sys(a, funnelPausePerson, { workspaceId: a.wsId, funnelPersonId: samRow, paused: false });
    expect(await funnelRow(samRow)).toMatchObject({ status: 'active', paused_reason: null });
    expect(await eventsOf(a, 'funnel.paused_for_person')).toHaveLength(2);
    expect(await eventsOf(a, 'funnel.resumed_for_person')).toHaveLength(2);
    await expectHfos(
      () =>
        run(
          funnelPausePerson,
          { workspaceId: a.wsId, funnelPersonId: samRow, paused: true, reason: 'taken_over' },
          a.member,
        ),
      'validation',
    );
  });

  it('shows where they are and what’s next', async () => {
    const { current, canJoin } = await ask(
      funnelOfPerson,
      { workspaceId: a.wsId, personId: sam },
      a.member,
    );
    expect(current).toMatchObject({
      id: samRow,
      funnelName: 'Recruiting',
      stageName: 'Interested',
      status: 'active',
      next: [{ messageId: 'mleader', wording: 'ai' }],
    });
    expect(canJoin).toEqual([]);
    const people = await ask(
      funnelPeopleList,
      { workspaceId: a.wsId, funnelId, stageId: stage.interested },
      a.member,
    );
    expect(people.people.map((p) => p.personId)).toEqual([sam]);
    const { funnels } = await ask(funnelList, { workspaceId: a.wsId }, a.member);
    const recruiting = funnels.find((f) => f.id === funnelId)!;
    expect(recruiting).toMatchObject({
      status: 'on',
      people: 2,
      paused: 0,
      updatedBy: 'Christina Owner',
    });
    expect(recruiting.stages.find((s) => s.id === stage.interested)).toMatchObject({
      people: 1,
      inFunnel: true,
    });
  });

  it('takes them out at a won stage', async () => {
    await sys(a, funnelMovePerson, {
      workspaceId: a.wsId,
      funnelPersonId: samRow,
      stageId: stage.call,
      moveId: 'vthree',
    });
    expect(await leadOf(samLead)).toEqual({ stage_id: stage.call, status: 'won' });
    expect(await funnelRow(samRow)).toMatchObject({ status: 'left', left_reason: 'won' });
    expect((await eventsOf(a, 'funnel.person_left')).at(-1)!.payload).toMatchObject({
      funnelPersonId: samRow,
      reason: 'won',
    });
  });
});

describe('the teammate’s suggestions', () => {
  it('waits for a person’s yes, which puts them in; a no is kept', async () => {
    const jo = await customer(a, 'Jo');
    const conv = await aiConversation(a, jo);
    const s1 = await asAva(a, conv, funnelSuggest, {
      workspaceId: a.wsId,
      funnelId,
      personId: jo,
      why: 'Asked about working from home.',
    });
    expect(s1.already).toBe(false);
    expect(
      await asAva(a, conv, funnelSuggest, {
        workspaceId: a.wsId,
        funnelId,
        personId: jo,
        why: 'Again.',
      }),
    ).toEqual({ funnelPersonId: s1.funnelPersonId, already: true });
    const waiting = await ask(funnelSuggestionList, { workspaceId: a.wsId }, a.member);
    expect(waiting.suggestions.map((s) => [s.personId, s.suggestedWhy])).toEqual([
      [jo, 'Asked about working from home.'],
    ]);
    const yes = await run(
      funnelDecideSuggestion,
      { workspaceId: a.wsId, funnelPersonId: s1.funnelPersonId, accept: true },
      a.member,
    );
    expect(yes).toEqual({ funnelPersonId: s1.funnelPersonId, status: 'active' });
    expect(await funnelRow(s1.funnelPersonId!)).toMatchObject({
      status: 'active',
      stage_id: stage.new,
    });

    const lee = await customer(a, 'Lee');
    const conv2 = await aiConversation(a, lee);
    const s2 = await asAva(a, conv2, funnelSuggest, {
      workspaceId: a.wsId,
      funnelId,
      personId: lee,
      why: 'Fits.',
    });
    await run(
      funnelDecideSuggestion,
      { workspaceId: a.wsId, funnelPersonId: s2.funnelPersonId, accept: false },
      a.member,
    );
    expect(await funnelRow(s2.funnelPersonId!)).toMatchObject({ status: 'declined' });
    expect(
      await asAva(a, conv2, funnelSuggest, {
        workspaceId: a.wsId,
        funnelId,
        personId: lee,
        why: 'Fits.',
      }),
    ).toEqual({ funnelPersonId: null, already: true });
  });
});

describe('one funnel at a time', () => {
  it('leaves the funnel they’re in to join another; the database holds one', async () => {
    const [sales] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.pipelines where workspace_id = ${a.wsId} and id <> ${pipelineId} limit 1`,
    );
    const second = await run(
      funnelCreate,
      { workspaceId: a.wsId, name: 'Customers', pipelineId: sales!.id },
      a.owner,
    );
    await run(funnelTurnOn, { workspaceId: a.wsId, funnelId: second.funnelId }, a.owner);
    const kim = await customer(a, 'Kim');
    const first = await run(
      funnelAddPerson,
      { workspaceId: a.wsId, funnelId, personId: kim },
      a.owner,
    );
    const moved = await run(
      funnelAddPerson,
      { workspaceId: a.wsId, funnelId: second.funnelId, personId: kim },
      a.owner,
    );
    expect(await funnelRow(first.funnelPersonId)).toMatchObject({
      status: 'left',
      left_reason: 'other_funnel',
    });
    expect(await funnelRow(moved.funnelPersonId)).toMatchObject({ status: 'active' });
    await expect(
      rows(
        admin(),
        sql`insert into app.funnel_people (workspace_id, funnel_id, person_id, lead_id, stage_id, status)
            values (${a.wsId}, ${funnelId}, ${kim}, ${first.leadId}, ${stage.new}, 'active')`,
      ),
    ).rejects.toThrow();
    await run(
      funnelRemovePerson,
      { workspaceId: a.wsId, funnelPersonId: moved.funnelPersonId },
      a.member,
    );
    expect(await funnelRow(moved.funnelPersonId)).toMatchObject({
      status: 'left',
      left_reason: 'removed',
    });
  });

  it('takes in the leads already there when it’s turned on with them', async () => {
    const ray = await customer(a, 'Ray');
    await run(
      leadCreate,
      { workspaceId: a.wsId, title: 'Ray', personId: ray, pipelineId, stageId: stage.funnel },
      a.owner,
    );
    const got = await ask(funnelGet, { workspaceId: a.wsId, funnelId }, a.owner);
    expect(got.waiting).toBeGreaterThanOrEqual(1);
    const on = await run(
      funnelTurnOn,
      { workspaceId: a.wsId, funnelId, addExisting: true },
      a.owner,
    );
    expect(on.adding).toBe(got.waiting);
    // The worker adds them; HandsFreeOS may, by "turn_on".
    const added = await sys(a, funnelAddPerson, {
      workspaceId: a.wsId,
      funnelId,
      personId: ray,
      addedBy: 'turn_on',
    });
    expect(added.stageId).toBe(stage.funnel);
  });
});

describe('taking a stage out', () => {
  it('asks where its people go, then moves their leads there', async () => {
    const dee = await customer(a, 'Dee');
    const row = await run(
      funnelAddPerson,
      { workspaceId: a.wsId, funnelId, personId: dee, stageId: stage.missed },
      a.owner,
    );
    expect(await leadOf(row.leadId)).toMatchObject({ stage_id: stage.missed });
    const def = christinaFunnel(stage);
    def.stages = def.stages.filter((s) => s.stageId !== stage.missed);
    def.stages.find((s) => s.stageId === stage.booked)!.moves = def.stages
      .find((s) => s.stageId === stage.booked)!
      .moves.filter((m) => m.to !== stage.missed);
    const asked = await expectHfos(
      () => run(funnelSave, { workspaceId: a.wsId, funnelId, revision, definition: def }, a.owner),
      'rule_violation',
      'funnel_stage_has_people',
    );
    expect(asked.message).toBe(
      'Someone is at Missed, which you took out of the funnel. Pick the stage they go to instead, then save.',
    );
    const saved = await run(
      funnelSave,
      {
        workspaceId: a.wsId,
        funnelId,
        revision,
        definition: def,
        moveFrom: { [stage.missed]: stage.funnel },
      },
      a.owner,
    );
    revision = saved.revision;
    expect(await leadOf(row.leadId)).toMatchObject({ stage_id: stage.funnel });
    expect(await funnelRow(row.funnelPersonId)).toMatchObject({
      status: 'active',
      stage_id: stage.funnel,
    });
    // A move on the board to the stage it no longer uses takes them out.
    await run(
      leadMoveStage,
      { workspaceId: a.wsId, leadId: row.leadId, stageId: stage.missed },
      a.owner,
    );
    expect(await funnelRow(row.funnelPersonId)).toMatchObject({
      status: 'left',
      left_reason: 'outside',
    });
  });
});

describe('another business', () => {
  it('sees none of it', async () => {
    await expectHfos(
      () => ask(funnelGet, { workspaceId: a.wsId, funnelId }, other.owner),
      'not_found',
    );
    await expectHfos(
      () => run(funnelAddPerson, { workspaceId: other.wsId, funnelId, personId: sam }, other.owner),
      'not_found',
    );
    const { funnels } = await ask(funnelList, { workspaceId: other.wsId }, other.owner);
    expect(funnels).toEqual([]);
  });
});

describe('archiving it', () => {
  it('takes everyone out, and frees its name and its pipeline', async () => {
    const before = await ask(funnelList, { workspaceId: a.wsId }, a.owner);
    const inIt = before.funnels.find((f) => f.id === funnelId)!.people;
    expect(inIt).toBeGreaterThan(0);
    await run(funnelPause, { workspaceId: a.wsId, funnelId }, a.owner);
    const archived = await run(funnelArchive, { workspaceId: a.wsId, funnelId }, a.owner);
    expect(archived).toEqual({ funnelId, left: inIt });
    const [{ n }] = (await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.funnel_people where funnel_id = ${funnelId} and status in ('active', 'paused', 'suggested')`,
    )) as [{ n: number }];
    expect(n).toBe(0);
    await expectHfos(() => ask(funnelGet, { workspaceId: a.wsId, funnelId }, a.owner), 'not_found');
    const again = await run(
      funnelCreate,
      { workspaceId: a.wsId, name: 'Recruiting', pipelineId },
      a.owner,
    );
    expect(again.pipelineId).toBe(pipelineId);
  });
});
