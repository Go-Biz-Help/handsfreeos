/**
 * A customer signed in to their portal, as the kernel runs them (Real Estate round two, step 3): their look-ups read
 * only what's theirs (themselves, and the deals they're a client on), their changes run as the service actor and are
 * recorded as theirs on the portal channel, and they're refused everything not made for them, any other business, a
 * turned-off add-on and a device that has been signed out since.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { realestateAddon } from '../src/addons/realestate/manifest';
import {
  composeOperations,
  customerOperationIssues,
  defineAddonQuery,
  defineCommand,
  defineQuery,
  executeCommand,
  executeQuery,
  manifestIssues,
  personCreate,
  portalAccessGive,
  portalCheckCode,
  portalHome,
  portalSendCode,
  portalSessionEnd,
  registry,
  requireCustomer,
  type CustomerActor,
  type RequestMeta,
} from '../src/server';
import { realestateBusiness } from './addons/realestate-fixture';
import { admin, ask, expectHfos, run, runSystem, type Scope } from './calendar-helpers';

let owner: TestUser;
let scope: Scope;
let linh: CustomerActor;
let linhDeal: string;
let otherDeal: string;
let vendorDeal: string;

const worker = () => testDbs().worker.db;
const portal = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'portal' });
const asLinh = <O>(q: Parameters<typeof executeQuery>[1], input: unknown, who = linh) =>
  executeQuery(worker(), q, input, who, portal()) as Promise<O>;

async function person(firstName: string, email: string | null): Promise<string> {
  return (
    await run(
      personCreate,
      {
        workspaceId: scope.workspaceId,
        firstName,
        lastName: 'Client',
        ...(email ? { email } : {}),
      },
      owner,
    )
  ).personId;
}

/** A device signed in for this person: the way the worker does it. */
async function signIn(personId: string): Promise<CustomerActor> {
  const { accessId } = await run(
    portalAccessGive,
    { workspaceId: scope.workspaceId, personId },
    owner,
  );
  const sent = await runSystem(portalSendCode, { workspaceId: scope.workspaceId, accessId }, scope);
  const hit = await runSystem(
    portalCheckCode,
    {
      workspaceId: scope.workspaceId,
      accessId,
      code: sent.code,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    },
    scope,
  );
  return { type: 'customer', ...scope, personId, sessionId: hit.sessionId! };
}

async function deal(name: string): Promise<string> {
  const [r] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.custom_records (workspace_id, type_id, name, created_by, owner_user_id)
        select ${scope.workspaceId}, t.id, ${name}, ${owner.id}, ${owner.id} from app.custom_record_types t
        where t.workspace_id = ${scope.workspaceId} and t.key = 'realestate_deal'
        returning id`,
  );
  return r!.id;
}

async function relate(personId: string, recordId: string, key: string): Promise<void> {
  await rows(
    admin(),
    sql`insert into app.relationships (workspace_id, type_id, a_person_id, b_custom_record_id)
        select ${scope.workspaceId}, t.id, ${personId}, ${recordId} from app.relationship_types t
        where t.workspace_id = ${scope.workspaceId} and t.addon_key = ${key}`,
  );
}

/** What a customer's look-up reads straight from the database, under their own rules. */
const readsIds = defineQuery({
  name: 'portal.test_reads',
  description: 'Test: the records and people a customer reads.',
  input: z.object({ workspaceId: z.string().uuid() }),
  output: z.object({ records: z.array(z.string()), people: z.array(z.string()), role: z.string() }),
  permission: null,
  actors: ['customer'],
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx) {
    const records = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.custom_records order by id`,
    );
    const people = await rows<{ id: string }>(ctx.tx, sql`select id from app.people order by id`);
    const [r] = await rows<{ role: string }>(ctx.tx, sql`select current_user::text as role`);
    return { records: records.map((x) => x.id), people: people.map((x) => x.id), role: r!.role };
  },
});

