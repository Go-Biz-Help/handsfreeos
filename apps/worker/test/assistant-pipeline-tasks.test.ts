/**
 * The Assistant on Pipeline and Tasks, against the real database: leads a page at a time (by pipeline and by words),
 * with their value to the cent; a lead moved up or down within its own stage, as dragging its card does; the board read
 * as its header and columns show it; a task due on a day (all day, at noon where the business is) or at a time, a
 * lead's task put on its company too, a done task reopened, and the Tasks page's groups. Every change runs as the
 * person "via Assistant".
 */
import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  companyCreate,
  executeCommand,
  leadCreate,
  organizationCreate,
  personCreate,
  pipelineCreate,
  taskComplete,
  taskCreate,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ToolContext } from '../src/assistant/runtime';
import { allScreenReadTools } from '../src/assistant/tools-screen-reads';
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
/** Pine Clinic's lead, worth $4,312.50. */
let pineLead: string;
let commercial: string;
let commercialLead: string;

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
/** A local date in Chicago, so many days from today: "2026-11-09". */
const dayFromNow = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: CHI }).format(
    new Date(Date.now() + days * 86_400_000),
  );
/** A lead's stage and place, as the board orders it. */
const stageOf = (leadId: string) =>
  one<{ stage_id: string }>(sql`select stage_id from app.leads where id = ${leadId}`);
const orderIn = async (stageId: string) =>
  (
    await rows<{ id: string }>(
      admin(),
      sql`select id from app.leads where stage_id = ${stageId} and archived_at is null
          order by position, created_at, id`,
    )
  ).map((r) => r.id);

beforeAll(async () => {
  dale = await createTestUser('apipe-dale', { fullName: 'Dale Owner' });
  const org = await run(
    organizationCreate,
    { businessName: `Pipeline HVAC ${randomUUID().slice(0, 8)}`, timezone: CHI },
    dale,
  );
  workspaceId = org.workspaceId;
  organizationId = org.organizationId;
  jo = (await run(personCreate, { workspaceId, firstName: 'Jo', lastName: 'Park' }, dale)).personId;
  pine = (await run(companyCreate, { workspaceId, name: 'Pine Clinic' }, dale)).companyId;
  pineLead = (
    await run(
      leadCreate,
      { workspaceId, title: 'Clinic rooftop unit', companyId: pine, valueCents: 431_250 },
      dale,
    )
  ).leadId;
  for (const title of ['Attic insulation', 'Duct cleaning', 'Thermostat swap'])
    await run(leadCreate, { workspaceId, title, personId: jo, valueCents: 50_000 }, dale);
  commercial = (await run(pipelineCreate, { workspaceId, name: 'Commercial' }, dale)).pipelineId;
  commercialLead = (
    await run(
      leadCreate,
      { workspaceId, title: 'Warehouse heaters', companyId: pine, pipelineId: commercial },
      dale,
    )
  ).leadId;
}, 60_000);
afterAll(closeTestDbs);

