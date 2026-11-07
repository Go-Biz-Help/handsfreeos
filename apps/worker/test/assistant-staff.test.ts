/**
 * HandsFreeOS's own Admin area through the Assistant (staff only, the owner, 2026-10-27). A staff card names the
 * business, the amount in dollars and the stage in the screen's words, never an id; a credit confirmed twice goes
 * on once; moving a business off Paid by the agency says what it writes off; what the screens send back as it was
 * (a sign-off, an area's description) stays as it was when the model leaves it out; and the desk's own reads,
 * alerts and coverage page are there for staff and nobody else.
 */
import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  DESK_WALLET_STAGES,
  DESK_WALLET_WORDS,
  deskMatomoPagesUrl,
  executeCommand,
  hasStaffPermission,
  hasWorkspacePermission,
  ideaAreaSave,
  ideaComment,
  ideaSetCommentHidden,
  ideaShare,
  money,
  organizationCreate,
  pushSwitchesOf,
  screenReadName,
  supportRequestCreate,
  supportStaffSaveProfile,
  userUpdateProfile,
  walletSetStage,
  type AssistantCard,
  type CommandDef,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { screenActionToolByName } from '../src/assistant/tools-screen-actions';
import { allScreenReadTools, screenReadToolsFor } from '../src/assistant/tools-screen-reads';
import { createToolExecutor } from '../src/assistant/tools-write';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const run = async <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) =>
  (
    await executeCommand(api(), cmd, input, actor(u), {
      correlationId: randomUUID(),
      channel: 'test' as const,
    })
  ).output;

const mark = randomUUID().slice(0, 8);
const BUSINESS = `Staff Assistant Plumbing ${mark}`;
const AREA = `zz_staff_${mark}`;

let staff: TestUser;
let owner: TestUser;
let wsId: string;
let staffWs: string;
let staffOrg: string;
let ownerOrg: string;

