/**
 * Contacts' filter between leads and clients: a client has a won lead, a job underway or done, a visit they came to,
 * a plan they're on, or a paid bill; everyone else is a lead. A company is a client through a lead of its own that was
 * won, or through one of its people.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  companyCreate,
  companyList,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  leadArchive,
  leadCreate,
  leadMoveStage,
  organizationCreate,
  personCreate,
  personList,
  pipelineList,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
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

let owner: TestUser;
let wsId: string;
const ids: Record<string, string> = {};

const person = async (firstName: string, companyId?: string) =>
  (
    await run(
      personCreate,
      {
        workspaceId: wsId,
        firstName,
        lastName: 'Standing',
        email: `${firstName.toLowerCase()}@example.com`,
        companyId,
      },
      owner,
    )
  ).personId;

const job = (personId: string, status: string) =>
  rows(
    admin(),
    sql`insert into app.jobs (workspace_id, person_id, title, status) values (${wsId}, ${personId}, 'Tune-up', ${status})`,
  );

beforeAll(async () => {
  owner = await createTestUser('standing-owner');
  wsId = (await run(organizationCreate, { businessName: 'Standing Test HVAC' }, owner)).workspaceId;
  const { pipelines } = await ask(pipelineList, { workspaceId: wsId }, owner);
  const stages = pipelines[0]!.stages;
  const won = stages.find((s) => s.kind === 'won')!.id;

  // Leads: nobody has done anything for them yet, and a job only booked may still be a quote visit.
  ids.lena = await person('Lena');
  await run(leadCreate, { workspaceId: wsId, title: 'New AC', personId: ids.lena }, owner);
  ids.otto = await person('Otto');
  await job(ids.otto, 'scheduled');

  // Clients: a won lead, a job done, a paid bill.
  ids.wes = await person('Wes');
  const lead = await run(
    leadCreate,
    { workspaceId: wsId, title: 'Duct clean', personId: ids.wes },
    owner,
  );
  await run(leadMoveStage, { workspaceId: wsId, leadId: lead.leadId, stageId: won }, owner);
  ids.jo = await person('Jo');
  await job(ids.jo, 'done');
  ids.pat = await person('Pat');
  const bill = await run(
    invoiceCreate,
    {
      workspaceId: wsId,
      personId: ids.pat,
      title: 'Repair',
      lines: [{ name: 'Repair', quantity: 1, unitPriceCents: 20_000, taxable: false }],
    },
    owner,
  );
  await run(invoiceSend, { workspaceId: wsId, invoiceId: bill.invoiceId }, owner);
  await run(
    invoiceRecordCashPayment,
    { workspaceId: wsId, invoiceId: bill.invoiceId, amountCents: 5_000 },
    owner,
  );

  // Companies: one through a client of its, one through a won lead of its own, and one still a lead.
  ids.acme = (
    await run(companyCreate, { workspaceId: wsId, name: 'Acme Standing' }, owner)
  ).companyId;
  ids.ann = await person('Ann', ids.acme);
  await job(ids.ann, 'in_progress');
  ids.bolt = (
    await run(companyCreate, { workspaceId: wsId, name: 'Bolt Standing' }, owner)
  ).companyId;
  const bolt = await run(
    leadCreate,
    { workspaceId: wsId, title: 'Rooftop units', companyId: ids.bolt },
    owner,
  );
  await run(leadMoveStage, { workspaceId: wsId, leadId: bolt.leadId, stageId: won }, owner);
  ids.cove = (
    await run(companyCreate, { workspaceId: wsId, name: 'Cove Standing' }, owner)
  ).companyId;
  await person('Cy', ids.cove);
});
afterAll(closeTestDbs);

const names = (items: { firstName?: string; name?: string }[]) =>
  items.map((i) => i.firstName ?? i.name).sort();

describe('leads and clients', () => {
  it('splits people into leads and clients, and says which each one is', async () => {
    const all = await ask(personList, { workspaceId: wsId, q: 'standing' }, owner);
    expect(Object.fromEntries(all.items.map((p) => [p.firstName, p.client]))).toEqual({
      Ann: true,
      Cy: false,
      Jo: true,
      Lena: false,
      Otto: false,
      Pat: true,
      Wes: true,
    });
    const clients = await ask(
      personList,
      { workspaceId: wsId, q: 'standing', standing: 'client' },
      owner,
    );
    expect(names(clients.items)).toEqual(['Ann', 'Jo', 'Pat', 'Wes']);
    const leads = await ask(
      personList,
      { workspaceId: wsId, q: 'standing', standing: 'lead' },
      owner,
    );
    expect(names(leads.items)).toEqual(['Cy', 'Lena', 'Otto']);
  });

  it('pages through clients with the usual cursor', async () => {
    const first = await ask(personList, { workspaceId: wsId, standing: 'client', limit: 2 }, owner);
    const second = await ask(
      personList,
      { workspaceId: wsId, standing: 'client', limit: 2, cursor: first.nextCursor! },
      owner,
    );
    expect(names([...first.items, ...second.items])).toEqual(['Ann', 'Jo', 'Pat', 'Wes']);
    expect(second.nextCursor).toBeNull();
  });

  it('makes a company a client through its people or a won lead of its own', async () => {
    const all = await ask(companyList, { workspaceId: wsId, q: 'standing' }, owner);
    expect(Object.fromEntries(all.items.map((c) => [c.name, c.client]))).toEqual({
      'Acme Standing': true,
      'Bolt Standing': true,
      'Cove Standing': false,
    });
    const clients = await ask(companyList, { workspaceId: wsId, standing: 'client' }, owner);
    expect(names(clients.items)).toEqual(['Acme Standing', 'Bolt Standing']);
    const leads = await ask(companyList, { workspaceId: wsId, standing: 'lead' }, owner);
    expect(names(leads.items)).toEqual(['Cove Standing']);
  });
});

describe('the marks the database keeps', () => {
  const q = <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    rows<T>(admin(), query);
  const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await q<T>(query))[0]!;
  const marked = async (id: string) =>
    (await q(sql`select 1 from app.client_marks where id = ${id}`)).length === 1;
  const someone = async (firstName: string, companyId: string | null = null) =>
    (
      await one<{ id: string }>(
        sql`insert into app.people (workspace_id, first_name, last_name, company_id)
            values (${wsId}, ${firstName}, 'Marked', ${companyId}) returning id`,
      )
    ).id;

  it('comes and goes with a job', async () => {
    const mo = await someone('Mo');
    const { id } = await one<{ id: string }>(
      sql`insert into app.jobs (workspace_id, person_id, title) values (${wsId}, ${mo}, 'Repair') returning id`,
    );
    expect(await marked(mo)).toBe(false);
    await q(sql`update app.jobs set status = 'on_the_way' where id = ${id}`);
    expect(await marked(mo)).toBe(true);
    await q(sql`update app.jobs set status = 'cancelled' where id = ${id}`);
    expect(await marked(mo)).toBe(false);
  });

  it('follows a lead won, lost and archived', async () => {
    const { pipelines } = await ask(pipelineList, { workspaceId: wsId }, owner);
    const stage = (kind: string) => pipelines[0]!.stages.find((s) => s.kind === kind)!.id;
    const nia = await someone('Nia');
    const { leadId } = await run(
      leadCreate,
      { workspaceId: wsId, title: 'Heat pump', personId: nia },
      owner,
    );
    await run(leadMoveStage, { workspaceId: wsId, leadId, stageId: stage('won') }, owner);
    expect(await marked(nia)).toBe(true);
    await run(
      leadMoveStage,
      { workspaceId: wsId, leadId, stageId: stage('lost'), lostReason: 'Went elsewhere' },
      owner,
    );
    expect(await marked(nia)).toBe(false);
    await run(leadMoveStage, { workspaceId: wsId, leadId, stageId: stage('won') }, owner);
    await run(leadArchive, { workspaceId: wsId, leadId }, owner);
    expect(await marked(nia)).toBe(false);
  });

  it('marks someone who came to a visit, and not one who only booked it', async () => {
    const vi = await someone('Vi');
    const { id: calendar } = await one<{ id: string }>(
      sql`insert into app.calendars (workspace_id, name, slug, status)
          values (${wsId}, 'Visits', ${`visits-${randomUUID().slice(0, 8)}`}, 'active') returning id`,
    );
    const { id: visit } = await one<{ id: string }>(
      sql`insert into app.appointments (workspace_id, calendar_id, calendar_revision, title, starts_at, ends_at, source)
          values (${wsId}, ${calendar}, 1, 'Visit', now() - interval '2 hours', now() - interval '1 hour', 'staff')
          returning id`,
    );
    const { id: seat } = await one<{ id: string }>(
      sql`insert into app.appointment_attendees (workspace_id, appointment_id, person_id)
          values (${wsId}, ${visit}, ${vi}) returning id`,
    );
    expect(await marked(vi)).toBe(false);
    await q(sql`update app.appointments set status = 'completed' where id = ${visit}`);
    expect(await marked(vi)).toBe(true);
    await q(sql`update app.appointment_attendees set status = 'no_show' where id = ${seat}`);
    expect(await marked(vi)).toBe(false);
    await q(sql`update app.appointment_attendees set status = 'attended' where id = ${seat}`);
    expect(await marked(vi)).toBe(true);
  });

  it('marks someone on a plan while it runs', async () => {
    const pia = await someone('Pia');
    const { id } = await one<{ id: string }>(
      sql`insert into app.subscriptions (workspace_id, person_id, plan_name, price_cents)
          values (${wsId}, ${pia}, 'Comfort Club', 2900) returning id`,
    );
    expect(await marked(pia)).toBe(false);
    await q(sql`update app.subscriptions set status = 'active' where id = ${id}`);
    expect(await marked(pia)).toBe(true);
    await q(
      sql`update app.subscriptions set status = 'cancelled', cancelled_at = now() where id = ${id}`,
    );
    expect(await marked(pia)).toBe(false);
  });

  it('carries a company’s mark with the person who moves, and takes it away when they go', async () => {
    const { id: dune } = await one<{ id: string }>(
      sql`insert into app.companies (workspace_id, name) values (${wsId}, 'Dune Marked') returning id`,
    );
    const { id: elm } = await one<{ id: string }>(
      sql`insert into app.companies (workspace_id, name) values (${wsId}, 'Elm Marked') returning id`,
    );
    const kai = await someone('Kai', dune);
    await q(
      sql`insert into app.jobs (workspace_id, person_id, title, status) values (${wsId}, ${kai}, 'Install', 'done')`,
    );
    expect([await marked(dune), await marked(elm)]).toEqual([true, false]);
    await q(sql`update app.people set company_id = ${elm} where id = ${kai}`);
    expect([await marked(dune), await marked(elm)]).toEqual([false, true]);
    await q(sql`delete from app.jobs where person_id = ${kai}`);
    expect([await marked(kai), await marked(elm)]).toEqual([false, false]);
  });
});
