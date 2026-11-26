/**
 * add_expense (the owner, 25 Nov 2026: "I snap a receipt, it gets filed, and each month I see money in and money
 * out"): a photo of a receipt becomes a card with what the Assistant read off it; Confirm files the expense as the
 * person, with the photo kept as its receipt, and the staged copy goes. Only whoever manages money is offered it.
 * Every business and purchase here is made up.
 */
import { randomUUID } from 'node:crypto';
import { AssistantCard, assistantToolByName, expenseList } from '@hfos/core/server';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { rows, sql } from '@hfos/db/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STAGING_BUCKET, stagedPath } from '../src/housekeeping/assistant-staging';
import type { ToolContext } from '../src/assistant/runtime';
import { createToolExecutor } from '../src/assistant/tools-write';
import { admin, makeWorld, query, type World } from './booking-world';
import { consentToAssistant } from './assistant-consent';

let w: World;
let member: TestUser;

// A 1×1 JPEG: a receipt as the model would have seen it.
const RECEIPT =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

beforeAll(async () => {
  w = await makeWorld('expenses');
  member = await createTestUser('expenses-member');
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${w.workspaceId}, ${member.id}, 'member')`,
  );
  await consentToAssistant(w.owner, member);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

type Confirm = Extract<AssistantCard, { type: 'confirm' }>;

const ctx = (who: TestUser = w.owner, pictures = 1): ToolContext => ({
  actor: { type: 'human', userId: who.id, email: who.email, claims: who.claims },
  workspaceId: w.workspaceId,
  organizationId: w.organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
  pictures: Array.from({ length: pictures }, () => ({
    mediaType: 'image/jpeg' as const,
    data: RECEIPT,
  })),
});
const tools = () =>
  createToolExecutor(testDbs().worker.db, null, null, '', undefined, { services: w.s });
const tool = () => assistantToolByName.get('add_expense')!;
const argsOf = (args: Record<string, unknown>) =>
  tool().input.parse(args) as Record<string, unknown>;

const SHELL = {
  spentOn: '2026-11-24',
  amountCents: 4_250,
  taxCents: 312,
  vendor: 'Shell',
  category: 'fuel',
  paidWith: 'card',
  note: 'Gas for the work truck',
  receiptPicture: 1,
};

describe('add_expense', () => {
  it('reads a receipt onto a card, and files it with the photo on Confirm', async () => {
    const args = argsOf(SHELL);
    const callId = randomUUID();
    const prepared = await tools().prepare(tool(), args, ctx(), callId);
    const card = prepared.card as Confirm;
    expect(AssistantCard.safeParse(card).success).toBe(true);
    expect(card.title).toBe('File $42.50 at Shell?');
    expect(card.fields).toEqual([
      { label: 'Paid to', value: 'Shell' },
      { label: 'Amount', value: '$42.50, $3.12 of it tax' },
      { label: 'Day', value: 'Tue, Nov 24, 2026' },
      { label: 'Category', value: 'Gas and fuel' },
      { label: 'Paid with', value: 'Card' },
      { label: 'Note', value: 'Gas for the work truck' },
      { label: 'Receipt', value: 'The picture they sent' },
    ]);
    // Nothing is filed yet; the photo waits for Confirm.
    const staged = stagedPath(w.workspaceId, callId, 'jpg');
    expect(await w.s.store.exists(STAGING_BUCKET, staged)).toBe(true);
    const before = await query(w, expenseList, { workspaceId: w.workspaceId });
    expect(before.count).toBe(0);

    const done = await tools().commit(tool(), args, ctx(), { toolCallId: callId });
    expect(done.outcome).toBe('Filed $42.50 at Shell under Gas and fuel, with the receipt.');
    expect(done.href).toBe(`/app/w/${w.workspaceId}/money/expenses`);
    const after = await query(w, expenseList, { workspaceId: w.workspaceId });
    expect(after.expenses).toHaveLength(1);
    const filed = after.expenses[0]!;
    expect(filed).toMatchObject({
      spentOn: '2026-11-24',
      amountCents: 4_250,
      taxCents: 312,
      vendor: 'Shell',
      category: 'fuel',
      paidWith: 'card',
      note: 'Gas for the work truck',
      source: 'assistant',
    });
    expect(filed.receipt).toMatchObject({
      name: 'Receipt Shell 2026-11-24.jpg',
      mimeType: 'image/jpeg',
    });
    expect(await w.s.store.exists(filed.receipt!.bucket, filed.receipt!.objectPath)).toBe(true);
    expect(await w.s.store.exists(STAGING_BUCKET, staged)).toBe(false);
  });

  it('files one with no receipt from what they said', async () => {
    const args = argsOf({
      ...SHELL,
      vendor: 'Joe’s Diner',
      category: 'meals',
      receiptPicture: undefined,
    });
    const callId = randomUUID();
    const card = (await tools().prepare(tool(), args, ctx(w.owner, 0), callId)).card as Confirm;
    expect(card.fields).toContainEqual({ label: 'Receipt', value: 'None' });
    const done = await tools().commit(tool(), args, ctx(w.owner, 0), { toolCallId: callId });
    expect(done.outcome).toBe('Filed $42.50 at Joe’s Diner under Meals.');
  });

  it('says so when the picture it names didn’t come', async () => {
    await expect(
      tools().prepare(tool(), argsOf({ ...SHELL, receiptPicture: 2 }), ctx(), randomUUID()),
    ).rejects.toThrow('Only one picture came with this question.');
  });

  it('isn’t offered to someone who doesn’t manage money, and refuses them anyway', async () => {
    await expect(
      tools().prepare(tool(), argsOf(SHELL), ctx(member), randomUUID()),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
