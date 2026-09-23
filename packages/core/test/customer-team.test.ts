/**
 * More than one person on a customer (0101): an owner and a team beside them, assigned one person at a time, and
 * what being on a customer shows a member — the customer's money here, their threads in a narrowed inbox.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  companyCreate,
  companyGet,
  companyList,
  invoiceCreate,
  invoiceList,
  personCreate,
  personGet,
  personList,
  personUpdate,
  recordAssign,
  recordUnassign,
} from '../src/server';
import { admin, ask, expectHfos, run, setupTeam, type Team } from './calendar-helpers';

let t: Team;
let personId: string;
beforeAll(async () => {
  t = await setupTeam('customer-team');
  ({ personId } = await run(
    personCreate,
    { workspaceId: t.wsId, firstName: 'Client', lastName: 'Co', email: 'client@co.com' },
    t.owner,
  ));
});
afterAll(closeTestDbs);

const assign = (userId: string, main = false) =>
  run(
    recordAssign,
    { workspaceId: t.wsId, recordType: 'person', recordId: personId, userId, main },
    t.owner,
  );
const assigned = async () => {
  const { person } = await ask(personGet, { workspaceId: t.wsId, personId }, t.owner);
  return [person.owner?.fullName ?? null, person.team.map((m) => m.fullName)];
};

describe('assigning a customer', () => {
  it('makes the first person the owner and the next ones the team', async () => {
    expect((await assign(t.priya.id)).changed).toBe(true);
    const out = await assign(t.marco.id);
    expect(out.owner).toMatchObject({ id: t.priya.id });
    expect(out.team.map((m) => m.id)).toEqual([t.marco.id]);
    expect(await assigned()).toEqual(['Priya Tech', ['Marco Tech']]);
  });

  it('does nothing for someone already on it', async () => {
    expect((await assign(t.marco.id)).changed).toBe(false);
    expect((await assign(t.priya.id)).changed).toBe(false);
  });

  it('makes a teammate the owner and keeps the old owner on the customer', async () => {
    await assign(t.marco.id, true);
    expect(await assigned()).toEqual(['Marco Tech', ['Priya Tech']]);
  });

  it('refuses somebody who isn’t in the business', async () => {
    const [stranger] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.users where id not in (
            select user_id from app.workspace_access where workspace_id = ${t.wsId}) limit 1`,
    );
    await expectHfos(() => assign(stranger!.id), 'validation');
  });

  it('takes someone off, and taking the owner off makes the next teammate the owner', async () => {
    await assign(t.member.id);
    expect(await assigned()).toEqual(['Marco Tech', ['Priya Tech', 'Mike Member']]);
    await run(
      recordUnassign,
      { workspaceId: t.wsId, recordType: 'person', recordId: personId, userId: t.marco.id },
      t.owner,
    );
    expect(await assigned()).toEqual(['Priya Tech', ['Mike Member']]);
    const off = await run(
      recordUnassign,
      { workspaceId: t.wsId, recordType: 'person', recordId: personId, userId: t.marco.id },
      t.owner,
    );
    expect(off.changed).toBe(false);
  });

  it('never keeps the owner on the team, even when the old owner field names a teammate', async () => {
    await run(personUpdate, { workspaceId: t.wsId, personId, ownerUserId: t.member.id }, t.owner);
    expect(await assigned()).toEqual(['Mike Member', []]);
  });

  it('lists a customer under everyone assigned to it', async () => {
    await assign(t.priya.id);
    for (const u of [t.member, t.priya]) {
      const { items } = await ask(
        personList,
        { workspaceId: t.wsId, assignedUserId: u.id },
        t.owner,
      );
      expect(items.map((p) => p.id)).toContain(personId);
    }
    const { items } = await ask(
      personList,
      { workspaceId: t.wsId, assignedUserId: t.marco.id },
      t.owner,
    );
    expect(items.map((p) => p.id)).not.toContain(personId);
  });

  it('leaves who is on a customer to owners and admins', async () => {
    const ref = { workspaceId: t.wsId, recordType: 'person' as const, recordId: personId };
    // A member who could put themselves on any customer could read its bills and threads.
    await expectHfos(
      () => run(recordAssign, { ...ref, userId: t.member.id }, t.member),
      'forbidden',
    );
    await expectHfos(
      () => run(recordUnassign, { ...ref, userId: t.priya.id }, t.member),
      'forbidden',
    );
    await expectHfos(
      () => run(personUpdate, { workspaceId: t.wsId, personId, ownerUserId: t.marco.id }, t.member),
      'customer_team_managers_only',
      403,
    );
    // The database refuses it too, whatever writes it as that person.
    const err = await expectPg(() =>
      admin().transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: t.member.id, role: 'authenticated' })}, true)`,
        );
        await tx.execute(
          sql`update app.people set team_user_ids = array[${t.member.id}::uuid] where id = ${personId}`,
        );
      }),
    );
    expect(err).toMatch(/Only owners and admins change who a customer is assigned to/);
    // Anything else about the customer is still theirs to edit, and a new customer is anybody's to start.
    await run(personUpdate, { workspaceId: t.wsId, personId, notes: 'Gate code 4471' }, t.member);
    const { personId: theirs } = await run(
      personCreate,
      { workspaceId: t.wsId, firstName: 'Walk', lastName: 'In', ownerUserId: t.member.id },
      t.member,
    );
    const { person } = await ask(personGet, { workspaceId: t.wsId, personId: theirs }, t.owner);
    expect(person.owner?.id).toBe(t.member.id);
  });

  it('makes a teammate the main one after the owner has left the business', async () => {
    const { personId: client } = await run(
      personCreate,
      { workspaceId: t.wsId, firstName: 'Left', lastName: 'Behind', ownerUserId: t.marco.id },
      t.owner,
    );
    const ref = { workspaceId: t.wsId, recordType: 'person' as const, recordId: client };
    await run(recordAssign, { ...ref, userId: t.priya.id }, t.owner);
    await rows(
      admin(),
      sql`delete from app.workspace_memberships where workspace_id = ${t.wsId} and user_id = ${t.marco.id}`,
    );
    try {
      const out = await run(recordAssign, { ...ref, userId: t.priya.id, main: true }, t.owner);
      expect(out.owner?.id).toBe(t.priya.id);
      // Marco stays listed, as a "Former member", and sees nothing.
      expect(out.team).toEqual([{ id: t.marco.id, fullName: 'Former member' }]);
    } finally {
      await rows(
        admin(),
        sql`insert into app.workspace_memberships (workspace_id, user_id, role)
            values (${t.wsId}, ${t.marco.id}, 'member')`,
      );
    }
  });

  it('works the same for a company', async () => {
    const { companyId } = await run(
      companyCreate,
      { workspaceId: t.wsId, name: 'Client Holdings' },
      t.owner,
    );
    for (const userId of [t.priya.id, t.marco.id])
      await run(
        recordAssign,
        { workspaceId: t.wsId, recordType: 'company', recordId: companyId, userId },
        t.owner,
      );
    const { company } = await ask(companyGet, { workspaceId: t.wsId, companyId }, t.owner);
    expect(company.owner?.id).toBe(t.priya.id);
    expect(company.team.map((m) => m.id)).toEqual([t.marco.id]);
    const { items } = await ask(
      companyList,
      { workspaceId: t.wsId, assignedUserId: t.marco.id },
      t.owner,
    );
    expect(items.map((c) => c.id)).toEqual([companyId]);
  });
});

describe('what being on a customer shows a member', () => {
  it('shows them the customer’s invoices, and stops when they come off', async () => {
    const { invoiceId } = await run(
      invoiceCreate,
      {
        workspaceId: t.wsId,
        personId,
        title: 'SEO, October',
        lines: [{ name: 'SEO', quantity: 1, unitPriceCents: 50_000, taxable: false }],
      },
      t.owner,
    );
    const seen = async (u: Team['marco']) =>
      (await ask(invoiceList, { workspaceId: t.wsId }, u)).invoices.map((i) => i.id);
    const listed = async () =>
      (
        await rows<{ ids: string[] }>(
          admin(),
          sql`select member_viewer_ids as ids from app.invoices where id = ${invoiceId}`,
        )
      )[0]!.ids;
    // Mike owns the customer and Priya is on it; Marco is on neither.
    expect(await seen(t.member)).toContain(invoiceId);
    expect(await seen(t.priya)).toContain(invoiceId);
    expect(await seen(t.marco)).not.toContain(invoiceId);
    expect([...(await listed())].sort()).toEqual([t.member.id, t.priya.id].sort());
    await run(
      recordUnassign,
      { workspaceId: t.wsId, recordType: 'person', recordId: personId, userId: t.priya.id },
      t.owner,
    );
    expect(await seen(t.priya)).not.toContain(invoiceId);
    expect(await listed()).toEqual([t.member.id]);
  });

  it('keeps the stored lists and the policies in step', async () => {
    expect(
      await rows(admin(), sql`select * from private.sync_viewer_mismatches(${t.wsId})`),
    ).toEqual([]);
  });

  it('shows them the customer’s threads when the business narrows its inbox', async () => {
    await rows(
      admin(),
      sql`update app.workspaces set settings = jsonb_set(settings, '{inbox}', '{"perPerson": true}')
          where id = ${t.wsId}`,
    );
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
          values (${t.wsId}, 'email', 'client@co.com', ${personId}) returning id`,
    );
    const viewers = async () =>
      (
        await rows<{ ids: string[] }>(
          admin(),
          sql`select member_viewer_ids as ids from app.conversations where id = ${c!.id}`,
        )
      )[0]!.ids;
    // Mike owns the customer: the thread is his, not everybody's.
    expect(await viewers()).toEqual([t.member.id]);
    await assign(t.marco.id);
    expect([...(await viewers())].sort()).toEqual([t.member.id, t.marco.id].sort());
    expect(
      await rows(admin(), sql`select * from private.sync_inbox_mismatches(${t.wsId})`),
    ).toEqual([]);
  });
});

/** The database's own refusal, as the message it raised. */
async function expectPg(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ''} ${err.cause?.message ?? ''}`;
  }
  throw new Error('expected the database to refuse');
}