const ctxFor = (u: TestUser): ToolContext => ({
  actor: actor(u),
  workspaceId: u === staff ? staffWs : wsId,
  organizationId: u === staff ? staffOrg : ownerOrg,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
const action = (name: string) => screenActionToolByName(name)!;
const prepareAction = async (name: string, args: Record<string, unknown>, id = randomUUID()) =>
  (await createToolExecutor(api()).prepare(action(name), args, ctxFor(staff), id))
    .card as ConfirmCard;
const commitAction = (name: string, args: Record<string, unknown>, toolCallId = randomUUID()) =>
  createToolExecutor(api()).commit(action(name), args, ctxFor(staff), { toolCallId });
const readScreen = async (query: string, args: Record<string, unknown>, u: TestUser = staff) => {
  const tool = allScreenReadTools().find((t) => t.name === screenReadName(query))!;
  const out = await createToolExecutor(api()).run(tool, tool.input.parse(args) as never, ctxFor(u));
  return (out as { result: { data: unknown } }).result.data;
};
const runTool = async (name: string, args: Record<string, unknown>, u: TestUser = staff) => {
  const tool = assistantToolByName.get(name)!;
  const out = await createToolExecutor(api()).run(tool, tool.input.parse(args) as never, ctxFor(u));
  return (out as { result: Record<string, unknown> }).result;
};

const balance = async () => {
  const [w] = await rows<{ balance: number }>(
    admin(),
    sql`select balance_cents::int as balance from app.usage_wallets where workspace_id = ${wsId}`,
  );
  return Number(w?.balance);
};
const assistantCredits = async () =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.usage_ledger
          where workspace_id = ${wsId} and idempotency_key like 'credit:assistant:%'`,
    )
  )[0]!.n;

beforeAll(async () => {
  [staff, owner] = await Promise.all([
    createTestUser('ast-staff-desk', { fullName: 'Sam Desk' }),
    createTestUser('ast-staff-owner', { fullName: 'Dana Owner' }),
  ]);
  const theirs = (await run(organizationCreate, { businessName: BUSINESS }, owner)) as {
    workspaceId: string;
    organizationId: string;
  };
  wsId = theirs.workspaceId;
  ownerOrg = theirs.organizationId;
  const own = (await run(organizationCreate, { businessName: `Staff Desk Co ${mark}` }, staff)) as {
    workspaceId: string;
    organizationId: string;
  };
  staffWs = own.workspaceId;
  staffOrg = own.organizationId;
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
}, 60_000);
afterAll(async () => {
  await admin().execute(sql`delete from platform.idea_areas where id = ${AREA}`);
  await closeTestDbs();
});

describe('a credit through the Assistant', () => {
  it('names the business and says the credit in dollars, and changes nothing before Confirm', async () => {
    const card = await prepareAction('do_wallet_adjust', {
      workspaceId: wsId,
      amountCents: 2500,
      reason: 'Sorry about the outage',
    });
    expect(card.fields).toContainEqual({ label: 'Business', value: BUSINESS });
    expect(card.fields).toContainEqual({ label: 'Credit', value: '$25' });
    expect(JSON.stringify(card.fields)).not.toContain(wsId);
    expect(card.fields.map((f) => f.label)).not.toContain('Amount cents');
    expect(card.warnings.map((w) => w.text)).toContain(
      'This changes their balance, and shows on their statement.',
    );
    // The reference is the worker's to put on, never the model's to give.
    expect(Object.keys(action('do_wallet_adjust').input.shape)).not.toContain('reference');
    expect(await assistantCredits()).toBe(0);
  });

  it('says a taken-back credit as Take back', async () => {
    const card = await prepareAction('do_wallet_adjust', {
      workspaceId: wsId,
      amountCents: -1050,
      reason: 'Credited twice',
    });
    expect(card.fields).toContainEqual({ label: 'Take back', value: '$10.50' });
  });

  it('puts the same card’s credit on once, however many times it is confirmed, and a new card’s again', async () => {
    const args = { workspaceId: wsId, amountCents: 2500, reason: 'Sorry about the outage' };
    const toolCallId = randomUUID();
    const first = await commitAction('do_wallet_adjust', args, toolCallId);
    expect(first.outcome).toBe(`Done. Their balance is now ${money(await balance())}.`);
    const again = await commitAction('do_wallet_adjust', args, toolCallId);
    expect(again.outcome).toBe(
      'That credit was already on their statement, so nothing new went on.',
    );
    expect(await assistantCredits()).toBe(1);
    // Another card for the same amount is another credit, as a second dialog on the screen would be.
    await commitAction('do_wallet_adjust', args);
    expect(await assistantCredits()).toBe(2);
  });
});

describe('moving a business’s wallet stage through the Assistant', () => {
  /** Usage, written the way the worker writes it: under the system's own scope for this business. */
  const use = (cents: number) =>
    admin().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.system_scope.workspace_id', ${wsId}, true)`);
      await tx.execute(
        sql`insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, cost_cents, subject,
              idempotency_key)
            select ${wsId}, organization_id, 'spend', ${-cents}, ${Math.round(cents / 2)}, 'Text to a customer',
                   ${`staff-use-${randomUUID()}`}
            from app.workspaces where id = ${wsId}`,
      );
    });

  it('says the stage in the screen’s words, what moving off Paid by the agency writes off, and what Stopped at zero stops', async () => {
    await run(walletSetStage, { workspaceId: wsId, stage: 'agency', reason: 'Our own' }, staff);
    await use((await balance()) + 5_000);
    expect(await balance()).toBe(-5_000);

    const card = await prepareAction('do_wallet_set_stage', {
      workspaceId: wsId,
      stage: 'enforce',
      reason: 'They have a card on file now',
    });
    expect(card.fields).toContainEqual({ label: 'Business', value: BUSINESS });
    expect(card.fields).toContainEqual({
      label: 'Move to',
      value: DESK_WALLET_STAGES.enforce.label,
    });
    const warnings = card.warnings.map((w) => w.text);
    expect(warnings).toContain(DESK_WALLET_WORDS.writtenOff(5_000));
    expect(warnings).toContain(DESK_WALLET_WORDS.enforceWarning);
    expect(action('do_wallet_set_stage').description).not.toMatch(/silent/i);

    // Warned writes it off too, and stops nothing.
    const warn = await prepareAction('do_wallet_set_stage', {
      workspaceId: wsId,
      stage: 'warn',
      reason: 'They have a card on file now',
    });
    expect(warn.warnings.map((w) => w.text)).toEqual([
      'This changes what happens when their balance runs out.',
      DESK_WALLET_WORDS.writtenOff(5_000),
    ]);
  });
});

