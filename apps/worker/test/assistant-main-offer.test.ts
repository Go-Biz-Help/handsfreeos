import { randomUUID } from 'node:crypto';
import {
  assistantToolByName,
  catalogAddon,
  executeCommand,
  executeQuery,
  hasWorkspacePermission,
  mainOfferBoxLabel,
  MainOfferParts,
  organizationCreate,
  registry,
  type AssistantCard,
  type HumanActor,
  type MainOfferGetOutput,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import { toolsFor } from '../src/assistant/context';
import type { ToolContext } from '../src/assistant/runtime';
import {
  mainOfferAutoTools,
  mainOfferConfirmTools,
  mainOfferStepLabels,
} from '../src/assistant/tools-main-offer';
import { createToolExecutor } from '../src/assistant/tools-write';
import { testServices } from './helpers';

/**
 * The main offer by asking (docs/main-offer.md): the Assistant changes any box of it, scores it, writes a try and
 * takes its parts in, and puts it live, as Settings → Main offer does. Each change shows its card and does nothing
 * until Confirm; it goes live only once every part clears the bar, or with the person's own reason.
 */

const db = () => testDbs().worker.db;
const admin = () => testDbs().admin.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});

let owner: TestUser;
let workspaceId: string;
let organizationId: string;

const s = testServices({ ai: { provider: scriptedAi(), dailyTokens: 5_000_000 } });
const tools = () => createToolExecutor(db(), { ai: s.ai, log: s.log, wallet: s.wallet });

const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: 'America/Chicago',
});

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
const prepare = async (name: string, args: Record<string, unknown>) => {
  const tool = assistantToolByName.get(name)!;
  const parsed = tool.input.parse(args) as Record<string, unknown>;
  const out = await tools().prepare(tool, parsed, ctx(), randomUUID());
  return { card: out.card as ConfirmCard, parsed };
};
const confirm = (name: string, parsed: Record<string, unknown>) =>
  tools().commit(assistantToolByName.get(name)!, parsed, ctx(), { toolCallId: randomUUID() });
const run = async (name: string, args: Record<string, unknown> = {}) => {
  const tool = assistantToolByName.get(name)!;
  return (await tools().run(tool, tool.input.parse(args) as never, ctx())) as {
    result: Record<string, unknown>;
  };
};
const field = (card: ConfirmCard, label: string) =>
  card.fields.find((f) => f.label === label)?.value;
const offer = async () =>
  (await executeQuery(db(), registry.query('main_offer.get')!, { workspaceId }, actor(owner), {
    correlationId: randomUUID(),
    channel: 'test' as const,
  })) as MainOfferGetOutput;

const complete = MainOfferParts.parse({
  who: { work: 'Roofers', slice: 'with 2 to 3 crews', problem: 'No steady jobs' },
  outcome: { result: '10 to 20 booked inspections a month' },
  timeframe: { typical: '60 days' },
  method: { steps: ['Find the homes', 'Run the ads', 'Book the calls'] },
  guarantee: { promise: 'If you don’t get 10 in 60 days, you don’t pay' },
  price: { amount: '$2,000 a month' },
  line: 'We help roofers with 2 to 3 crews get 10 to 20 booked inspections a month.',
  inAFewWords: { outcome: '10 to 20 booked inspections', guarantee: 'you only pay for results' },
});

/** Every box of an offer as the tool takes them. */
const boxesOf = (parts: MainOfferParts) => [
  { path: 'who.work', words: parts.who.work ?? '' },
  { path: 'who.slice', words: parts.who.slice ?? '' },
  { path: 'who.problem', words: parts.who.problem ?? '' },
  { path: 'outcome.result', words: parts.outcome.result ?? '' },
  { path: 'timeframe.typical', words: parts.timeframe.typical ?? '' },
  { path: 'guarantee.promise', words: parts.guarantee.promise ?? '' },
  { path: 'price.amount', words: parts.price.amount ?? '' },
  { path: 'line', words: parts.line ?? '' },
  { path: 'inAFewWords.outcome', words: parts.inAFewWords.outcome ?? '' },
  { path: 'inAFewWords.guarantee', words: parts.inAFewWords.guarantee ?? '' },
];

