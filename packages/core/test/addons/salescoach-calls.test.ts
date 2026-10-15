/**
 * AI Sales Coach on the database (docs/salescoach.md): its tables are mirrored exactly; the playbooks have one usual
 * one; a coached call runs from the worker's start through cards to the write-up, which puts the notes on the
 * customer's timeline and the rep's promises in their tasks; and only the rep and whoever reviews see a coached call,
 * only the rep sees its cards, and none of it works while the add-on is off.
 */
import { randomUUID } from 'node:crypto';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { checkedAfterCall } from '../../src/addons/salescoach/coach';
import { salescoachAddon } from '../../src/addons/salescoach/manifest';
import { salescoachAddonServer } from '../../src/addons/salescoach/server';
import { SALESCOACH_TABLES } from '../../src/addons/salescoach/tables';
import {
  addonRef,
  executeCommand,
  executeQuery,
  organizationCreate,
  personCreate,
  type CommandDef,
  type HumanActor,
  type QueryDef,
  type SystemActor,
} from '../../src/server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const ops = [...(salescoachAddonServer.commands ?? []), ...(salescoachAddonServer.queries ?? [])];
const op = (name: string) => ops.find((o) => o.name === name)!;

/** As a person, in the business. */
function as(u: TestUser, name: string, input: Record<string, unknown>): Promise<Any> {
  const found = op(name);
  return found.kind === 'command'
    ? executeCommand(
        api(),
        found as CommandDef,
        { workspaceId: ws, ...input },
        human(u),
        meta(),
      ).then((r) => r.output)
    : executeQuery(api(), found as QueryDef, { workspaceId: ws, ...input }, human(u), meta());
}
/** As the worker, acting for the add-on. */
function worker(name: string, input: Record<string, unknown>): Promise<Any> {
  const actor: SystemActor = {
    type: 'system',
    workspaceId: ws,
    organizationId: orgId,
    addon: addonRef(salescoachAddon),
  };
  return executeCommand(
    testDbs().worker.db,
    op(name) as CommandDef<z.ZodType, z.ZodType>,
    { workspaceId: ws, ...input },
    actor,
    meta(),
  ).then((r) => r.output);
}
const refused = (p: Promise<unknown>) =>
  p.then(
    () => 'went through',
    (e: { rule?: string; code?: string }) => e.rule ?? e.code,
  );
const seen = <T>(u: TestUser, q: ReturnType<typeof sql>) =>
  asUser(api(), u.claims, (tx) => rows<T & Record<string, unknown>>(tx, q));

let owner: TestUser;
let rep: TestUser;
let other: TestUser;
let ws: string;
let orgId: string;
let personId: string;

async function aCall(by: TestUser): Promise<string> {
  const [c] = await rows<{ id: string }>(
    admin(),
    sql`insert into app.calls (workspace_id, direction, status, person_id, placed_by, to_e164, provider_sid, answered_at)
        values (${ws}, 'outbound', 'in_progress', ${personId}, ${by.id}, '+17135550142', ${`CA${randomUUID().slice(0, 12)}`}, now())
        returning id`,
  );
  return c!.id;
}

const PLAYBOOK = {
  steps: [
    { id: 'x9', title: 'Say hello and who you are', say: 'Hi, this is Dana from Lone Star.' },
    { id: 'x8', title: 'Ask what’s going on with the AC', say: '' },
    { id: 'x7', title: 'Book the visit', say: 'Can we come out Thursday?' },
  ],
  objections: [
    {
      id: 'y1',
      objection: 'It’s too expensive',
      answer: 'I hear you. The visit fee goes toward any repair. Want me to hold Thursday?',
    },
  ],
  points: [{ id: 'z1', topic: 'Warranty', fact: 'Every repair has a one-year warranty.' }],
};