describe('answering a ticket through the Assistant', () => {
  it('names the ticket, and says an answer is emailed to whoever wrote in and a note isn’t', async () => {
    const subject = `Texts stopped going out ${mark}`;
    const { ticketId, number } = (await run(
      supportRequestCreate,
      { workspaceId: wsId, subject, body: 'Nothing has gone out since Monday.' },
      owner,
    )) as { ticketId: string; number: number };

    const answer = await prepareAction('do_support_ticket_reply', {
      ticketId,
      body: 'We found it and fixed it.',
    });
    expect(answer.fields).toContainEqual({ label: 'Ticket', value: `#${number} ${subject}` });
    expect(JSON.stringify(answer.fields)).not.toContain(ticketId);
    expect(answer.warnings.map((w) => w.text)).toEqual([
      'This emails your answer to the person who wrote in. Make it an internal note to keep it to the team.',
    ]);

    const note = await prepareAction('do_support_ticket_reply', {
      ticketId,
      body: 'Their carrier dropped the registration.',
      internal: true,
    });
    expect(note.warnings).toEqual([]);
  });
});

describe('the desk’s own saves', () => {
  it('keeps a support person’s sign-off when only their name changes, and reads both back', async () => {
    await run(
      supportStaffSaveProfile,
      { displayName: 'Sam at HandsFreeOS', signature: 'Thanks, Sam' },
      staff,
    );
    const args = { displayName: 'Sam from HandsFreeOS' };
    const card = await prepareAction('do_support_staff_save_profile', args);
    expect(card.fields.map((f) => f.value)).toContain('Thanks, Sam');
    await commitAction('do_support_staff_save_profile', args);
    const me = (await readScreen('platform.me', {})) as {
      staff: { displayName: string; signature: string; role: string };
    };
    expect(me.staff).toMatchObject({
      displayName: 'Sam from HandsFreeOS',
      signature: 'Thanks, Sam',
      role: 'admin',
    });
  });

  it('keeps an idea area’s description and place when it is renamed or archived', async () => {
    await run(
      ideaAreaSave,
      { id: AREA, name: `Staff area ${mark}`, description: 'For the desk test', sort: 900 },
      staff,
    );
    const area = async () =>
      ((await readScreen('idea.areas', {})) as { areas: Record<string, unknown>[] }).areas.find(
        (a) => a['id'] === AREA,
      );

    const rename = { id: AREA, name: `Renamed area ${mark}` };
    await prepareAction('do_idea_area_save', rename);
    await commitAction('do_idea_area_save', rename);
    expect(await area()).toMatchObject({
      name: `Renamed area ${mark}`,
      description: 'For the desk test',
      sort: 900,
      archived: false,
    });

    const archive = { id: AREA, name: `Renamed area ${mark}`, archived: true };
    await commitAction('do_idea_area_save', archive);
    // Archived areas still come back, as the Admin area's list shows them.
    expect(await area()).toMatchObject({ description: 'For the desk test', archived: true });
  });

  it('turns HandsFreeOS’s own New support tickets alert off for its support people', async () => {
    const tool = assistantToolByName.get('update_my_support_alerts')!;
    const parsed = tool.input.parse({ turnOff: ['supportTickets'] }) as Record<string, unknown>;
    const executor = createToolExecutor(api());
    const { card } = await executor.prepare(tool, parsed, ctxFor(staff), randomUUID());
    expect((card as ConfirmCard).fields).toEqual([
      { label: 'Phone alert: New support tickets', value: 'Off' },
    ]);
    await executor.commit(tool, parsed, ctxFor(staff), { toolCallId: randomUUID() });
    const [me] = await rows<{ on: boolean }>(
      admin(),
      sql`select (settings->'push'->>'supportTickets')::boolean as on from app.users where id = ${staff.id}`,
    );
    expect(me?.on).toBe(false);
    // Everyone's alerts never name it.
    expect(
      assistantToolByName.get('update_my_alerts')!.input.safeParse({ turnOff: ['supportTickets'] })
        .success,
    ).toBe(false);
  });
});

