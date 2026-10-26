/**
 * Contacts' filter between leads and clients: a client has a won lead, a job underway or done, a visit they came to,
 * a plan they're on, or a paid bill, or is tagged Client (any capitals, decision 91 of docs/outreach.md); everyone else
 * is a lead. A company is a client through a lead of its own that was won, or through one of its people.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { personClientCause } from '../src/crm/clients';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  companyCreate,
  companyList,
  invoiceCreate,
  invoiceRecordCashPayment,
  invoiceSend,
  leadCreate,
  leadMoveStage,
  organizationCreate,
  personCreate,
  personList,
  pipelineList,
  recordAddTag,
  recordRemoveTag,
  tagCreate,
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

  // Tagged Client, in the business's own capitals: Tia is a client for that alone, and Pat, who paid, too.
  ids.clientTag = (await run(tagCreate, { workspaceId: wsId, name: 'CLIENT' }, owner)).tagId;
  ids.tia = await person('Tia');
  for (const personId of [ids.tia, ids.pat])
    await run(
      recordAddTag,
      { workspaceId: wsId, recordType: 'person', recordId: personId, tagId: ids.clientTag },
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
      Tia: true,
      Wes: true,
    });
    const clients = await ask(
      personList,
      { workspaceId: wsId, q: 'standing', standing: 'client' },
      owner,
    );
    expect(names(clients.items)).toEqual(['Ann', 'Jo', 'Pat', 'Tia', 'Wes']);
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
    const third = await ask(
      personList,
      { workspaceId: wsId, standing: 'client', limit: 2, cursor: second.nextCursor! },
      owner,
    );
    expect(names([...first.items, ...second.items, ...third.items])).toEqual([
      'Ann',
      'Jo',
      'Pat',
      'Tia',
      'Wes',
    ]);
    expect(third.nextCursor).toBeNull();
  });

  it('makes someone tagged Client a client until the tag comes off', async () => {
    const standing = async () =>
      Object.fromEntries(
        (await ask(personList, { workspaceId: wsId, q: 'standing' }, owner)).items.map((p) => [
          p.firstName,
          p.client,
        ]),
      );
    expect((await standing()).Tia).toBe(true);
    await run(
      recordRemoveTag,
      { workspaceId: wsId, recordType: 'person', recordId: ids.tia, tagId: ids.clientTag },
      owner,
    );
    expect((await standing()).Tia).toBe(false);
    const leads = await ask(
      personList,
      { workspaceId: wsId, q: 'standing', standing: 'lead' },
      owner,
    );
    expect(names(leads.items)).toContain('Tia');
    await run(
      recordAddTag,
      { workspaceId: wsId, recordType: 'person', recordId: ids.tia, tagId: ids.clientTag },
      owner,
    );
    expect((await standing()).Tia).toBe(true);
  });

  it('names the first reason someone is a client: a paid bill before the tag', async () => {
    const cause = async (personId: string) =>
      (
        await rows<{ cause: string | null }>(
          admin(),
          sql`select ${personClientCause('p')} as cause from app.people p where p.id = ${personId}`,
        )
      )[0]?.cause;
    expect(await cause(ids.pat)).toBe('paid');
    expect(await cause(ids.tia)).toBe('tagged');
    expect(await cause(ids.wes)).toBe('won');
    expect(await cause(ids.lena)).toBeNull();
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
