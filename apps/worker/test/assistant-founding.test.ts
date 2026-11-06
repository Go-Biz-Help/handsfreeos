/**
 * Approving a founding seat through the Assistant (Admin area → Founding, staff only). A paid seat's claim link is
 * shown once, the way the Admin area's dialog shows it: on the card after Confirm, written out whole on the app's
 * own address. Nothing kept for the model or the chat ever has it; they keep that it was approved and the seat is
 * held. A free seat goes on at once, with no link at all.
 */
import { randomUUID } from 'node:crypto';
import {
  executeCommand,
  organizationCreate,
  type AssistantCard,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { screenActionToolByName } from '../src/assistant/tools-screen-actions';
import { createToolExecutor } from '../src/assistant/tools-write';

const ORIGIN = 'https://app.handsfreeos.test';
const FREE = 'test_ast_founding_free';
const PAID = 'test_ast_founding_paid';
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

let staff: TestUser;
let owner: TestUser;
let orgId: string;
let wsId: string;

const ctx = (): ToolContext => ({
  actor: actor(staff),
  workspaceId: wsId,
  organizationId: orgId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});
const approve = () => screenActionToolByName('do_founding_approve')!;
const apply = async (offer: string): Promise<string> => {
  const [row] = await rows<{ id: string }>(
    admin(),
    sql`insert into platform.founding_applications (offer_id, business_name, contact_name, email)
        values (${offer}, 'Founding Assistant Plumbing', 'Dana', ${`${randomUUID()}@hfos.test`}) returning id`,
  );
  return row!.id;
};
const cleanUp = async () => {
  for (const offer of [FREE, PAID]) {
    await admin().execute(sql`delete from platform.founding_checkouts where offer_id = ${offer}`);
    await admin().execute(
      sql`delete from platform.founding_applications where offer_id = ${offer}`,
    );
    await admin().execute(sql`delete from platform.founding_grants where offer_id = ${offer}`);
    await admin().execute(sql`delete from platform.founding_offers where id = ${offer}`);
  }
};

beforeAll(async () => {
  [staff, owner] = await Promise.all([
    createTestUser('ast-founding-staff'),
    createTestUser('ast-founding-owner', { fullName: 'Dana Owner' }),
  ]);
  // The business first: an open paid offer makes every business made after it pick a plan first.
  const org = (
    await executeCommand(
      api(),
      organizationCreate,
      { businessName: 'Founding Assistant Plumbing' },
      actor(owner),
      { correlationId: randomUUID(), channel: 'test' },
    )
  ).output;
  orgId = org.organizationId;
  wsId = org.workspaceId;
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
  await cleanUp();
  await admin().execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, starting_credit_cents, show_counter)
        values (${FREE}, 'Founding Partner', 5, 0, 'open', 1000, false),
               (${PAID}, 'Founding Customer', 5, 49700, 'open', 1000, false)`,
  );
});
afterAll(async () => {
  await cleanUp();
  await admin().execute(sql`delete from app.workspace_plans where workspace_id = ${wsId}`);
  await closeTestDbs();
});

describe('approving a founding seat through the Assistant', () => {
  it('says on its card that a paid seat’s claim link shows there once, after Confirm', async () => {
    const applicationId = await apply(PAID);
    const { card } = await createToolExecutor(api(), null, null, ORIGIN).prepare(
      approve(),
      { applicationId, organizationId: orgId },
      ctx(),
      randomUUID(),
    );
    const warning = (card as Extract<AssistantCard, { type: 'confirm' }>).warnings[0]?.text;
    expect(warning).toContain('A free seat goes on their business at once.');
    expect(warning).toContain('its claim link shows on this card once, after you confirm');
    // Drawn, not done: the application still waits.
    expect(
      await rows(
        admin(),
        sql`select status from platform.founding_applications where id = ${applicationId}`,
      ),
    ).toEqual([{ status: 'pending' }]);
  });

  it('shows a paid seat’s claim link on the card once, whole, and keeps only that the seat is held', async () => {
    const applicationId = await apply(PAID);
    const done = await createToolExecutor(api(), null, null, ORIGIN).commit(
      approve(),
      { applicationId, organizationId: orgId },
      ctx(),
      { toolCallId: randomUUID() },
    );
    const link = new RegExp(
      `^Approved, and their seat is held\\. Copy this claim link into an email to them now\\. It works once, for an owner or admin of their business, until .+\\. It isn’t shown again: ${ORIGIN}/founding/([0-9a-f]{64})$`,
    ).exec(done.shownOnce ?? '');
    expect(link).not.toBeNull();
    const claimToken = link![1]!;
    expect(done.outcome).toMatch(
      /^Approved, and their seat is held\. The claim link showed on this card once, when you confirmed, and isn’t kept\. It works once, for an owner or admin of their business, until .+\.$/,
    );
    expect(done.answer).toMatchObject({
      offerId: PAID,
      status: 'reserved',
      workspaceId: null,
      expiresAt: expect.any(String),
    });
    expect(done.answer).not.toHaveProperty('claimToken');
    expect(JSON.stringify([done.outcome, done.answer])).not.toContain(claimToken);
    expect(
      await rows(
        admin(),
        sql`select status from platform.founding_applications where id = ${applicationId}`,
      ),
    ).toEqual([{ status: 'approved' }]);
  });

  it('turns a free seat on with no link to pass on', async () => {
    const done = await createToolExecutor(api(), null, null, ORIGIN).commit(
      approve(),
      { applicationId: await apply(FREE), organizationId: orgId, workspaceId: wsId },
      ctx(),
      { toolCallId: randomUUID() },
    );
    expect(done).toMatchObject({
      outcome: 'Done',
      command: 'founding.approve',
      answer: { offerId: FREE, status: 'active', workspaceId: wsId },
    });
    expect(done.shownOnce).toBeUndefined();
  });
});