describe('ideas, as the team sees them', () => {
  it('gives each comment its id and author, and shows the team the ones taken down', async () => {
    const { ideaId } = (await run(
      ideaShare,
      { workspaceId: wsId, title: `Desk test idea ${mark}`, areaId: 'other' },
      owner,
    )) as { ideaId: string };
    const { commentId } = (await run(ideaComment, { ideaId, body: 'Please, soon.' }, owner)) as {
      commentId: string;
    };
    await run(ideaSetCommentHidden, { commentId, hidden: true }, owner);

    const team = await runTool('find_ideas', { ideaId });
    expect(team['comments']).toEqual([
      {
        commentId,
        by: expect.stringMatching(/^Dana/),
        takenDown: true,
        on: expect.any(String),
        words: { someone_wrote: 'Please, soon.' },
      },
    ]);
    // Its author, like anyone not on the team, sees it gone.
    expect((await runTool('find_ideas', { ideaId }, owner))['comments']).toEqual([]);
  });
});

describe('the desk’s own reads', () => {
  it('offers who the person is on the desk to staff alone, and the idea areas to everyone', () => {
    const ownerReads = screenReadToolsFor((p) => hasWorkspacePermission('owner', p)).map(
      (t) => t.query.name,
    );
    const agentReads = screenReadToolsFor((p) => hasStaffPermission('agent', p)).map(
      (t) => t.query.name,
    );
    expect(ownerReads).not.toContain('platform.me');
    expect(agentReads).toContain('platform.me');
    expect(ownerReads).toContain('idea.areas');
  });

  it('tells only HandsFreeOS’s support people about New support tickets among their own alerts', async () => {
    // Every save of the phone alerts writes each switch, New support tickets' too, whoever saves them.
    await run(userUpdateProfile, { settings: { push: pushSwitchesOf({}) } }, owner);
    const mine = async (u: TestUser) =>
      (await runTool('get_settings', { area: 'my_account' }, u))['me'] as {
        alerts: { title: string }[];
      };
    const theirs = await mine(owner);
    expect(theirs.alerts.map((a) => a.title)).toContain('A customer pays');
    expect(theirs.alerts.map((a) => a.title)).not.toContain('New support tickets');
    expect(JSON.stringify(theirs)).not.toMatch(/supportTickets|support ticket/i);
    expect((await mine(staff)).alerts.map((a) => a.title)).toContain('New support tickets');
  });

  it('lists the add-ons in testing on a business’s page, and whether it was handed each', async () => {
    const got = (await readScreen('platform.business.get', { workspaceId: wsId })) as {
      business: { name: string };
      addonsInTesting: { addonId: string; name: string; handedOut: string }[];
    };
    expect(got.business.name).toBe(BUSINESS);
    expect(got.addonsInTesting).toContainEqual(
      expect.objectContaining({ addonId: 'salescoach', handedOut: 'not handed out' }),
    );
    for (const a of got.addonsInTesting)
      expect(['they can add it', 'not handed out']).toContain(a.handedOut);
  });

  it('gives Getting started’s Matomo report over the same days', async () => {
    const got = (await readScreen('platform.onboarding.counts', { days: 14 })) as {
      matomoUrl: string;
    };
    expect(got.matomoUrl).toBe(deskMatomoPagesUrl(14));
  });

  it('reads Assistant coverage as the Admin area’s page shows it', async () => {
    const got = await runTool('read_assistant_coverage', {});
    expect(got['counts']).toEqual(
      expect.arrayContaining([{ what: expect.any(String), count: expect.anything() }]),
    );
    expect(got['never']).toEqual(
      expect.arrayContaining([{ what: expect.any(String), why: expect.any(String) }]),
    );
    expect(got['note']).toContain('read_platform_assistant_ledger');
  });
});
