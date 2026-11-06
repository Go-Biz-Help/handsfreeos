/**
 * The Assistant on a customer's, company's, record's and lead's pages, against the real database: a call or a visit
 * logged after the fact on a pet; a lead opened for a company in a second pipeline, with its next step, expected
 * close and source; a lead renamed and its follow-up moved; a lead read in full with its qualifying answers; tasks
 * on a company and a pet, listed by the record they're on; one lead's money; and a text to another of a customer's
 * numbers. Every change shows its card first, changes nothing until Confirm, and runs as the person "via Assistant".
 */
import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  companyCreate,
  customRecordCreate,
  customRecordTypeCreate,
  estimateCreate,
  executeCommand,
  leadCreate,
  organizationCreate,
  personCreate,
  pipelineCreate,
  taskComplete,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor } from '../src/assistant/tools-write';

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
): Promise<z.output<O>> =>
  (
    await executeCommand(api(), cmd, input, actor(u), {
      correlationId: randomUUID(),
      channel: 'test',
    })
  ).output;

let dale: TestUser;
let workspaceId: string;
let organizationId: string;
let jo: string;
let pine: string;
let rex: string;
let joLead: string;
/** The Contacted stage of a second pipeline, Commercial. */
let commercialContacted: string;
let commercial: string;

const ctx = (): ToolContext => ({
  actor: actor(dale),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const tools = () => createToolExecutor(api());
const tool = (name: string) => assistantToolByName.get(name)!;
/** The arguments as the runtime hands them over: checked against the tool's input, defaults filled. */
const argsOf = (name: string, args: Record<string, unknown>) =>
  tool(name).input.parse(args) as Record<string, unknown>;
type Confirm = Extract<AssistantCard, { type: 'confirm' }>;
const prepare = async (name: string, args: Record<string, unknown>) =>
  (await tools().prepare(tool(name), argsOf(name, args), ctx(), randomUUID())) as {
    card: Confirm;
    result: Record<string, unknown>;
  };
const commit = (name: string, args: Record<string, unknown>) =>
  tools().commit(tool(name), argsOf(name, args), ctx(), { toolCallId: randomUUID() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (name: string, args: Record<string, unknown>): Promise<any> =>
  ((await tools().run(tool(name), argsOf(name, args), ctx())) as { result: unknown }).result;
const field = (card: { fields: { label: string; value: string }[] }, label: string) =>
  card.fields.find((f) => f.label === label)?.value;
const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
  (await rows<T>(admin(), query))[0]!;
const line = (name: string, cents: number) => ({
  productId: null,
  name,
  description: null,
  quantity: 1,
  unitLabel: 'each',
  unitPriceCents: cents,
  taxable: false,
  discountCents: 0,
});

beforeAll(async () => {
  dale = await createTestUser('acus-dale', { fullName: 'Dale Owner' });
  const org = await run(
    organizationCreate,
    { businessName: `Customers HVAC ${randomUUID().slice(0, 8)}`, timezone: CHI },
    dale,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  jo = (
    await run(
      personCreate,
      {
        workspaceId,
        firstName: 'Jo',
        lastName: 'Park',
        phone: '512-555-0170',
        otherPhones: [{ phone: '512-555-0177', label: 'Work' }],
      },
      dale,
    )
  ).personId;
  pine = (await run(companyCreate, { workspaceId, name: 'Pine Clinic' }, dale)).companyId;
  const pet = (await run(customRecordTypeCreate, { workspaceId, singular: 'Pet' }, dale))
    .customRecordTypeId;
  rex = (await run(customRecordCreate, { workspaceId, typeId: pet, name: 'Rex' }, dale))
    .customRecordId;
  joLead = (
    await run(
      leadCreate,
      { workspaceId, title: 'Water heater', personId: jo, valueCents: 250_000 },
      dale,
    )
  ).leadId;
  commercial = (await run(pipelineCreate, { workspaceId, name: 'Commercial' }, dale)).pipelineId;
  commercialContacted = (
    await one<{ id: string }>(
      sql`select id from app.pipeline_stages where pipeline_id = ${commercial} and name = 'Contacted'`,
    )
  ).id;
}, 60_000);
afterAll(closeTestDbs);

describe('notes, calls and visits', () => {
  it('logs a call after the fact on a pet, and Undo takes the call away', async () => {
    const out = await tools().run(
      tool('add_note'),
      argsOf('add_note', {
        kind: 'call',
        body: 'Talked through his shots',
        occurredAt: '2026-11-02T15:30:00-06:00',
        customRecordId: rex,
      }),
      ctx(),
    );
    expect(out.card).toMatchObject({
      type: 'done',
      title: 'Call on Rex',
      href: `/app/w/${workspaceId}/customers/records/${rex}`,
    });
    expect(out.card?.type === 'done' && out.card.detail).toMatch(/“Talked through his shots”$/);
    const activityId = (out.record as { activityId: string }).activityId;
    const row = await one<{ kind: string; custom_record_id: string; occurred_at: Date }>(
      sql`select kind::text as kind, custom_record_id, occurred_at from app.activities where id = ${activityId}`,
    );
    expect(row).toMatchObject({ kind: 'call', custom_record_id: rex });
    expect(new Date(row.occurred_at).toISOString()).toBe('2026-11-02T21:30:00.000Z');
    expect(await tools().undo(tool('add_note'), out.record!, ctx())).toBe(
      'Undone. The call is gone.',
    );
  });
});

describe('opening and changing a lead', () => {
  it('opens one for a company in another pipeline, with its next step, expected close and source', async () => {
    const args = {
      title: 'Clinic HVAC contract',
      companyId: pine,
      stageId: commercialContacted,
      value: 18_000,
      nextAction: 'Walk the building',
      nextActionAt: '2026-11-20T10:00:00-06:00',
      expectedCloseOn: '2026-12-15',
      source: 'Referral',
    };
    const { card } = await prepare('create_lead', args);
    expect(card.title).toBe('Open a lead for Pine Clinic?');
    expect(field(card, 'Company')).toBe('Pine Clinic');
    expect(field(card, 'Stage')).toBe('Contacted · Commercial');
    expect(field(card, 'Next')).toMatch(/^Walk the building · Fri, Nov 20/);
    expect(field(card, 'Expected close')).toBe('2026-12-15');
    expect(field(card, 'Source')).toBe('Referral');
    const none = await rows(
      admin(),
      sql`select id from app.leads where workspace_id = ${workspaceId} and title = 'Clinic HVAC contract'`,
    );
    expect(none).toEqual([]);

    await commit('create_lead', args);
    const lead = await one<{
      company_id: string;
      person_id: string | null;
      pipeline_id: string;
      stage_id: string;
      next_action_at: Date;
      expected_close_on: string;
      source: string;
    }>(
      sql`select company_id, person_id, pipeline_id, stage_id, next_action_at, expected_close_on::text, source
          from app.leads where workspace_id = ${workspaceId} and title = 'Clinic HVAC contract'`,
    );
    expect(lead).toMatchObject({
      company_id: pine,
      person_id: null,
      pipeline_id: commercial,
      stage_id: commercialContacted,
      expected_close_on: '2026-12-15',
      source: 'Referral',
    });
    expect(new Date(lead.next_action_at).toISOString()).toBe('2026-11-20T16:00:00.000Z');

    await expect(prepare('create_lead', { title: 'Nobody’s' })).rejects.toThrow(
      'Say who the lead is for',
    );
    await expect(
      prepare('create_lead', { title: 'Both', personId: jo, companyId: pine }),
    ).rejects.toThrow('Say who the lead is for');
  });

  it('renames it and changes its expected close and source, showing what they were', async () => {
    const args = {
      leadId: joLead,
      title: 'Tankless water heater',
      expectedCloseOn: '2026-12-01',
      source: 'Yard sign',
    };
    const { card } = await prepare('update_lead', args);
    expect(field(card, 'Title')).toBe('Water heater → Tankless water heater');
    expect(field(card, 'Expected close')).toBe('none → 2026-12-01');
    expect(field(card, 'Source')).toBe('none → Yard sign');
    await commit('update_lead', args);
    expect(
      await one(
        sql`select title, expected_close_on::text as close_on, source from app.leads where id = ${joLead}`,
      ),
    ).toEqual({ title: 'Tankless water heater', close_on: '2026-12-01', source: 'Yard sign' });
  });

  it('moves the follow-up’s time alone, keeping the step, and asks for a step when there is none', async () => {
    await expect(
      prepare('update_lead', { leadId: joLead, nextActionAt: '2026-11-21T09:00:00-06:00' }),
    ).rejects.toThrow('has no next step, so a time alone has nothing to go on');
    await commit('update_lead', { leadId: joLead, nextAction: 'Send the estimate' });
    const moved = { leadId: joLead, nextActionAt: '2026-11-21T09:00:00-06:00' };
    const { card } = await prepare('update_lead', moved);
    expect(field(card, 'Next')).toMatch(/^Send the estimate → Send the estimate · Sat, Nov 21/);
    await commit('update_lead', moved);
    const row = await one<{ next_action: string; next_action_at: Date }>(
      sql`select next_action, next_action_at from app.leads where id = ${joLead}`,
    );
    expect(row.next_action).toBe('Send the estimate');
    expect(new Date(row.next_action_at).toISOString()).toBe('2026-11-21T15:00:00.000Z');
  });
});

describe('a lead in full', () => {
  it('says when the follow-up is due, its details, and what the customer answered', async () => {
    await rows(
      admin(),
      sql`update app.leads set qualification = ${JSON.stringify({
        answers: {
          budget: {
            question: 'What’s your budget?',
            answer: 'About $3,000',
            answeredAt: '2026-11-01T15:00:00.000Z',
            by: 'ai',
            files: [],
          },
        },
        status: 'incomplete',
        missing: ['timing'],
        notAFit: [],
        qualifiedAt: null,
        updatedAt: '2026-11-01T15:00:00.000Z',
      })}::jsonb where id = ${joLead}`,
    );
    const { lead, qualification } = await read('get_lead', { leadId: joLead });
    expect(lead).toMatchObject({
      title: 'Tankless water heater',
      nextAction: 'Send the estimate',
      nextActionAt: expect.stringMatching(/^Sat, Nov 21/),
      expectedClose: '2026-12-01',
      source: 'Yard sign',
      tags: [],
      daysInStage: 0,
    });
    expect(qualification).toEqual({
      status: 'Incomplete: still missing answers',
      answers: [
        {
          question: 'What’s your budget?',
          answer: { customer_wrote: 'About $3,000' },
          by: 'the AI teammate',
          at: expect.stringMatching(/^Sun, Nov 1/),
        },
      ],
      // The question still to ask is named from the AI teammate's questions, and this business has none: the card
      // says how many instead.
      questionsStillToAsk: 1,
      stillToAsk: [],
      ruledOutBy: [],
    });
  });
});

describe('tasks on a company or a record', () => {
  it('adds them where they belong, and lists a record’s own, done ones too', async () => {
    const onPine = await tools().run(
      tool('create_task'),
      argsOf('create_task', { title: 'Send the clinic a quote', companyId: pine }),
      ctx(),
    );
    const onRex = await tools().run(
      tool('create_task'),
      argsOf('create_task', { title: 'Book Rex’s checkup', customRecordId: rex }),
      ctx(),
    );
    const rexTask = (onRex.record as { taskId: string }).taskId;
    expect(
      await one(
        sql`select company_id, custom_record_id from app.tasks where id = ${(onPine.record as { taskId: string }).taskId}`,
      ),
    ).toEqual({ company_id: pine, custom_record_id: null });

    const { tasks } = await read('list_tasks', { customRecordId: rex });
    expect(tasks).toEqual([
      expect.objectContaining({
        id: rexTask,
        title: 'Book Rex’s checkup',
        record: { id: rex, name: 'Rex', kind: 'Pet' },
      }),
    ]);
    expect((await read('list_tasks', { companyId: pine })).tasks).toEqual([
      expect.objectContaining({ title: 'Send the clinic a quote', company: 'Pine Clinic' }),
    ]);

    await run(taskComplete, { workspaceId, taskId: rexTask }, dale);
    expect((await read('list_tasks', { customRecordId: rex })).tasks).toEqual([]);
    expect((await read('list_tasks', { customRecordId: rex, status: 'done' })).tasks).toEqual([
      expect.objectContaining({ id: rexTask, done: expect.any(String) }),
    ]);
  });
});

describe('one lead’s money', () => {
  it('reads only what was quoted on the lead, as its Money card shows', async () => {
    await run(
      estimateCreate,
      {
        workspaceId,
        personId: jo,
        leadId: joLead,
        title: 'Tankless',
        lines: [line('Tankless unit', 300_000)],
      },
      dale,
    );
    await run(
      estimateCreate,
      { workspaceId, personId: jo, title: 'Filter swap', lines: [line('Filters', 9_000)] },
      dale,
    );
    const out = await tools().run(
      tool('customer_money'),
      argsOf('customer_money', { leadId: joLead }),
      ctx(),
    );
    const result = out.result as { lead: string; estimates: { total: string }[] };
    expect(result.lead).toBe('Tankless water heater');
    expect(result.estimates.map((e) => e.total)).toEqual(['$3,000']);
    expect(out.card).toMatchObject({
      title: 'Tankless water heater',
      href: `/app/w/${workspaceId}/leads/${joLead}`,
    });
    expect((await read('customer_money', { personId: jo })).estimates).toHaveLength(2);
    await expect(read('customer_money', {})).rejects.toThrow('Say whose money to look at');
  });
});

describe('texting another of their numbers', () => {
  it('shows the number on file it goes to, and won’t text one they don’t have', async () => {
    const { card } = await prepare('send_text', {
      personId: jo,
      to: '(512) 555-0177',
      body: 'Running late',
    });
    expect(field(card, 'To')).toBe('Jo Park · (512) 555-0177 · Work');
    // Their main number is the usual text.
    const main = await prepare('send_text', { personId: jo, to: '512-555-0170', body: 'Hi' });
    expect(field(main.card, 'To')).toBe('Jo Park · (512) 555-0170');
    await expect(
      prepare('send_text', { personId: jo, to: '512-555-0999', body: 'Hi' }),
    ).rejects.toThrow('isn’t one of Jo’s numbers');
  });
});