beforeAll(async () => {
  [owner, rep, other] = await Promise.all([
    createTestUser('coach-owner'),
    createTestUser('coach-rep'),
    createTestUser('coach-other'),
  ]);
  const made = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Coached Cooling Co' },
    human(owner),
    meta(),
  );
  ws = made.output.workspaceId;
  orgId = made.output.organizationId;
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${rep.id}, 'member'), (${ws}, ${other.id}, 'member')`,
  );
  await rows(
    admin(),
    sql`insert into app.addon_installations (workspace_id, addon_id, state, installed_version)
        values (${ws}, 'salescoach', 'enabled', ${salescoachAddon.version})`,
  );
  personId = (
    await executeCommand(
      api(),
      personCreate,
      { workspaceId: ws, firstName: 'Mike', lastName: 'Johnson', phone: '(713) 555-0142' },
      human(owner),
      meta(),
    )
  ).output.personId;
}, 60_000);
afterAll(closeTestDbs);

describe('AI Sales Coach’s tables', () => {
  it('are mirrored in Drizzle exactly, and named in the manifest', async () => {
    for (const table of Object.values(SALESCOACH_TABLES)) {
      const live = await rows<{ column_name: string }>(
        admin(),
        sql`select column_name from information_schema.columns
            where table_schema = 'addon_salescoach' and table_name = ${getTableName(table)}`,
      );
      expect(
        Object.values(getTableColumns(table))
          .map((c) => c.name)
          .sort(),
        getTableName(table),
      ).toEqual(live.map((c) => c.column_name).sort());
    }
    const tables = await rows<{ name: string }>(
      admin(),
      sql`select c.relname::text as name from pg_class c
          where c.relnamespace = 'addon_salescoach'::regnamespace and c.relkind = 'r' order by 1`,
    );
    expect(tables.map((t) => t.name)).toEqual([...(salescoachAddon.tables ?? [])].sort());
  });
});

describe('AI Sales Coach’s playbooks', () => {
  it('are written by owners and admins, read by the team, and the first is the usual one', async () => {
    expect(
      await refused(as(rep, 'salescoach.playbook.save', { name: 'Mine', details: PLAYBOOK })),
    ).toBe('forbidden');
    const first = await as(owner, 'salescoach.playbook.save', {
      name: 'First call',
      kind: 'first_call',
      details: PLAYBOOK,
    });
    expect(first).toMatchObject({ isDefault: true, kind: 'first_call' });
    // Its parts are numbered again, whatever ids came in.
    expect(first.details.steps.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(first.details.objections[0].id).toBe('o1');
    expect(
      await refused(
        as(owner, 'salescoach.playbook.save', { name: 'first CALL', details: PLAYBOOK }),
      ),
    ).toBe('salescoach_playbook_name_taken');
    const second = await as(owner, 'salescoach.playbook.save', {
      name: 'Estimate',
      kind: 'estimate',
      isDefault: true,
      details: PLAYBOOK,
    });
    expect(second.isDefault).toBe(true);
    const list = await as(rep, 'salescoach.playbook.list', {});
    expect(
      list.playbooks.map((p: { name: string; isDefault: boolean }) => [p.name, p.isDefault]),
    ).toEqual([
      ['Estimate', true],
      ['First call', false],
    ]);
    // Putting the usual one away makes the next in use the usual one; then the first call is it again.
    await as(owner, 'salescoach.playbook.archive', { playbookId: second.id, archived: true });
    const after = await as(rep, 'salescoach.playbook.list', {});
    expect(after.playbooks[0]).toMatchObject({ name: 'First call', isDefault: true });
    expect(after.playbooks[1]).toMatchObject({ name: 'Estimate', isDefault: false });
  });
});

describe('a coached call', () => {
  it('runs from the start to the write-up, and lands on the timeline and in the rep’s tasks', async () => {
    const callId = await aCall(rep);
    const begun = await worker('salescoach.call.begin', {
      callId,
      userId: rep.id,
      personId,
    });
    expect(begun.playbook).toMatchObject({ name: 'First call' });
    // Asked again (a retry), it's the same coached call.
    expect(
      (await worker('salescoach.call.begin', { callId, userId: rep.id, personId })).coachedCallId,
    ).toBe(begun.coachedCallId);

    const card = await worker('salescoach.card.add', {
      coachedCallId: begun.coachedCallId,
      step: 's2',
      card: {
        kind: 'objection',
        title: 'Price worry',
        say: 'I hear you. The visit fee goes toward the repair.',
        heard: 'That sounds expensive',
        objectionId: 'o1',
      },
    });
    expect(card.cardId).toBeTruthy();

    // The rep sees it live; nobody else does.
    const live = await as(rep, 'salescoach.live', {});
    expect(live.call).toMatchObject({
      id: begun.coachedCallId,
      state: 'live',
      step: 's2',
      person: { name: 'Mike Johnson' },
    });
    expect(live.call.cards.map((c: { title: string }) => c.title)).toEqual(['Price worry']);
    expect((await as(other, 'salescoach.live', {})).call).toBeNull();
    expect((await as(owner, 'salescoach.live', {})).call).toBeNull();

    await as(rep, 'salescoach.card.dismiss', { cardId: card.cardId });
    expect((await as(rep, 'salescoach.live', {})).call.cards).toEqual([]);

    const lines = [
      { speaker: 'team', text: 'Hi, this is Dana from Coached Cooling.', atMs: 1000 },
      {
        speaker: 'customer',
        text: 'My AC is blowing warm air. That sounds expensive.',
        atMs: 4000,
      },
      {
        speaker: 'team',
        text: 'The fee goes toward the repair. I’ll text you the price by Friday.',
        atMs: 9000,
      },
    ];
    expect(
      await worker('salescoach.call.end', { coachedCallId: begun.coachedCallId, lines }),
    ).toEqual({ state: 'writing' });
    // A card after it ended changes nothing.
    expect(
      await worker('salescoach.card.add', {
        coachedCallId: begun.coachedCallId,
        step: null,
        card: { kind: 'fact', title: 'Late', say: 'Too late.', heard: '', objectionId: null },
      }),
    ).toEqual({ cardId: null });

    const result = checkedAfterCall(
      {
        summary: 'Mike’s AC is blowing warm air. He worried about price.',
        notes: ['AC blowing warm air'],
        promises: [{ what: 'Text Mike the price', due: '2026-10-16' }],
        followUp: 'Hi Mike, it’s Dana. I’ll text the price by Friday.',
        objections: [
          {
            said: 'Sounds expensive',
            answered: true,
            answer: 'It goes toward the repair.',
            objectionId: 'zz',
          },
        ],
        stepsCovered: ['s1', 's2', 'nope'],
        tips: ['Book the visit before hanging up.'],
      },
      {
        steps: [
          { id: 's1', title: 'a', say: '' },
          { id: 's2', title: 'b', say: '' },
          { id: 's3', title: 'c', say: '' },
        ],
        objections: [],
        points: [],
      },
      lines as Any,
    );
    const done = await worker('salescoach.call.finish', {
      coachedCallId: begun.coachedCallId,
      result,
      failure: null,
    });
    expect(done.state).toBe('done');
    expect(done.taskIds).toHaveLength(1);
    const [task] = await rows<{ title: string; assignee_user_id: string; person_id: string }>(
      admin(),
      sql`select title, assignee_user_id, person_id from app.tasks where id = ${done.taskIds[0]}`,
    );
    expect(task).toEqual({
      title: 'Text Mike the price',
      assignee_user_id: rep.id,
      person_id: personId,
    });
    const [line] = await rows<{ meta: { words: string; addon: { id: string } }; body: string }>(
      admin(),
      sql`select meta, body from app.activities
          where person_id = ${personId} and subtype = 'addon_line' order by created_at desc limit 1`,
    );
    expect(line!.meta.addon.id).toBe('salescoach');
    expect(line!.meta.words).toMatch(/scored \d+ out of 100/);
    expect(line!.body).toContain('AC blowing warm air');

    // Finishing again (a retry) adds nothing.
    expect(
      await worker('salescoach.call.finish', {
        coachedCallId: begun.coachedCallId,
        result,
        failure: null,
      }),
    ).toEqual({ state: 'done', taskIds: [] });

    // The rep and the owner (who reviews) see the write-up; another member doesn't see the call at all.
    const mine = await as(rep, 'salescoach.call.get', { coachedCallId: begun.coachedCallId });
    expect(mine.call.result.score.steps).toEqual({ covered: 2, of: 3 });
    expect(mine.call.cards).toHaveLength(1);
    const reviewed = await as(owner, 'salescoach.call.get', { coachedCallId: begun.coachedCallId });
    expect(reviewed.call.result.summary).toContain('warm air');
    // A reviewer reads the write-up, not the cards only the rep saw.
    expect(reviewed.call.cards).toEqual([]);
    expect(
      await refused(as(other, 'salescoach.call.get', { coachedCallId: begun.coachedCallId })),
    ).toBe('not_found');
    expect((await as(other, 'salescoach.call.list', {})).calls).toEqual([]);
    expect((await as(owner, 'salescoach.call.list', {})).calls[0]).toMatchObject({
      rep: { id: rep.id },
      person: { name: 'Mike Johnson' },
      state: 'done',
    });
  });

  it('is written only by the worker, and its cards only put away by their rep', async () => {
    const callId = await aCall(rep);
    const begun = await worker('salescoach.call.begin', { callId, userId: rep.id, personId: null });
    expect(
      await refused(
        seen(
          rep,
          sql`update addon_salescoach.calls set state = 'done' where id = ${begun.coachedCallId} returning id`,
        ),
      ),
    ).not.toBe('went through');
    expect(
      await refused(
        seen(
          owner,
          sql`insert into addon_salescoach.cards (workspace_id, coached_call_id, user_id, kind, title, say)
              values (${ws}, ${begun.coachedCallId}, ${owner.id}, 'fact', 'Hi', 'Hi')`,
        ),
      ),
    ).not.toBe('went through');
    const card = await worker('salescoach.card.add', {
      coachedCallId: begun.coachedCallId,
      step: null,
      card: {
        kind: 'question',
        title: 'Ask',
        say: 'When did it start?',
        heard: '',
        objectionId: null,
      },
    });
    await as(other, 'salescoach.card.dismiss', { cardId: card.cardId });
    expect((await as(rep, 'salescoach.live', {})).call.cards).toHaveLength(1);
    // Nothing heard: it ends with no write-up to wait for.
    expect(
      await worker('salescoach.call.end', { coachedCallId: begun.coachedCallId, lines: [] }),
    ).toEqual({ state: 'failed' });
  });

  it('stops for one call when its rep asks, and then nothing more is kept', async () => {
    const callId = await aCall(rep);
    const begun = await worker('salescoach.call.begin', { callId, userId: rep.id, personId });
    // Only the rep on it.
    expect(
      await refused(as(owner, 'salescoach.call.stop', { coachedCallId: begun.coachedCallId })),
    ).toBe('salescoach_not_your_call');
    expect(await as(rep, 'salescoach.call.stop', { coachedCallId: begun.coachedCallId })).toEqual({
      state: 'stopped',
    });
    // No more cards, nothing kept at the end, no write-up.
    expect(
      await worker('salescoach.card.add', {
        coachedCallId: begun.coachedCallId,
        step: 's1',
        card: { kind: 'fact', title: 'Late', say: 'Too late.', heard: '', objectionId: null },
      }),
    ).toEqual({ cardId: null });
    expect(
      await worker('salescoach.call.end', {
        coachedCallId: begun.coachedCallId,
        lines: [{ speaker: 'customer', text: 'Still talking', atMs: 1 }],
      }),
    ).toEqual({ state: 'stopped' });
    const [row] = await rows<{ state: string; lines: unknown[] }>(
      admin(),
      sql`select state, lines from addon_salescoach.calls where id = ${begun.coachedCallId}`,
    );
    expect(row).toEqual({ state: 'stopped', lines: [] });
    // Row security lets the rep stop their live call and change nothing else.
    expect(
      await seen(
        rep,
        sql`update addon_salescoach.calls set state = 'live' where id = ${begun.coachedCallId} returning id`,
      ),
    ).toEqual([]);
  });

  it('stops while the add-on is off', async () => {
    await rows(
      admin(),
      sql`update app.addon_installations set state = 'disabled' where workspace_id = ${ws} and addon_id = 'salescoach'`,
    );
    try {
      expect(await refused(as(rep, 'salescoach.playbook.list', {}))).toBe('addon_inactive');
      const callId = await aCall(rep);
      expect(
        await refused(worker('salescoach.call.begin', { callId, userId: rep.id, personId: null })),
      ).toBe('addon_inactive');
    } finally {
      await rows(
        admin(),
        sql`update app.addon_installations set state = 'enabled' where workspace_id = ${ws} and addon_id = 'salescoach'`,
      );
    }
  });
});

describe('suggested replies', () => {
  async function aThread(): Promise<{
    conversationId: string;
    said: (dir: string, body: string) => Promise<string>;
  }> {
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
          values (${ws}, 'sms', ${`+1713555${String(Math.floor(Math.random() * 9000) + 1000)}`}, ${personId})
          returning id`,
    );
    const conversationId = c!.id;
    let at = Date.now() - 60_000;
    return {
      conversationId,
      said: async (direction: string, body: string) => {
        at += 1000;
        const [m] = await rows<{ id: string }>(
          admin(),
          sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
              values (${ws}, ${conversationId}, 'sms', ${direction}::app.direction,
                      ${direction === 'inbound' ? 'received' : 'sent'}::app.message_status, ${body}, ${new Date(at).toISOString()})
              returning id`,
        );
        return m!.id;
      },
    };
  }
  const replies = [
    { label: 'Answer the price', text: 'The visit fee goes toward the repair.' },
    { label: 'Ask when', text: 'When works for a visit?' },
  ];

  it('are kept for the customer’s newest message, shown with the conversation, and gone once someone replies', async () => {
    const t = await aThread();
    const first = await t.said('inbound', 'How much is a tune-up?');
    const newest = await t.said('inbound', 'That sounds expensive');
    // Only for the newest message.
    expect(
      await worker('salescoach.suggestions.put', {
        conversationId: t.conversationId,
        messageId: first,
        replies,
        objectionId: null,
      }),
    ).toEqual({ kept: false });
    expect(
      await worker('salescoach.suggestions.put', {
        conversationId: t.conversationId,
        messageId: newest,
        replies,
        objectionId: 'o1',
      }),
    ).toEqual({ kept: true });
    expect(await as(rep, 'salescoach.suggestions', { conversationId: t.conversationId })).toEqual({
      suggestions: { messageId: newest, replies, objectionId: 'o1' },
    });
    // Nobody but the worker writes them.
    expect(
      await seen(
        rep,
        sql`update addon_salescoach.suggestions set objection_id = null
            where conversation_id = ${t.conversationId} returning id`,
      ),
    ).toEqual([]);
    // Someone replied: they're stale.
    await t.said('outbound', 'It’s $89, and it goes toward any repair.');
    expect(await as(rep, 'salescoach.suggestions', { conversationId: t.conversationId })).toEqual({
      suggestions: null,
    });
  });
});

describe('a written conversation’s write-up', () => {
  it('lands on the timeline and in the rep’s tasks once, and lists beside the calls', async () => {
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.conversations (workspace_id, channel, counterpart, person_id)
          values (${ws}, 'sms', '+17135559911', ${personId}) returning id`,
    );
    const [m] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text)
          values (${ws}, ${c!.id}, 'sms', 'outbound', 'sent', 'I’ll send the quote tomorrow.') returning id`,
    );
    const lines = [
      { speaker: 'customer', text: 'How much for a new unit?', atMs: 0 },
      { speaker: 'team', text: 'I’ll send the quote tomorrow.', atMs: 5000 },
    ];
    const result = checkedAfterCall(
      {
        summary: 'Mike wants a price for a new unit.',
        notes: ['Wants a new unit'],
        promises: [{ what: 'Send Mike the quote', due: null }],
        followUp: 'Hi Mike, the quote is on its way.',
        objections: [],
        stepsCovered: [],
        tips: [],
      },
      { steps: [], objections: [], points: [] },
      lines as Any,
    );
    const input = {
      conversationId: c!.id,
      throughMessageId: m!.id,
      channel: 'sms',
      userId: rep.id,
      lines,
      result,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
    };
    const done = await worker('salescoach.conversation.finish', input);
    expect(done.taskIds).toHaveLength(1);
    // Once per stretch: a retry adds nothing.
    expect(await worker('salescoach.conversation.finish', input)).toEqual({
      coachedCallId: null,
      taskIds: [],
    });
    const [line] = await rows<{ words: string }>(
      admin(),
      sql`select meta ->> 'words' as words from app.activities
          where person_id = ${personId} and subtype = 'addon_line' order by created_at desc limit 1`,
    );
    expect(line!.words).toMatch(/conversation was coached and scored \d+ out of 100/);
    const listed = (await as(rep, 'salescoach.call.list', {})).calls.find(
      (x: { id: string }) => x.id === done.coachedCallId,
    );
    expect(listed).toMatchObject({
      callId: null,
      conversationId: c!.id,
      channel: 'sms',
      state: 'done',
    });
    const got = await as(rep, 'salescoach.call.get', { coachedCallId: done.coachedCallId });
    expect(got.call.conversationId).toBe(c!.id);
  });
});

describe('learning from wins', () => {
  async function doneCall(endedAgoMs: number): Promise<string> {
    const callId = await aCall(rep);
    const [c] = await rows<{ id: string }>(
      admin(),
      sql`insert into addon_salescoach.calls (workspace_id, call_id, user_id, person_id, state, started_at, ended_at)
          values (${ws}, ${callId}, ${rep.id}, ${personId}, 'done',
                  ${new Date(Date.now() - endedAgoMs - 60_000).toISOString()}, ${new Date(Date.now() - endedAgoMs).toISOString()})
          returning id`,
    );
    return c!.id;
  }

  it('marks the customer’s coached records of the week before a win', async () => {
    const recent = await doneCall(2 * 24 * 60 * 60_000);
    const old = await doneCall(10 * 24 * 60 * 60_000);
    expect(
      await worker('salescoach.win.note', {
        personIds: [personId],
        how: 'booked',
        at: new Date().toISOString(),
      }),
    ).toMatchObject({ marked: expect.any(Number) });
    const marked = await rows<{ id: string; won_how: string | null }>(
      admin(),
      sql`select id, won_how from addon_salescoach.calls where id in (${recent}, ${old})`,
    );
    expect(Object.fromEntries(marked.map((m) => [m.id, m.won_how]))).toEqual({
      [recent]: 'booked',
      [old]: null,
    });
  });

  it('keeps lessons for owners and admins, who use or dismiss them', async () => {
    const [book] = (await as(owner, 'salescoach.playbook.list', {})).playbooks.filter(
      (p: { archivedAt: string | null }) => !p.archivedAt,
    );
    const lesson = {
      kind: 'better_answer',
      objectionId: 'o1',
      objection: 'It’s too expensive',
      answer: 'I hear you. Most people say it paid for itself in a year.',
      wins: 6,
      of: 9,
      evidence: [],
    };
    const fresh = {
      kind: 'new_objection',
      objectionId: null,
      objection: 'How soon can you start?',
      answer: 'We can start Monday. Want me to hold it?',
      wins: 2,
      of: 2,
      evidence: [],
    };
    expect(
      await worker('salescoach.lessons.put', { playbookId: book.id, lessons: [lesson, fresh] }),
    ).toEqual({ kept: 2 });
    // Owners and admins only.
    expect(await refused(as(rep, 'salescoach.lesson.list', {}))).toBe('forbidden');
    const listed = (await as(owner, 'salescoach.lesson.list', {})).lessons;
    expect(listed.map((l: { kind: string }) => l.kind).sort()).toEqual([
      'better_answer',
      'new_objection',
    ]);
    const better = listed.find((l: { kind: string }) => l.kind === 'better_answer');
    expect(better).toMatchObject({ wins: 6, of: 9, current: book.details.objections[0].answer });

    // Using the better answer changes the playbook; the new one is dismissed and not suggested again soon.
    await as(owner, 'salescoach.lesson.decide', { lessonId: better.id, use: true });
    const added = listed.find((l: { kind: string }) => l.kind === 'new_objection');
    await as(owner, 'salescoach.lesson.decide', { lessonId: added.id, use: false });
    const after = (await as(owner, 'salescoach.playbook.list', {})).playbooks.find(
      (p: { id: string }) => p.id === book.id,
    );
    expect(after.details.objections[0].answer).toBe(lesson.answer);
    expect(after.details.objections).toHaveLength(book.details.objections.length);
    expect((await as(owner, 'salescoach.lesson.list', {})).lessons).toEqual([]);
    expect(
      await worker('salescoach.lessons.put', { playbookId: book.id, lessons: [fresh] }),
    ).toEqual({ kept: 0 });
    // Deciding it twice: it isn't waiting anymore.
    expect(
      await refused(as(owner, 'salescoach.lesson.decide', { lessonId: better.id, use: true })),
    ).toBe('not_found');
  });
});