/** A customer's change: noted against the record, recorded as them. */
const noteIt = defineCommand({
  name: 'portal.test_note',
  description: 'Test: a customer leaves a note on a record they are on.',
  risk: 1,
  input: z.object({ workspaceId: z.string().uuid(), recordId: z.string().uuid() }),
  output: z.object({ role: z.string() }),
  permission: null,
  actors: ['customer'],
  emits: ['portal.test_noted'],
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const [r] = await rows<{ role: string }>(ctx.tx, sql`select current_user::text as role`);
    const [mine] = await rows<{ ok: boolean }>(
      ctx.tx,
      sql`select ${input.recordId}::uuid in (select private.portal_records_for(${ctx.scope.workspaceId}::uuid, ${me.personId}::uuid)) as ok`,
    );
    if (!mine?.ok) throw new Error('not theirs');
    await ctx.emit({
      type: 'portal.test_noted',
      entityType: 'custom_record',
      entityId: input.recordId,
    });
    return { role: r!.role };
  },
});

beforeAll(async () => {
  owner = await createTestUser('portal-kernel-owner', { fullName: 'Dana Reyes' });
  const workspaceId = await realestateBusiness(owner, 'Portal Kernel Realty');
  const [ws] = await rows<{ organization_id: string }>(
    admin(),
    sql`select organization_id from app.workspaces where id = ${workspaceId}`,
  );
  scope = { workspaceId, organizationId: ws!.organization_id };
  const linhId = await person('Linh', 'linh.portal@example.com');
  const other = await person('Omar', 'omar.portal@example.com');
  linhDeal = await deal('Nguyen purchase');
  otherDeal = await deal('Haddad purchase');
  vendorDeal = await deal('Lopez sale');
  await relate(linhId, linhDeal, 'realestate_client');
  await relate(other, otherDeal, 'realestate_client');
  // On a deal, but not as its client: it isn't hers to see.
  await relate(linhId, vendorDeal, 'realestate_vendor');
  linh = await signIn(linhId);
});
afterAll(closeTestDbs);

describe('a customer’s look-ups', () => {
  it('read only themselves and the deals they’re a client on, as portal_actor', async () => {
    const got = await asLinh<{ records: string[]; people: string[]; role: string }>(readsIds, {
      workspaceId: scope.workspaceId,
    });
    expect(got).toEqual({ records: [linhDeal], people: [linh.personId], role: 'portal_actor' });
  });

  it('open the portal with the business and their name', async () => {
    const home = await asLinh(portalHome, { workspaceId: scope.workspaceId });
    expect(home).toEqual({
      business: { name: 'Portal Kernel Realty' },
      person: { firstName: 'Linh', lastName: 'Client' },
      // Real Estate's first page; the ones with an id open from it.
      addons: [
        {
          id: 'realestate',
          name: 'Real Estate Agent',
          pages: [
            { path: '', title: 'Your deals' },
            { path: 'homes', title: 'Homes' },
            { path: 'todo', title: 'To do' },
          ],
        },
      ],
    });
  });

  it('are refused anything not made for customers, and any other business', async () => {
    await expectHfos(
      () =>
        executeQuery(
          worker(),
          registry.query('person.get')!,
          { workspaceId: scope.workspaceId },
          linh,
          portal(),
        ),
      'forbidden',
    );
    await expectHfos(() => asLinh(portalHome, { workspaceId: randomUUID() }), 'not_found');
    // And people in the business can't run them.
    await expectHfos(() => ask(portalHome, { workspaceId: scope.workspaceId }, owner), 'forbidden');
  });

  it('stop while the add-on is off', async () => {
    const dealsOf = defineAddonQuery(realestateAddon, {
      name: 'realestate.portal.test_deals',
      description: 'Test: an add-on’s customer query.',
      input: z.object({ workspaceId: z.string().uuid() }),
      output: z.object({ n: z.number() }),
      permission: null,
      actors: ['customer'],
      scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
      async handler(ctx) {
        const [r] = await rows<{ n: number }>(
          ctx.tx,
          sql`select count(*)::int as n from app.custom_records`,
        );
        return { n: r!.n };
      },
    });
    expect(await asLinh(dealsOf, { workspaceId: scope.workspaceId })).toEqual({ n: 1 });
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled'
          where workspace_id = ${scope.workspaceId} and addon_id = 'realestate'`,
    );
    try {
      await expectHfos(() => asLinh(dealsOf, { workspaceId: scope.workspaceId }), 'addon_inactive');
      // Its records leave the portal with it, whatever reads them.
      const got = await asLinh<{ records: string[] }>(readsIds, { workspaceId: scope.workspaceId });
      expect(got.records).toEqual([]);
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled'
            where workspace_id = ${scope.workspaceId} and addon_id = 'realestate'`,
      );
    }
  });
});