beforeAll(async () => {
  owner = await createTestUser('aoffer-owner', { fullName: 'Olive Owner' });
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Summit Roofing Help' },
    actor(owner),
    { correlationId: randomUUID(), channel: 'test' as const },
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
}, 60_000);
afterAll(closeTestDbs);

describe('the main offer tools', () => {
  it('each has a step label, and goes only to people who build the offer', () => {
    const names = [...Object.keys(mainOfferAutoTools), ...Object.keys(mainOfferConfirmTools)];
    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(assistantToolByName.get(name), name).toBeTruthy();
      expect(mainOfferStepLabels[name], name).toBeTruthy();
      expect(assistantToolByName.get(name)!.autonomy, name).toBe(
        name in mainOfferAutoTools ? 'auto' : 'confirm',
      );
    }
    const member = toolsFor((p) => hasWorkspacePermission('member', p)).map((t) => t.name);
    const adminTools = toolsFor((p) => hasWorkspacePermission('admin', p)).map((t) => t.name);
    for (const name of names) {
      expect(member, name).not.toContain(name);
      expect(adminTools, name).toContain(name);
    }
  });

  it('says so before any card while no add-on that uses the offer is on', async () => {
    await expect(
      prepare('edit_main_offer', { boxes: [{ path: 'who.work', words: 'Roofers' }] }),
    ).rejects.toMatchObject({ rule: 'main_offer_not_in_use' });
    await rows(
      admin(),
      sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
          values (${workspaceId}, 'outreach', 'enabled', ${catalogAddon('outreach').version})`,
    );
  });

  it('builds the first version and puts it live on Confirm, once every part clears the bar', async () => {
    const { card, parsed } = await prepare('edit_main_offer', {
      boxes: boxesOf(complete),
      steps: complete.method.steps,
      goLive: true,
    });
    expect(card.title).toBe('Change your main offer and put it live as version 1');
    expect(field(card, mainOfferBoxLabel('who.work'))).toBe('Roofers');
    expect(card.warnings.map((w) => w.text).join(' ')).toContain('every part scores 7 or more');
    expect((await offer()).live).toBeNull();
    const done = await confirm('edit_main_offer', parsed);
    expect(done.outcome).toMatch(/^Version 1 is live\. Scores: Who 8, .*Price 8\.$/);
    expect(done.command).toBe('main_offer.publish');
    const now = await offer();
    expect(now.live?.version).toBe(1);
    expect(now.live?.parts.guarantee.promise).toBe(complete.guarantee.promise);
    expect(now.draft).toBeNull();
  });

  it('changes one box in a draft from the live version, scored, and leaves the live one running', async () => {
    const promise = 'If one lead waits past 30 seconds, that month is free';
    const { card, parsed } = await prepare('edit_main_offer', {
      boxes: [
        { path: 'guarantee.promise', words: promise },
        // The same as now: no change, so not on the card.
        { path: 'who.work', words: 'Roofers' },
      ],
    });
    expect(card.title).toBe('Start a new draft of your main offer');
    expect(card.fields).toEqual([
      { label: mainOfferBoxLabel('guarantee.promise'), value: promise },
      { label: 'Was', value: complete.guarantee.promise },
    ]);
    expect(card.confirmLabel).toBe('Save to the draft');
    expect((await offer()).draft).toBeNull();
    const done = await confirm('edit_main_offer', parsed);
    expect(done.outcome).toMatch(/^Saved to the draft\. Scores: /);
    const now = await offer();
    expect(now.live?.version).toBe(1);
    expect(now.draft?.parts.guarantee.promise).toBe(promise);
    expect(now.draft?.parts.who.work).toBe('Roofers');
    expect(now.draft?.score?.parts.guarantee.score).toBe(8);
  });

  it('turns back a change that says what the offer already says', async () => {
    await expect(
      prepare('edit_main_offer', { boxes: [{ path: 'who.work', words: 'Roofers' }] }),
    ).rejects.toMatchObject({ rule: 'main_offer_nothing_to_change' });
  });

  it('holds a draft under the bar back from going live, until the person gives their reason', async () => {
    const { parsed } = await prepare('edit_main_offer', {
      boxes: [{ path: 'price.amount', words: '[price] a month' }],
      goLive: true,
    });
    const held = await confirm('edit_main_offer', parsed);
    expect(held.outcome).toMatch(/^It isn’t live yet: Price \(6\) is under the 7 it needs\./);
    expect(held.outcome).toContain('Say if it should go live anyway, and why.');
    expect((await offer()).live?.version).toBe(1);

    const plain = await prepare('main_offer_go_live', {});
    expect(plain.card.title).toBe('Put version 2 of your main offer live');
    expect(field(plain.card, 'Price (6)')).toContain('[price] a month');
    expect(plain.card.warnings[0]!.text).toBe(
      'Price (6) is under 7, so it won’t go live without a reason.',
    );
    const anyway = await prepare('main_offer_go_live', {
      anyway: 'We test the price on the call',
    });
    expect(anyway.card.warnings[0]!.text).toContain('because: “We test the price on the call”');
    const done = await confirm('main_offer_go_live', anyway.parsed);
    expect(done.outcome).toMatch(/^Version 2 is live\./);
    const now = await offer();
    expect(now.live?.version).toBe(2);
    expect(now.live?.anyway).toBe('We test the price on the call');
  });

  it('scores a draft, and says there is none to score when there isn’t', async () => {
    await expect(run('score_main_offer')).rejects.toMatchObject({ rule: 'main_offer_no_draft' });
    await confirm(
      'edit_main_offer',
      (
        await prepare('edit_main_offer', {
          boxes: [{ path: 'price.amount', words: '$2,000 a month' }],
        })
      ).parsed,
    );
    const { result } = await run('score_main_offer');
    expect(result).toMatchObject({ bar: 7, clearsBar: true, parts: { price: { score: 8 } } });
  });

  it('writes a try beside the draft, and takes the parts the person picks in on Confirm', async () => {
    const before = (await offer()).draft!.parts;
    const { result } = await run('try_main_offer', {
      notes: { who: 'Wider: anyone who lives on leads' },
    });
    expect(result['next']).toContain('Nothing changed yet');
    expect((await offer()).draft!.parts).toEqual(before);
    const { card, parsed } = await prepare('manage_main_offer', {
      action: 'take_from_try',
      tryId: result['tryId'],
      take: ['who'],
    });
    expect(card.title).toBe(`Take the who from try ${String(result['number'])} into your draft`);
    const done = await confirm('manage_main_offer', parsed);
    expect(done.outcome).toMatch(/^The who is in the draft\./);
    expect((await offer()).draft!.parts.who).not.toEqual(before.who);
  });

  it('sets the direction and the names, and throws the draft away, each on Confirm', async () => {
    const direction = await prepare('manage_main_offer', {
      action: 'set_direction',
      direction: 'Lead with speed: every lead answered in 30 seconds.',
    });
    expect(direction.card.warnings[0]!.text).toContain('scored again');
    await confirm('manage_main_offer', direction.parsed);
    expect((await offer()).direction).toBe('Lead with speed: every lead answered in 30 seconds.');

    const names = await prepare('manage_main_offer', {
      action: 'set_names',
      names: ['Go Biz Help', 'HandsFreeOS'],
    });
    expect(field(names.card, 'Names')).toBe('Go Biz Help, HandsFreeOS');
    expect((await confirm('manage_main_offer', names.parsed)).outcome).toBe(
      'It goes by Go Biz Help, HandsFreeOS',
    );

    const discard = await prepare('manage_main_offer', { action: 'discard_draft' });
    expect(discard.card.warnings[0]!.text).toBe('Version 2 stays live as it is.');
    await confirm('manage_main_offer', discard.parsed);
    const now = await offer();
    expect(now.draft).toBeNull();
    expect(now.live?.version).toBe(2);
    expect(now.names).toEqual(['Go Biz Help', 'HandsFreeOS']);
  });
});
