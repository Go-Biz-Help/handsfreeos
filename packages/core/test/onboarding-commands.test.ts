/**
 * Getting started on the local database (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §4–§5):
 * - **The status** reads every setup area as the person asking: an owner gets the business's steps in the order the
 *   answers set; a teammate gets only their own list.
 * - **The answers** are kept on the business, and the website with them, typed as people type it.
 * - **Skipping** a business step needs workspace.update and is kept on the business; a step on a person's own list
 *   is kept on the person, per business.
 * - **Finishing** is refused while a step is open, names what's left, and holds once it's done.
 * - **"Email me a link"** sends a step on the person's own list once, not twice in a row, and never a step done
 *   on the phone itself.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, RequestMeta } from '../src/kernel/types';
import {
  onboardingAsYouGo,
  onboardingFinish,
  onboardingSaveAnswers,
  onboardingSendLink,
  onboardingSetView,
  onboardingSkip,
  onboardingStatus,
  organizationCreate,
  personCreate,
  workspaceGet,
  workspaceUpdate,
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
const status = (u: TestUser, workspaceId: string, device?: Record<string, boolean>) =>
  executeQuery(api(), onboardingStatus, { workspaceId, device }, human(u), meta());
const stateOf = (s: Awaited<ReturnType<typeof status>>, key: string) =>
  s.steps.find((x) => x.key === key)?.state;

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

let dale: TestUser;
let marco: TestUser;
let ws: string;
let orgId: string;
let secondWs: string;

beforeAll(async () => {
  [dale, marco] = await Promise.all([
    createTestUser('onb-owner', { fullName: 'Dale Owner' }),
    createTestUser('onb-member', { fullName: 'Marco Member' }),
  ]);
  const org = await run(organizationCreate, { businessName: 'Onboarding HVAC' }, dale);
  ws = org.workspaceId;
  orgId = org.organizationId;
  secondWs = (await run(organizationCreate, { businessName: 'Second Roofing' }, dale)).workspaceId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${marco.id}, 'member')`,
  );
  // Something of Dale's own that finishing the guide must leave alone.
  await rows(
    admin(),
    sql`update app.users set settings = settings || '{"menu":{"kept":true}}'::jsonb where id = ${dale.id}`,
  );
});
afterAll(closeTestDbs);

describe('onboarding.status', () => {
  it('gives an owner of a new business the business’s steps, the number first', async () => {
    const s = await status(dale, ws);
    expect(s.audience).toBe('business');
    expect(s.steps.filter((x) => x.mustDo).map((x) => x.key)).toEqual([
      'number',
      'customers',
      'calendar',
      'ai',
    ]);
    // Marco is a member, so the team step is already done; nothing else is.
    expect(stateOf(s, 'team')).toBe('done');
    expect(s.steps.filter((x) => x.key !== 'team').every((x) => x.state === 'todo')).toBe(true);
    expect(s).toMatchObject({ done: 1, total: 9 });
    expect(s).toMatchObject({ next: 'number', complete: false, answers: null });
    expect(s.view).toEqual({ hidden: false, tourDoneAt: null, finishedAt: null, show: true });
  });

  it('gives a teammate only their own list', async () => {
    const s = await status(marco, ws);
    expect(s.audience).toBe('personal');
    expect(s.steps.map((x) => x.key)).toEqual(['app', 'notifications', 'my_calendar', 'sign_in']);
    // The phone says it's the app; the browser says there's a passkey.
    const onPhone = await status(marco, ws, { app: true, signIn: true });
    expect(stateOf(onPhone, 'app')).toBe('done');
    expect(stateOf(onPhone, 'sign_in')).toBe('done');
  });
});

describe('the answers', () => {
  it('keeps them on the business, reorders the steps, and saves the website as a link', async () => {
    const out = await run(
      onboardingSaveAnswers,
      {
        workspaceId: ws,
        goal: 'paid',
        customersIn: 'ghl',
        teamSize: 'small',
        website: 'onboardinghvac.test',
      },
      dale,
    );
    expect(out.website).toBe('https://onboardinghvac.test');
    const s = await status(dale, ws);
    expect(s.answers).toEqual({ goal: 'paid', customersIn: 'ghl', teamSize: 'small' });
    expect(s.website).toBe('https://onboardinghvac.test');
    expect(s.steps.filter((x) => x.mustDo).map((x) => x.key)).toEqual([
      'number',
      'payments',
      'customers',
      'calendar',
      'ai',
    ]);
    const got = await executeQuery(api(), workspaceGet, { workspaceId: ws }, human(dale), meta());
    expect(got.workspace.settings['website']).toBe('https://onboardinghvac.test');
  });

  it('refuses a website that isn’t one, and says what’s wrong', async () => {
    const err = await expectHfos(
      () =>
        run(
          onboardingSaveAnswers,
          {
            workspaceId: ws,
            goal: 'leads',
            customersIn: 'none',
            teamSize: 'solo',
            website: 'nope',
          },
          dale,
        ),
      'validation',
    );
    expect(err.message).toBe(
      'That website address doesn’t look right. Enter a full web address, like https://example.com.',
    );
  });

  it('can’t be written round, through workspace.update', async () => {
    await expectHfos(
      () =>
        run(
          workspaceUpdate,
          { workspaceId: ws, settings: { onboarding: { answers: null } } },
          dale,
        ),
      'validation',
    );
  });

  it('are only for someone who sets the business up', async () => {
    await expectHfos(
      () =>
        run(
          onboardingSaveAnswers,
          { workspaceId: ws, goal: 'leads', customersIn: 'none', teamSize: 'solo' },
          marco,
        ),
      'forbidden',
    );
  });
});

describe('skipping', () => {
  it('keeps a business step’s skip on the business, and brings it back', async () => {
    expect(await run(onboardingSkip, { workspaceId: ws, step: 'email_chat' }, dale)).toMatchObject({
      skipped: true,
      changed: true,
    });
    expect(await run(onboardingSkip, { workspaceId: ws, step: 'email_chat' }, dale)).toMatchObject({
      changed: false,
    });
    const s = await status(dale, ws);
    expect(stateOf(s, 'email_chat')).toBe('skipped');
    expect(s.skipped).toBe(1);
    await run(onboardingSkip, { workspaceId: ws, step: 'email_chat', skipped: false }, dale);
    expect(stateOf(await status(dale, ws), 'email_chat')).toBe('todo');
    const [e] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where workspace_id = ${ws} and event_type = 'onboarding.step_skipped'`,
    );
    expect(e?.n).toBe(2);
  });

  it('refuses a teammate a business step, and lets them skip their own', async () => {
    const err = await expectHfos(
      () => run(onboardingSkip, { workspaceId: ws, step: 'payments' }, marco),
      'forbidden',
      'onboarding_business_step',
    );
    expect(err.message).toMatch(/^Only an owner or admin of this business can skip that step/);
    await run(onboardingSkip, { workspaceId: ws, step: 'my_calendar' }, marco);
    expect(stateOf(await status(marco, ws), 'my_calendar')).toBe('skipped');
    // Kept on Marco, not on the business: Dale's list doesn't change.
    expect((await status(dale, ws)).skipped).toBe(0);
  });

  it('refuses an owner a step that’s only on a teammate’s list', async () => {
    await expectHfos(
      () => run(onboardingSkip, { workspaceId: ws, step: 'notifications' }, dale),
      'rule_violation',
      'onboarding_not_your_step',
    );
  });
});

describe('the customers step', () => {
  it('counts “Add them as you go”, and a customer added', async () => {
    await run(onboardingAsYouGo, { workspaceId: ws }, dale);
    expect(stateOf(await status(dale, ws), 'customers')).toBe('done');
    await run(onboardingAsYouGo, { workspaceId: ws, asYouGo: false }, dale);
    expect(stateOf(await status(dale, ws), 'customers')).toBe('todo');
    await run(personCreate, { workspaceId: ws, firstName: 'Maria', lastName: 'Lopez' }, dale);
    const s = await status(dale, ws);
    expect(s.steps.find((x) => x.key === 'customers')).toMatchObject({
      state: 'done',
      note: { count: 1 },
    });
  });
});

describe('the team step', () => {
  it('counts an invitation that hasn’t expired, and not one that has', async () => {
    const [ws2] = [secondWs];
    const [org2] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${ws2}`,
    );
    await rows(
      admin(),
      sql`insert into app.invitations (organization_id, workspace_id, email, expires_at)
          values (${org2!.organization_id}, ${ws2}, 'old@example.test', now() - interval '1 day')`,
    );
    expect(stateOf(await status(dale, ws2), 'team')).toBe('todo');
    await rows(
      admin(),
      sql`insert into app.invitations (organization_id, workspace_id, email)
          values (${org2!.organization_id}, ${ws2}, 'new@example.test')`,
    );
    expect(stateOf(await status(dale, ws2), 'team')).toBe('done');
  });
});

describe('hiding the guide and the tour', () => {
  it('keeps them on the person, for this business only', async () => {
    const out = await run(
      onboardingSetView,
      { workspaceId: ws, hidden: true, tourDone: true },
      dale,
    );
    expect(out.hidden).toBe(true);
    expect(out.tourDoneAt).not.toBeNull();
    const again = await run(onboardingSetView, { workspaceId: ws, tourDone: true }, dale);
    expect(again.tourDoneAt).toBe(out.tourDoneAt);
    expect((await status(dale, ws)).view).toMatchObject({ hidden: true, show: false });
    expect((await status(dale, secondWs)).view.show).toBe(true);
    await run(onboardingSetView, { workspaceId: ws, hidden: false }, dale);
    expect((await status(dale, ws)).view.show).toBe(true);
  });
});

describe('finishing', () => {
  it('is refused while a step is open, and names what’s left', async () => {
    const err = await expectHfos(
      () => run(onboardingFinish, { workspaceId: ws }, dale),
      'conflict',
      'onboarding_not_finished',
    );
    expect(err.message).toMatch(
      /steps are still to do: Business number & texting, Connect payments/,
    );
  });

  it('holds once every step is done or skipped, and leaves the rest of the person’s settings alone', async () => {
    const open = (await status(dale, ws)).steps.filter(
      (x) => x.state === 'todo' || x.state === 'needs_fix',
    );
    for (const x of open) await run(onboardingSkip, { workspaceId: ws, step: x.key }, dale);
    const s = await status(dale, ws);
    expect(s.complete).toBe(true);
    const first = await run(onboardingFinish, { workspaceId: ws }, dale);
    const second = await run(onboardingFinish, { workspaceId: ws }, dale);
    expect(second.finishedAt).toBe(first.finishedAt);
    expect((await status(dale, ws)).view).toMatchObject({
      finishedAt: first.finishedAt,
      show: false,
    });
    // Bringing a step back later doesn't bring the guide back.
    await run(onboardingSkip, { workspaceId: ws, step: 'team', skipped: false }, dale);
    expect((await status(dale, ws)).view.show).toBe(false);
    const [u] = await rows<{ settings: Record<string, unknown> }>(
      admin(),
      sql`select settings from app.users where id = ${dale.id}`,
    );
    expect(u!.settings['menu']).toEqual({ kept: true });
    expect(Object.keys(u!.settings['onboarding'] as object)).toEqual([ws]);
    expect(orgId).toBeTruthy();
  });

  it('lets a teammate finish their own list', async () => {
    await expectHfos(() => run(onboardingFinish, { workspaceId: ws }, marco), 'conflict');
    for (const step of ['app', 'notifications', 'sign_in'])
      await run(onboardingSkip, { workspaceId: ws, step }, marco);
    const out = await run(onboardingFinish, { workspaceId: ws }, marco);
    expect(out.finishedAt).toBeTruthy();
  });
});

describe('emailing a link', () => {
  const requested = async (u: TestUser) =>
    rows<{ payload: { step: string; path: string } }>(
      admin(),
      sql`select payload from app.events
          where actor_id = ${u.id} and event_type = 'onboarding.link_requested' and workspace_id = ${ws}
          order by created_at`,
    );

  it('sends the page for a step once, to the person’s own email, and not again straight away', async () => {
    const first = await run(onboardingSendLink, { workspaceId: ws, step: 'customers' }, dale);
    expect(first).toMatchObject({ step: 'customers', email: dale.email, sent: true });
    const again = await run(onboardingSendLink, { workspaceId: ws, step: 'customers' }, dale);
    expect(again.sent).toBe(false);
    // Another step is its own link.
    expect((await run(onboardingSendLink, { workspaceId: ws, step: 'team' }, dale)).sent).toBe(true);
    expect((await requested(dale)).map((e) => e.payload)).toEqual([
      { step: 'customers', path: `/onboarding/${ws}/setup/customers` },
      { step: 'team', path: `/app/w/${ws}/members?invite=1` },
    ]);
  });

  it('keeps to the person’s own list, and has nothing to send for the phone’s own steps', async () => {
    await expectHfos(
      () => run(onboardingSendLink, { workspaceId: ws, step: 'app' }, dale),
      'rule_violation',
      'onboarding_no_link',
    );
    await expectHfos(
      () => run(onboardingSendLink, { workspaceId: ws, step: 'payments' }, marco),
      'forbidden',
      'onboarding_business_step',
    );
    await expectHfos(
      () => run(onboardingSendLink, { workspaceId: ws, step: 'my_calendar' }, dale),
      'rule_violation',
      'onboarding_not_your_step',
    );
    expect(
      await run(onboardingSendLink, { workspaceId: ws, step: 'my_calendar' }, marco),
    ).toMatchObject({ email: marco.email, sent: true });
  });
});
