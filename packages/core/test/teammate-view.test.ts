/**
 * Viewing the app as a teammate (20261016000200): who may view as whom, that a request in a view reads exactly as
 * the teammate (their role, their permissions, their narrowed inbox) and changes nothing, that a person's own mail
 * stays theirs, and that a view stops holding the moment the viewer may no longer view as them.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type {
  CommandDef,
  HumanActor,
  QueryDef,
  RequestMeta,
  SystemActor,
} from '../src/kernel/types';
import {
  assistantThreadList,
  conversationGet,
  emailAddressCreate,
  emailReceive,
  inboxList,
  inboxSetVisibility,
  membershipChangeRole,
  organizationCreate,
  personCreate,
  personList,
  platformViewAsEnd,
  platformViewAsStart,
  teammateViewCurrent,
  teammateViewEnd,
  teammateViewLens,
  teammateViewStart,
  workspaceGet,
} from '../src/server';

const api = () => testDbs().api.db;
const admin$ = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (viewAs?: string): RequestMeta => ({
  correlationId: randomUUID(),
  channel: 'test',
  ...(viewAs ? { viewAs } : {}),
});
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: z.input<I>,
  u: TestUser,
  viewAs?: string,
) => executeCommand(api(), cmd, input, human(u), meta(viewAs)).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: z.input<I>,
  u: TestUser,
  viewAs?: string,
) => executeQuery(api(), q, input, human(u), meta(viewAs));
const token = () => randomUUID().slice(0, 8);

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let chris: TestUser;
let outsider: TestUser;
let wsId: string;
let orgId: string;
let otherWsId: string;
/** A thread assigned to the member, one assigned to Chris, and Chris's own mail. */
let membersThread: string;
let chrisThread: string;
let chrisMail: string;