describe('leads, a page at a time', () => {
  it('says how many it shows and that more wait, never a total', async () => {
    const first = await read('list_leads', { limit: 2 });
    expect(first.shown).toBe(2);
    expect(first.more).toBe(true);
    expect(first).not.toHaveProperty('count');
    const next = await read('list_leads', { limit: 2, cursor: first.nextCursor });
    const seen = [...first.leads, ...next.leads].map((l: { id: string }) => l.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('finds them by pipeline and by words, with the value to the cent', async () => {
    const inCommercial = await read('list_leads', { pipelineId: commercial });
    expect(inCommercial.leads.map((l: { id: string }) => l.id)).toEqual([commercialLead]);
    const byWords = await read('list_leads', { query: 'rooftop' });
    expect(byWords.leads).toEqual([
      expect.objectContaining({ id: pineLead, value: '$4,312.50', customer: 'Pine Clinic' }),
    ]);
  });
});

describe('moving a lead within its stage', () => {
  it('puts it at the top, or after another lead of that stage, as dragging its card does', async () => {
    const { stage_id: stage } = await stageOf(pineLead);
    const before = await orderIn(stage);
    const last = before.at(-1)!;
    const { card, result } = await prepare('move_lead', {
      leadId: last,
      stageId: stage,
      afterLeadId: null,
    });
    expect(card.title).toMatch(/^Move this lead within /);
    expect(field(card, 'Place')).toMatch(/^At the top of /);
    expect(card.stageFrom).toBe(null);
    expect(result['place']).toMatch(/^At the top of /);
    // Nothing moves until Confirm.
    expect(await orderIn(stage)).toEqual(before);
    await commit('move_lead', { leadId: last, stageId: stage, afterLeadId: null });
    expect((await orderIn(stage))[0]).toBe(last);

    // After another: right behind it.
    const [top, second] = await orderIn(stage);
    await commit('move_lead', { leadId: top!, stageId: stage, afterLeadId: second! });
    expect((await orderIn(stage)).slice(0, 2)).toEqual([second, top]);
  });

  it('still says nothing would change without a place, and refuses a lead of another stage', async () => {
    const { stage_id: stage } = await stageOf(pineLead);
    await expect(prepare('move_lead', { leadId: pineLead, stageId: stage })).rejects.toThrow(
      /already in .*give afterLeadId/,
    );
    await expect(
      prepare('move_lead', { leadId: pineLead, stageId: stage, afterLeadId: commercialLead }),
    ).rejects.toThrow(/Warehouse heaters is in another pipeline/);
  });
});

describe('the pipeline board', () => {
  it('reads every stage’s count and value first, then only the first cards of each', async () => {
    const { stage_id: stage } = await stageOf(pineLead);
    for (let i = 0; i < 4; i += 1)
      await run(
        leadCreate,
        {
          workspaceId,
          title: `Furnace tune-up ${i}`,
          personId: jo,
          valueCents: 10_000,
          ...(i === 0 ? { source: 'Referral' } : {}),
        },
        dale,
      );
    const board = allScreenReadTools().find((t) => t.name === 'read_lead_board')!;
    const out = (await tools().run(board, board.input.parse({}) as never, ctx())) as {
      result: { data: Record<string, unknown> };
    };
    const data = out.result.data as {
      openLeads: number;
      openValue: string;
      stages: {
        id: string;
        kind: string;
        count: number;
        value: string;
        leads: Record<string, unknown>[];
        notListed?: number;
      }[];
    };
    const first = data.stages.find((s) => s.id === stage)!;
    // The rooftop unit, three for Jo and four tune-ups.
    expect(first.count).toBe(8);
    expect(first.value).toBe('$6,212.50');
    expect(first.leads).toHaveLength(5);
    expect(first.notListed).toBe(3);
    expect(Object.keys(first.leads[0]!).sort()).toEqual(
      expect.arrayContaining(['id', 'title', 'customer', 'value', 'daysInStage']),
    );
    expect(first.leads[0]).not.toHaveProperty('tags');
    // Won and Lost are there with their counts, and the header's open total.
    expect(data.stages.map((s) => s.kind)).toEqual(expect.arrayContaining(['won', 'lost']));
    expect(data.openLeads).toBe(8);
    expect(data.openValue).toBe('$6,212.50');

    // Asking for more of one stage lists more of it.
    const more = (await tools().run(
      board,
      board.input.parse({ shown: [{ stageId: stage, limit: 100 }] }) as never,
      ctx(),
    )) as { result: { data: { stages: { id: string; leads: Record<string, unknown>[] }[] } } };
    const all = more.result.data.stages.find((s) => s.id === stage)!.leads;
    expect(all).toHaveLength(8);
    // A card says where the lead came from, as the phone's card does.
    expect(all.find((l) => l['title'] === 'Furnace tune-up 0')).toMatchObject({
      source: 'Referral',
      value: '$100',
    });
  });
});

describe('tasks due on a day or at a time', () => {
  const taskRow = (id: string) =>
    one<{
      all_day: boolean;
      due_at: Date | null;
      person_id: string | null;
      company_id: string | null;
    }>(sql`select all_day, due_at, person_id, company_id from app.tasks where id = ${id}`);

  it('makes a date alone all day, kept at noon where the business is, and says so without a time', async () => {
    const out = await tools().run(
      tool('create_task'),
      argsOf('create_task', { title: 'Order the filters', dueAt: '2026-11-13' }),
      ctx(),
    );
    const taskId = (out.record as { taskId: string }).taskId;
    const row = await taskRow(taskId);
    expect(row.all_day).toBe(true);
    // Noon in Chicago, six hours behind UTC in November.
    expect(new Date(row.due_at!).toISOString()).toBe('2026-11-13T18:00:00.000Z');
    expect((out.result as { due: string }).due).toBe('Fri, Nov 13, all day');
    expect(out.card?.type === 'done' && out.card.detail).not.toMatch(/12:00/);

    // A time makes it due then; a date again makes it all day.
    await tools().run(
      tool('update_task'),
      argsOf('update_task', { taskId, dueAt: '2026-11-13T09:30:00-06:00' }),
      ctx(),
    );
    expect(await taskRow(taskId)).toMatchObject({ all_day: false });
    await tools().run(
      tool('update_task'),
      argsOf('update_task', { taskId, dueAt: '2026-11-16' }),
      ctx(),
    );
    const moved = await taskRow(taskId);
    expect(moved.all_day).toBe(true);
    expect(new Date(moved.due_at!).toISOString()).toBe('2026-11-16T18:00:00.000Z');
  });

  it('puts a lead’s task on the lead’s company too, as the lead’s own New task does', async () => {
    const out = await tools().run(
      tool('create_task'),
      argsOf('create_task', { title: 'Send the clinic a quote', leadId: pineLead }),
      ctx(),
    );
    expect(await taskRow((out.record as { taskId: string }).taskId)).toMatchObject({
      company_id: pine,
      person_id: null,
    });
  });
});

describe('reopening a task and the Tasks page’s groups', () => {
  let later: string;
  let thisWeek: string;
  let undated: string;

  beforeAll(async () => {
    const make = async (title: string, day: string | null) =>
      (
        await run(
          taskCreate,
          {
            workspaceId,
            title,
            assigneeUserId: dale.id,
            allDay: true,
            dueAt: day ? `${day}T18:00:00.000Z` : null,
          },
          dale,
        )
      ).taskId;
    later = await make('Renew the van insurance', dayFromNow(30));
    thisWeek = await make('Restock the truck', dayFromNow(3));
    undated = await make('Clean the shop', null);
  });

  it('reads one group at a time, This week without today or what’s overdue', async () => {
    const ids = async (due: string) =>
      (await read('list_tasks', { due })).tasks.map((t: { id: string }) => t.id);
    expect(await ids('later')).toContain(later);
    expect(await ids('later')).not.toContain(thisWeek);
    expect(await ids('week')).toEqual(expect.arrayContaining([thisWeek]));
    expect(await ids('week')).not.toContain(later);
    expect(await ids('none')).toContain(undated);
    const { tasks } = await read('list_tasks', { due: 'none' });
    expect(tasks.find((t: { id: string }) => t.id === undated)).toMatchObject({
      due: 'No due date',
      group: 'No due date',
    });
  });

  it('reopens a done task, says who had done it, and Undo marks it done again', async () => {
    await run(taskComplete, { workspaceId, taskId: thisWeek }, dale);
    const done = await read('list_tasks', { status: 'done' });
    expect(done.tasks.find((t: { id: string }) => t.id === thisWeek)).toMatchObject({
      doneBy: 'Dale Owner',
      done: expect.any(String),
    });
    const out = await tools().run(
      tool('reopen_task'),
      argsOf('reopen_task', { taskId: thisWeek }),
      ctx(),
    );
    expect(out.card).toMatchObject({ type: 'done', title: 'Task reopened', undoable: true });
    const doneAt = () =>
      one<{ done_at: Date | null }>(sql`select done_at from app.tasks where id = ${thisWeek}`);
    expect((await doneAt()).done_at).toBe(null);
    expect(await tools().undo(tool('reopen_task'), out.record!, ctx())).toBe(
      'Undone. The task is done again.',
    );
    expect((await doneAt()).done_at).not.toBe(null);
  });

  it('leaves a task that is still open as it is, with nothing to undo', async () => {
    const out = await tools().run(
      tool('reopen_task'),
      argsOf('reopen_task', { taskId: later }),
      ctx(),
    );
    expect(out.card).toMatchObject({
      type: 'done',
      detail: 'Already open, so nothing changed',
      undoable: false,
    });
    expect(out.result).toMatchObject({ open: true, note: 'It was already open.' });
    // Undo never ticks off a task that was open all along.
    await expect(tools().undo(tool('reopen_task'), out.record!, ctx())).rejects.toThrow(
      /nothing to undo/,
    );
    const row = await one<{ done_at: Date | null }>(
      sql`select done_at from app.tasks where id = ${later}`,
    );
    expect(row.done_at).toBe(null);
  });
});
