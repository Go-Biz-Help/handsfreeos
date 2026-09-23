/**
 * Settings → Automations' pipeline rows (stage 3b), on the real database:
 * - "Move deals along for you": a quote going out moves the deal to the stage whose name says so, with the reason
 *   on its timeline; the customer accepting moves it to won. Forward only: a deal someone moved back by hand
 *   stays until something new happens.
 * - "Deal in the wrong stage": with the moves switched off, a deal that's behind a day later gets a card, and its
 *   one press (`lead.catch_up`) moves it.
 * - "Add people you're talking with": a customer with no deal who wrote twice and got a reply gets one.
 * - "Went quiet after a price": two days after a price in a text with no answer, a card; their reply ends it.
 */
import {
  automationsSaveSettings,
  defaultAutomationSettings,
  estimateMarkAccepted,
  leadCatchUp,
  leadCreate,
  leadMoveStage,
  messageSend,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attentionWorld,
  filedCustomer,
  itemOf,
  runSweep,
  typedLead,
  type AttentionWorld,
} from './attention-world';
import { textIn } from './ai-team-world';
import { admin, drain, run as runAs } from './booking-world';
import { moneyWorld, run, sentEstimate, type MoneyWorld } from './money-world';

const DAY = 86_400_000;
let m: MoneyWorld;
let w: AttentionWorld;

beforeAll(async () => {
  m = await moneyWorld('pipe');
  w = await attentionWorld('talk');
});
afterAll(async () => {
  await m?.app.close();
  await w?.app.close();
  await closeTestDbs();
});

async function stageOf(leadId: string): Promise<{ name: string; status: string }> {
  const [l] = await rows<{ name: string; status: string }>(
    admin(),
    sql`select s.name, l.status::text as status from app.leads l
        join app.pipeline_stages s on s.id = l.stage_id where l.id = ${leadId}`,
  );
  return l!;
}

async function timeline(leadId: string): Promise<string[]> {
  const list = await rows<{ body: string }>(
    admin(),
    sql`select body from app.activities where lead_id = ${leadId} and kind = 'system'
          and subtype in ('stage_changed', 'won') order by occurred_at, created_at`,
  );
  return list.map((r) => r.body);
}

const setMoves = (on: boolean) => {
  const s = defaultAutomationSettings();
  return run(m, automationsSaveSettings, {
    workspaceId: m.workspaceId,
    settings: { ...s, switches: { ...s.switches, pipelineMoves: on } },
  });
};

describe('moving deals along', () => {
  it('moves a deal when a quote goes out and wins it when they accept, saying why', async () => {
    const { leadId } = await run(m, leadCreate, {
      workspaceId: m.workspaceId,
      title: 'AC tune-up',
      personId: m.person.id,
    });
    await drain(m);
    expect(await stageOf(leadId)).toMatchObject({ name: 'New', status: 'open' });

    const quote = await sentEstimate(m, { leadId });
    expect(await stageOf(leadId)).toMatchObject({ name: 'Estimate sent', status: 'open' });
    expect(await timeline(leadId)).toContain(
      `New → Estimate sent (Quote ${quote.number} went out)`,
    );

    await run(m, estimateMarkAccepted, {
      workspaceId: m.workspaceId,
      estimateId: quote.id,
      name: 'Maria Lopez',
    });
    await drain(m);
    expect(await stageOf(leadId)).toMatchObject({ name: 'Won', status: 'won' });
    expect((await timeline(leadId)).at(-1)).toBe(
      `Estimate sent → Won (Quote ${quote.number} accepted)`,
    );
  });

  it('leaves a deal someone moved back by hand, until something new happens', async () => {
    const { leadId, stageId: newStage } = await run(m, leadCreate, {
      workspaceId: m.workspaceId,
      title: 'Duct cleaning',
      personId: m.person.id,
    });
    await sentEstimate(m, { leadId });
    expect((await stageOf(leadId)).name).toBe('Estimate sent');
    // Someone puts it back: the quote that went out before doesn't move it again.
    await run(m, leadMoveStage, { workspaceId: m.workspaceId, leadId, stageId: newStage });
    await drain(m);
    expect((await stageOf(leadId)).name).toBe('New');
    // A new quote for it does.
    await sentEstimate(m, { leadId });
    expect((await stageOf(leadId)).name).toBe('Estimate sent');
  });

  it('with the moves off, a deal still behind a day later gets a card, and one press moves it', async () => {
    await setMoves(false);
    const { leadId } = await run(m, leadCreate, {
      workspaceId: m.workspaceId,
      title: 'New furnace',
      personId: m.person.id,
    });
    await sentEstimate(m, { leadId });
    expect((await stageOf(leadId)).name).toBe('New');
    await runSweep(m, Date.now() + DAY + 60_000);
    const card = await itemOf(m, leadId, 'pipeline_mismatch');
    expect(card.state).toBe('open');
    expect(card.detail).toBe('Belongs in Estimate sent');

    const out = await run(m, leadCatchUp, { workspaceId: m.workspaceId, leadId });
    expect(out.stageName).toBe('Estimate sent');
    await drain(m);
    expect((await stageOf(leadId)).name).toBe('Estimate sent');
    await expect(run(m, leadCatchUp, { workspaceId: m.workspaceId, leadId })).rejects.toThrow(
      /already where it belongs/,
    );
    await setMoves(true);
  });
});