beforeAll(async () => {
  [owner, admin, member, chris, outsider] = await Promise.all([
    createTestUser('tv-owner'),
    createTestUser('tv-admin'),
    createTestUser('tv-member'),
    createTestUser('tv-chris'),
    createTestUser('tv-outsider'),
  ]);
  const created = await run(organizationCreate, { businessName: 'Seen Through HVAC' }, owner);
  wsId = created.workspaceId;
  orgId = created.organizationId;
  otherWsId = (await run(organizationCreate, { businessName: 'Owner’s Other Shop' }, owner))
    .workspaceId;
  await rows(
    admin$(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${admin.id}, 'admin'), (${wsId}, ${member.id}, 'member'),
               (${wsId}, ${chris.id}, 'member')`,
  );
  await run(personCreate, { workspaceId: wsId, firstName: 'Dana', lastName: 'Reed' }, owner);
  [membersThread, chrisThread] = (
    await rows<{ id: string }>(
      admin$(),
      sql`insert into app.conversations (workspace_id, channel, counterpart, assignee_user_id)
          values (${wsId}, 'sms', '+15125550101', ${member.id}), (${wsId}, 'sms', '+15125550102', ${chris.id})
          returning id`,
    )
  ).map((r) => r.id) as [string, string];

  // Chris's own address, and mail to it: theirs alone (M19).
  const [domain] = await rows<{ id: string }>(
    admin$(),
    sql`insert into app.email_domains (workspace_id, domain, status, receiving, ownership_proved_at)
        values (${wsId}, ${`${token()}.example.com`}, 'verified', 'on', now()) returning id`,
  );
  const chrisAddress = (
    await run(
      emailAddressCreate,
      {
        workspaceId: wsId,
        emailDomainId: domain!.id,
        localPart: 'chris',
        displayName: 'Seen Through HVAC',
        ownerUserId: chris.id,
      },
      owner,
    )
  ).emailAddressId;
  const system: SystemActor = { type: 'system', workspaceId: wsId, organizationId: orgId };
  const got = await executeCommand(
    testDbs().worker.db,
    emailReceive,
    {
      workspaceId: wsId,
      provider: 'postmark',
      providerMessageId: `pm-${token()}`,
      messageIdHeader: `<${randomUUID()}@mail.example.com>`,
      from: { address: `friend-${token()}@example.com` },
      to: [{ address: 'someone@example.com' }],
      subject: 'Dinner Friday?',
      bodyText: 'Are we still on for Friday?',
      emailAddressId: chrisAddress,
    },
    system,
    meta(),
  );
  chrisMail = got.output.conversationId!;
});
afterAll(closeTestDbs);

describe('who may view as whom', () => {
  it('an owner may view as an admin or a member, and an admin as a member', async () => {
    for (const [viewer, person] of [
      [owner, admin],
      [owner, member],
      [admin, member],
    ] as const) {
      const { view } = await run(
        teammateViewStart,
        { workspaceId: wsId, userId: person.id },
        viewer,
      );
      expect(view).toMatchObject({ workspaceId: wsId, by: 'team' });
      expect(view.person.userId).toBe(person.id);
      await run(teammateViewEnd, { viewId: view.id }, viewer);
    }
  });

  it('never as someone at or above their own role', async () => {
    await expect(
      run(teammateViewStart, { workspaceId: wsId, userId: owner.id }, admin),
    ).rejects.toMatchObject({ code: 'forbidden', rule: 'teammate_view_rank' });
  });

  it('a member may not view as anyone', async () => {
    await expect(
      run(teammateViewStart, { workspaceId: wsId, userId: chris.id }, member),
    ).rejects.toMatchObject({ code: 'forbidden', rule: 'teammate_view_not_allowed' });
  });

  it('not as themselves, nor as someone who isn’t on the team', async () => {
    await expect(
      run(teammateViewStart, { workspaceId: wsId, userId: owner.id }, owner),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      run(teammateViewStart, { workspaceId: wsId, userId: outsider.id }, owner),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('nor in a business they can’t open', async () => {
    await expect(
      run(teammateViewStart, { workspaceId: otherWsId, userId: owner.id }, member),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('nor as someone who can do something they can’t', async () => {
    // Admins here may not set up numbers and email; Chris, a member, may.
    await rows(
      admin$(),
      sql`insert into app.role_permission_overrides (workspace_id, role, permission, allowed)
          values (${wsId}, 'admin', 'channels.manage', false)`,
    );
    await rows(
      admin$(),
      sql`insert into app.member_permission_overrides (workspace_id, user_id, permission, allowed)
          values (${wsId}, ${chris.id}, 'channels.manage', true)`,
    );
    try {
      await expect(
        run(teammateViewStart, { workspaceId: wsId, userId: chris.id }, admin),
      ).rejects.toMatchObject({ code: 'forbidden', rule: 'teammate_view_beyond' });
      // The owner, who holds everything, still may.
      const { view } = await run(teammateViewStart, { workspaceId: wsId, userId: chris.id }, owner);
      await run(teammateViewEnd, { viewId: view.id }, owner);
    } finally {
      await rows(
        admin$(),
        sql`delete from app.member_permission_overrides where workspace_id = ${wsId} and user_id = ${chris.id}`,
      );
      await rows(
        admin$(),
        sql`delete from app.role_permission_overrides where workspace_id = ${wsId} and role = 'admin'`,
      );
    }
  });

  it('an owner can take it away from admins', async () => {
    await rows(
      admin$(),
      sql`insert into app.role_permission_overrides (workspace_id, role, permission, allowed)
          values (${wsId}, 'admin', 'members.view_as', false)`,
    );
    try {
      await expect(
        run(teammateViewStart, { workspaceId: wsId, userId: member.id }, admin),
      ).rejects.toMatchObject({ code: 'forbidden', rule: 'teammate_view_not_allowed' });
    } finally {
      await rows(
        admin$(),
        sql`delete from app.role_permission_overrides where workspace_id = ${wsId} and role = 'admin'`,
      );
    }
  });
});

describe('through a view', () => {
  let viewId: string;

  beforeAll(async () => {
    viewId = (await run(teammateViewStart, { workspaceId: wsId, userId: member.id }, owner)).view
      .id;
  });

  it('the business reads as the teammate: their role and their permissions', async () => {
    const seen = await ask(workspaceGet, { workspaceId: wsId }, owner, viewId);
    expect(seen.workspace.role).toBe('member');
    expect(seen.workspace.permissions).toContain('records.write');
    expect(seen.workspace.permissions).not.toContain('money.manage');
    expect(seen.workspace.permissions).not.toContain('members.view_as');
  });

  it('only for requests that say so, and only in that business', async () => {
    const mine = await ask(workspaceGet, { workspaceId: wsId }, owner);
    expect(mine.workspace.role).toBe('owner');
    const other = await ask(workspaceGet, { workspaceId: otherWsId }, owner, viewId);
    expect(other.workspace.role).toBe('owner');
  });

  it('a view id that isn’t yours is no view at all', async () => {
    const seen = await ask(workspaceGet, { workspaceId: wsId }, admin, viewId);
    expect(seen.workspace.role).toBe('admin');
  });

  it('the inbox is the one they see, narrowed to their own threads', async () => {
    await run(inboxSetVisibility, { workspaceId: wsId, perPerson: true }, owner);
    try {
      const open = (conversationId: string, viewAs?: string) =>
        ask(conversationGet, { workspaceId: wsId, conversationId }, owner, viewAs);
      await open(chrisThread);
      expect((await open(membersThread, viewId)).conversation.id).toBe(membersThread);
      await expect(open(chrisThread, viewId)).rejects.toMatchObject({ code: 'not_found' });
      const lens = await ask(teammateViewLens, { workspaceId: wsId }, owner, viewId);
      expect(lens.person).toMatchObject({ userId: member.id, role: 'member' });
      expect(lens.conversationIds).toContain(membersThread);
      expect(lens.conversationIds).not.toContain(chrisThread);
      expect(lens.attentionItemIds).not.toBeNull();
    } finally {
      await run(inboxSetVisibility, { workspaceId: wsId, perPerson: false }, owner);
    }
    const lens = await ask(teammateViewLens, { workspaceId: wsId }, owner, viewId);
    expect(lens.conversationIds).toBeNull();
    // A member sees the bills for their own work; none here.
    expect(lens.estimateIds).toEqual([]);
    expect(lens.invoiceIds).toEqual([]);
  });

  it('there’s no lens outside a view', async () => {
    await expect(ask(teammateViewLens, { workspaceId: wsId }, owner)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('their chats with the Assistant stay theirs', async () => {
    await expect(
      ask(assistantThreadList, { workspaceId: wsId }, owner, viewId),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('nothing can be changed through it, but the viewer still works as themselves', async () => {
    await expect(
      run(
        personCreate,
        { workspaceId: wsId, firstName: 'Added', lastName: 'InAView' },
        owner,
        viewId,
      ),
    ).rejects.toMatchObject({ code: 'forbidden', rule: 'teammate_view_read_only' });
    await run(personCreate, { workspaceId: wsId, firstName: 'Added', lastName: 'AsMe' }, owner);
    const people = await ask(personList, { workspaceId: wsId }, owner);
    expect(people.items.some((p) => p.lastName === 'InAView')).toBe(false);
    expect(people.items.some((p) => p.lastName === 'AsMe')).toBe(true);
  });

  it('is the one open in the business, and the business’s audit log says who looked', async () => {
    const { view } = await ask(teammateViewCurrent, { workspaceId: wsId }, owner, viewId);
    expect(view).toMatchObject({ id: viewId, by: 'team', person: { userId: member.id } });
    const logged = await rows<{ actor_id: string; after: { person: string; readOnly: boolean } }>(
      admin$(),
      sql`select actor_id, after from app.audit_logs
          where workspace_id = ${wsId} and action = 'teammate_view.start' and entity_id = ${viewId}`,
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]!.actor_id).toBe(owner.id);
    expect(logged[0]!.after.readOnly).toBe(true);
  });

  it('once ended, it reads as the viewer again and refuses a change it was asked for', async () => {
    expect((await run(teammateViewEnd, { workspaceId: wsId }, owner)).ended).toBe(1);
    expect((await ask(teammateViewCurrent, { workspaceId: wsId }, owner)).view).toBeNull();
    const seen = await ask(workspaceGet, { workspaceId: wsId }, owner, viewId);
    expect(seen.workspace.role).toBe('owner');
    await expect(
      run(
        personCreate,
        { workspaceId: wsId, firstName: 'Late', lastName: 'Change' },
        owner,
        viewId,
      ),
    ).rejects.toMatchObject({ code: 'forbidden', rule: 'teammate_view_ended' });
  });
});

describe('someone’s own mail', () => {
  it('is theirs, and not anyone’s viewing as them', async () => {
    const own = await ask(conversationGet, { workspaceId: wsId, conversationId: chrisMail }, chris);
    expect(own.conversation.id).toBe(chrisMail);
    const { view } = await run(teammateViewStart, { workspaceId: wsId, userId: chris.id }, owner);
    try {
      await expect(
        ask(conversationGet, { workspaceId: wsId, conversationId: chrisMail }, owner, view.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      const mine = await ask(
        inboxList,
        { workspaceId: wsId, box: 'all', mailbox: 'mine' },
        owner,
        view.id,
      );
      expect(mine.items).toEqual([]);
    } finally {
      await run(teammateViewEnd, { viewId: view.id }, owner);
    }
  });

  it('even in a business that shows each person their own threads', async () => {
    await run(inboxSetVisibility, { workspaceId: wsId, perPerson: true }, owner);
    const { view } = await run(teammateViewStart, { workspaceId: wsId, userId: chris.id }, owner);
    try {
      const lens = await ask(teammateViewLens, { workspaceId: wsId }, owner, view.id);
      expect(lens.conversationIds).not.toContain(chrisMail);
    } finally {
      await run(teammateViewEnd, { viewId: view.id }, owner);
      await run(inboxSetVisibility, { workspaceId: wsId, perPerson: false }, owner);
    }
  });
});

describe('a view stops holding when the right to it goes', () => {
  it('an admin made a member can no longer see through theirs', async () => {
    const { view } = await run(teammateViewStart, { workspaceId: wsId, userId: member.id }, admin);
    expect((await ask(workspaceGet, { workspaceId: wsId }, admin, view.id)).workspace.role).toBe(
      'member',
    );
    await run(membershipChangeRole, { workspaceId: wsId, userId: admin.id, role: 'member' }, owner);
    try {
      expect((await ask(teammateViewCurrent, { workspaceId: wsId }, admin)).view).toBeNull();
      // Their own view of the business, as the member they now are: nothing of the other member's.
      const seen = await ask(workspaceGet, { workspaceId: wsId }, admin, view.id);
      expect(seen.workspace.permissions).not.toContain('members.view_as');
      await expect(
        ask(teammateViewLens, { workspaceId: wsId }, admin, view.id),
      ).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await run(
        membershipChangeRole,
        { workspaceId: wsId, userId: admin.id, role: 'admin' },
        owner,
      );
      await run(teammateViewEnd, {}, admin);
    }
  });
});

describe('HandsFreeOS', () => {
  let agent: TestUser;
  let founder: TestUser;

  beforeAll(async () => {
    [agent, founder] = await Promise.all([
      createTestUser('tv-agent'),
      createTestUser('tv-founder'),
    ]);
    await admin$().execute(sql`update platform.staff set founder = false where founder`);
    await admin$().execute(
      sql`insert into platform.staff (user_id, role, founder)
          values (${agent.id}, 'agent', false), (${founder.id}, 'agent', true)`,
    );
  });
  afterAll(async () => {
    await admin$().execute(
      sql`delete from platform.staff where user_id in (${agent.id}, ${founder.id})`,
    );
  });

  it('support needs the business open first', async () => {
    await expect(
      run(teammateViewStart, { workspaceId: wsId, userId: owner.id }, agent),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('inside a look, support views as anyone, the owner too, and the business is told by the worker', async () => {
    await run(
      platformViewAsStart,
      { workspaceId: wsId, reason: 'They can’t find their invoices', minutes: 15 },
      agent,
    );
    try {
      const { view } = await run(teammateViewStart, { workspaceId: wsId, userId: owner.id }, agent);
      expect(view.by).toBe('support');
      const seen = await ask(workspaceGet, { workspaceId: wsId }, agent, view.id);
      expect(seen.workspace.role).toBe('owner');
      // Still nothing can be changed.
      await expect(
        run(personCreate, { workspaceId: wsId, firstName: 'No', lastName: 'Way' }, agent, view.id),
      ).rejects.toMatchObject({ code: 'forbidden', rule: 'teammate_view_read_only' });
      const [event] = await rows<{ workspace_id: string | null; payload: { by: string } }>(
        admin$(),
        sql`select workspace_id, payload from app.events
            where event_type = 'platform.teammate_view_started' and entity_id = ${view.id}`,
      );
      expect(event).toMatchObject({ workspace_id: null, payload: { by: 'support' } });
    } finally {
      await run(platformViewAsEnd, {}, agent);
    }
  });

  it('and once the look ends, so does the view', async () => {
    expect((await ask(teammateViewCurrent, { workspaceId: wsId }, agent)).view).toBeNull();
    await run(teammateViewEnd, {}, agent);
  });

  it('the founder, in the business as its owner, views as anyone and nobody is told', async () => {
    await run(platformViewAsStart, { workspaceId: wsId }, founder);
    try {
      const { view } = await run(
        teammateViewStart,
        { workspaceId: wsId, userId: owner.id },
        founder,
      );
      expect(view.by).toBe('founder');
      const inBusiness = await rows<{ n: number }>(
        admin$(),
        sql`select count(*)::int as n from app.audit_logs
            where workspace_id = ${wsId} and entity_id = ${view.id}`,
      );
      expect(inBusiness[0]?.n).toBe(0);
      await run(teammateViewEnd, { viewId: view.id }, founder);
    } finally {
      await run(platformViewAsEnd, {}, founder);
    }
  });
});