describe('a customer’s changes', () => {
  it('run as the service actor and are recorded as the customer, on the portal channel', async () => {
    const { output, eventIds } = await executeCommand(
      worker(),
      noteIt,
      { workspaceId: scope.workspaceId, recordId: linhDeal },
      linh,
      portal(),
    );
    expect(output.role).toBe('service_actor');
    const [audit] = await rows<{
      actor_type: string;
      actor_id: string;
      actor_role: string;
      channel: string;
    }>(
      admin(),
      sql`select actor_type::text, actor_id, actor_role, channel from app.audit_logs where event_id = ${eventIds[0]!}`,
    );
    expect(audit).toEqual({
      actor_type: 'customer',
      actor_id: linh.personId,
      actor_role: 'customer',
      channel: 'portal',
    });
  });
});

describe('a device signed out since', () => {
  it('gets nothing more, looking or changing', async () => {
    const other = await signIn(linh.personId);
    await runSystem(
      portalSessionEnd,
      { workspaceId: scope.workspaceId, sessionId: other.sessionId },
      scope,
    );
    await expectHfos(
      () => asLinh(portalHome, { workspaceId: scope.workspaceId }, other),
      'portal_signed_out',
      401,
    );
    await expectHfos(
      () =>
        executeCommand(
          worker(),
          noteIt,
          { workspaceId: scope.workspaceId, recordId: linhDeal },
          other,
          portal(),
        ),
      'portal_signed_out',
    );
    // A session id that names someone else's device is no better.
    await expectHfos(
      () =>
        asLinh(portalHome, { workspaceId: scope.workspaceId }, { ...linh, personId: randomUUID() }),
      'portal_signed_out',
    );
  });
});

describe('what customers may run', () => {
  it('is named for the portal, for customers alone, with no permission, no AI and little risk', () => {
    const ops = [...registry.commands, ...registry.queries];
    // Core's are named "portal.…"; an add-on's, "<its id>.portal.…".
    const issues = ops.flatMap((op) =>
      customerOperationIssues(op, op.addon ? `${op.addon.id}.portal.` : 'portal.'),
    );
    expect(issues).toEqual([]);
    expect(ops.filter((op) => op.actors?.includes('customer')).map((op) => op.name)).toContain(
      'portal.home',
    );
    expect(customerOperationIssues(noteIt, 'portal.')).toEqual([]);
    const as = (op: object) => op as unknown as typeof readsIds;
    expect(
      customerOperationIssues(as({ ...noteIt, actors: ['customer', 'human'] }), 'portal.'),
    ).toEqual(['portal.test_note is for customers alone']);
    expect(customerOperationIssues(as({ ...noteIt, name: 'note.add' }), 'portal.')).toEqual([
      'note.add is for customers, so it must be named "portal.…"',
    ]);
  });

  it('is checked for every add-on, and a portal page must show one of its customer queries', () => {
    const m = {
      ...realestateAddon,
      ui: {
        ...realestateAddon.ui,
        portal: [{ path: '', title: 'Your deals', query: 'realestate.portal.deals' }],
      },
    };
    expect(manifestIssues(m)).toEqual([]);
    expect(() => composeOperations({ commands: [], queries: [] }, [{ manifest: m }])).toThrow(
      /portal page "" shows realestate.portal.deals, which isn't one of its customer queries/,
    );
    const noPortal = {
      ...m,
      relationshipTypes: (m.relationshipTypes ?? []).map((t) => ({ ...t, portal: undefined })),
    };
    expect(manifestIssues(noPortal).map((i) => i.message)).toContain(
      'portal pages need a relationship type with "portal", so a customer has records to see',
    );
  });
});