describe('people you are talking with', () => {
  const openDeals = async (personId: string) =>
    rows<{ title: string; source: string | null; assignee_user_id: string | null }>(
      admin(),
      sql`select title, source, assignee_user_id from app.leads
          where person_id = ${personId} and status = 'open'`,
    );

  it('makes a deal for a customer who wrote twice and got a reply, and not before', async () => {
    const bo = await filedCustomer(w, 'Bo');
    const first = await textIn(w, bo.phone, 'Hi, could you look at my furnace sometime?');
    expect(await openDeals(bo.id)).toHaveLength(0);
    await runAs(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: first.conversationId,
      channel: 'sms',
      body: 'Sure, what day suits you?',
    });
    await drain(w);
    expect(await openDeals(bo.id)).toHaveLength(0);
    await textIn(w, bo.phone, 'Tuesday afternoon works');
    const deals = await openDeals(bo.id);
    expect(deals).toEqual([
      {
        title: 'Bo Test (conversation)',
        source: 'A conversation with you',
        assignee_user_id: w.owner.id,
      },
    ]);
  });

  it('leaves alone someone nobody has answered', async () => {
    const cy = await filedCustomer(w, 'Cy');
    await textIn(w, cy.phone, 'Are you open Saturday?');
    await textIn(w, cy.phone, 'Hello?');
    expect(await openDeals(cy.id)).toHaveLength(0);
  });
});

describe('went quiet after a price', () => {
  it('opens a card two days after a price with no answer, and their reply ends it', async () => {
    const di = await filedCustomer(w, 'Di');
    const leadId = await typedLead(w, di.id, 'Di: water heater');
    const asked = await textIn(w, di.phone, 'How much for a new water heater?');
    await runAs(w, messageSend, {
      workspaceId: w.workspaceId,
      conversationId: asked.conversationId,
      channel: 'sms',
      body: 'It would be $1,450 installed, old one hauled away.',
    });
    await drain(w);
    const later = Date.now() + 2 * DAY + 60 * 60_000;
    await runSweep(w, later);
    const card = await itemOf(w, leadId, 'quiet_after_price');
    expect(card.state).toBe('open');
    expect(card.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'price', label: '$1,450 by text' })]),
    );

    await textIn(w, di.phone, 'Let me talk to my wife');
    await runSweep(w, later);
    const after = await itemOf(w, leadId, 'quiet_after_price');
    expect(after.state).toBe('resolved');
    expect(after.resolution).toBe('replied');
  });
});
