/**
 * The AI keeps customers' tags and details up to date (0107), on the real database with the scripted model:
 * - after a customer's text it looks at them a few minutes later, puts on the tags their words fit, and changes a
 *   detail they gave, keeping the old one as "Previous";
 * - every change is a command with the AI's reason on its audit row (channel contact_ai), and every look is logged;
 * - a tag a person put on stays on, and a detail that isn't in what was said isn't written;
 * - its switches in Settings → Automations stop it;
 * - a pass over the whole list goes through every customer, can be stopped, and ends with a line in the audit log.
 */
import {
  automationsSaveSettings,
  contactAiCancelSweep,
  contactAiReviews,
  contactAiStartSweep,
  contactAiStatus,
  personCreate,
  personGet,
  recordAddTag,
  tagCreate,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptedAi } from '../src/ai/scripted';
import {
  CONTACT_AI_REVIEW_JOB,
  CONTACT_AI_SWEEP_JOB,
  contactAiReviewKey,
  contactAiSweepKey,
} from '../src/contact-ai/index';
import { textIn } from './ai-team-world';
import { attentionWorld, filedCustomer, type AttentionWorld } from './attention-world';
import { admin, drain, jobRow, makeWorld, query, run } from './booking-world';
import type { TestServices } from './helpers';

let w: AttentionWorld;
const tag: Record<string, string> = {};

/** Gives a world the scripted model. */
function withModel<T extends { s: TestServices }>(world: T): T {
  return Object.assign(world, {
    s: { ...world.s, ai: { provider: scriptedAi() } } as TestServices,
  });
}

beforeAll(async () => {
  w = withModel(await attentionWorld('cai'));
  for (const name of ['Solar', 'VIP', 'Commercial'])
    tag[name] = (await run(w, tagCreate, { workspaceId: w.workspaceId, name })).tagId;
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

/** Runs a pending job now, and whatever it queued. */
async function runNow(
  world: { workspaceId: string } & Parameters<typeof drain>[0],
  kind: string,
  key: string,
) {
  await rows(
    admin(),
    sql`update app.scheduled_jobs set run_at = now() - interval '1 second'
        where kind = ${kind} and dedupe_key = ${key} and status = 'pending'`,
  );
  await drain(world);
}

/** Moves a customer's logged looks back in time (the log refuses changes, so its trigger is held off here). */
async function backdateReviews(personId: string, minutes: number) {
  await admin().transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(
      sql`update app.contact_ai_reviews set created_at = created_at - ${`${minutes} minutes`}::interval
          where person_id = ${personId}`,
    );
  });
}

const tagsOn = async (personId: string) =>
  (
    await rows<{ name: string; created_by: string | null }>(
      admin(),
      sql`select t.name::text as name, rt.created_by from app.record_tags rt join app.tags t on t.id = rt.tag_id
          where rt.record_type = 'person' and rt.record_id = ${personId} order by t.name`,
    )
  ).map((t) => t.name);

const auditOf = (personId: string) =>
  rows<{
    action: string;
    channel: string;
    reason: string | null;
    actor_type: string;
    after: unknown;
  }>(
    admin(),
    sql`select action, channel, reason, actor_type::text as actor_type, after from app.audit_logs
        where entity_id = ${personId} and channel = 'contact_ai' order by created_at`,
  );

describe('after something happens with a customer', () => {
  it('tags them from what they said, fixes the detail they gave, and logs every change with its reason', async () => {
    const c = await filedCustomer(w, 'Sol');
    await rows(admin(), sql`update app.people set email = 'sol@old.test' where id = ${c.id}`);
    await textIn(
      w,
      c.phone,
      'Hi, do you install Solar panels? Also my new email is sol@new.test thanks',
    );
    // It waits for things to settle.
    const job = await jobRow(contactAiReviewKey(c.id));
    expect(job?.status).toBe('pending');
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(Date.now() + 60_000);

    await runNow(w, CONTACT_AI_REVIEW_JOB, contactAiReviewKey(c.id));
    expect(await tagsOn(c.id)).toEqual(['Solar']);
    const { person } = await query(w, personGet, { workspaceId: w.workspaceId, personId: c.id });
    expect(person.email).toBe('sol@new.test');
    expect(person.otherEmails).toEqual([{ email: 'sol@old.test', label: 'Previous' }]);

    const audit = await auditOf(c.id);
    expect(audit.map((a) => a.action)).toEqual(['record.set_tags', 'person.update']);
    for (const a of audit) expect(a.actor_type).toBe('system');
    expect(audit[0]!.reason).toBe('Mentioned “Solar”');
    expect(audit[1]!.reason).toBe('email: Gave a new email');
    const [event] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where entity_id = ${c.id} and event_type = 'record.tags_changed'`,
    );
    expect(event!.payload['_contactAi']).toEqual({ trigger: 'activity', sweepId: null });

    const { items } = await query(w, contactAiReviews, {
      workspaceId: w.workspaceId,
      personId: c.id,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      trigger: 'activity',
      outcome: 'changed',
      addedTags: [{ name: 'Solar', reason: 'Mentioned “Solar”' }],
      details: [{ field: 'email', from: 'sol@old.test', to: 'sol@new.test' }],
    });
    // Its own changes bring on no second look.
    expect((await jobRow(contactAiReviewKey(c.id)))?.status).toBe('done');
  });

  it('leaves a tag a person put on, and never writes a detail nobody gave', async () => {
    const c = await filedCustomer(w, 'Vic');
    await run(w, recordAddTag, {
      workspaceId: w.workspaceId,
      recordType: 'person',
      recordId: c.id,
      tagId: tag['Commercial'],
    });
    await textIn(w, c.phone, 'We are no longer a Commercial account. Is the VIP deal still on?');
    await runNow(w, CONTACT_AI_REVIEW_JOB, contactAiReviewKey(c.id));
    expect(await tagsOn(c.id)).toEqual(['Commercial', 'VIP']);
    const { items } = await query(w, contactAiReviews, {
      workspaceId: w.workspaceId,
      personId: c.id,
    });
    expect(items[0]!.skipped).toEqual([
      { what: 'taking off “Commercial”', why: 'someone on the team put it on' },
    ]);
  });

  it('takes off a tag it put on itself once it no longer fits', async () => {
    const c = await filedCustomer(w, 'Una');
    await textIn(w, c.phone, 'Can you quote Solar for our roof?');
    await runNow(w, CONTACT_AI_REVIEW_JOB, contactAiReviewKey(c.id));
    expect(await tagsOn(c.id)).toEqual(['Solar']);
    // Half an hour on (the most it looks on its own).
    await backdateReviews(c.id, 31);
    await textIn(w, c.phone, 'Sorry, we are no longer thinking about Solar.');
    await runNow(w, CONTACT_AI_REVIEW_JOB, contactAiReviewKey(c.id));
    expect(await tagsOn(c.id)).toEqual([]);
    const audit = await auditOf(c.id);
    expect(audit.at(-1)).toMatchObject({
      action: 'record.set_tags',
      reason: 'Said they’re no longer into “Solar”',
    });
  });

  it('waits out its half hour before looking at the same customer again', async () => {
    const c = await filedCustomer(w, 'Wes');
    await textIn(w, c.phone, 'Is VIP pricing a thing?');
    await runNow(w, CONTACT_AI_REVIEW_JOB, contactAiReviewKey(c.id));
    await textIn(w, c.phone, 'Also interested in Solar');
    await runNow(w, CONTACT_AI_REVIEW_JOB, contactAiReviewKey(c.id));
    expect(await tagsOn(c.id)).toEqual(['VIP']);
    const job = await jobRow(contactAiReviewKey(c.id));
    expect(job?.status).toBe('pending');
    expect(new Date(job!.run_at).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it('leaves alone customers an import or HandsFreeOS filed, until something happens with them', async () => {
    const c = await filedCustomer(w, 'Imp');
    await drain(w);
    expect(await jobRow(contactAiReviewKey(c.id))).toBeUndefined();
    const typed = await run(w, personCreate, {
      workspaceId: w.workspaceId,
      firstName: 'Typed',
      notes: 'Wants Solar',
    });
    await drain(w);
    expect((await jobRow(contactAiReviewKey(typed.personId)))?.status).toBe('pending');
  });

  it('does nothing while both switches are off', async () => {
    await run(w, automationsSaveSettings, {
      workspaceId: w.workspaceId,
      settings: { switches: { aiTags: false, aiDetails: false } },
    });
    try {
      const c = await filedCustomer(w, 'Off');
      await textIn(w, c.phone, 'Solar please, my new email is off@new.test');
      expect(await jobRow(contactAiReviewKey(c.id))).toBeUndefined();
    } finally {
      await run(w, automationsSaveSettings, {
        workspaceId: w.workspaceId,
        settings: { switches: { aiTags: true, aiDetails: true } },
      });
    }
  });
});

describe('a pass over the whole list', () => {
  it('looks at every customer, logs each change, and ends with a line in the audit log', async () => {
    const x = withModel(await makeWorld('caisweep'));
    const solar = (await run(x, tagCreate, { workspaceId: x.workspaceId, name: 'Solar' })).tagId;
    const people: string[] = [];
    for (const [first, notes] of [
      ['Ann', 'Wants Solar on the barn'],
      ['Ben', 'Furnace only'],
      ['Cam', 'Asked about Solar twice'],
    ] as const)
      people.push(
        (
          await run(x, personCreate, {
            workspaceId: x.workspaceId,
            firstName: first,
            lastName: 'Sweep',
            notes,
          })
        ).personId,
      );
    const { sweepId, total } = await run(x, contactAiStartSweep, {
      workspaceId: x.workspaceId,
      instructions: 'Anyone who wants solar gets Solar.',
      tagIds: [solar],
    });
    expect(total).toBe(3);
    // One at a time.
    await expect(run(x, contactAiStartSweep, { workspaceId: x.workspaceId })).rejects.toMatchObject(
      { rule: 'contact_ai_running' },
    );

    await drain(x);
    await runNow(x, CONTACT_AI_SWEEP_JOB, contactAiSweepKey(sweepId));
    const status = await query(x, contactAiStatus, { workspaceId: x.workspaceId });
    expect(status.running).toBeNull();
    expect(status.recent[0]).toMatchObject({
      id: sweepId,
      status: 'done',
      total: 3,
      reviewed: 3,
      changed: 2,
      tagsAdded: 2,
      tags: [{ id: solar, name: 'Solar' }],
    });
    expect(await tagsOn(people[0]!)).toEqual(['Solar']);
    expect(await tagsOn(people[1]!)).toEqual([]);
    expect(await tagsOn(people[2]!)).toEqual(['Solar']);
    const [finished] = await rows<{ action: string; after: Record<string, unknown> }>(
      admin(),
      sql`select action, after from app.audit_logs where entity_id = ${sweepId} order by created_at desc limit 1`,
    );
    expect(finished).toMatchObject({
      action: 'contact_ai.sweep_finished',
      after: { status: 'done', reviewed: 3, changed: 2, tagsAdded: 2 },
    });
    const { items } = await query(x, contactAiReviews, {
      workspaceId: x.workspaceId,
      sweepId,
      changedOnly: true,
    });
    expect(items.map((i) => i.person.fullName).sort()).toEqual(['Ann Sweep', 'Cam Sweep']);
    await x.app.close();
  });

  it('stops when a person stops it, keeping what it already did', async () => {
    const x = withModel(await makeWorld('caistop'));
    await run(x, tagCreate, { workspaceId: x.workspaceId, name: 'Solar' });
    await run(x, personCreate, { workspaceId: x.workspaceId, firstName: 'Dee', notes: 'Solar' });
    const { sweepId } = await run(x, contactAiStartSweep, { workspaceId: x.workspaceId });
    await run(x, contactAiCancelSweep, { workspaceId: x.workspaceId, sweepId });
    await drain(x);
    await runNow(x, CONTACT_AI_SWEEP_JOB, contactAiSweepKey(sweepId));
    const status = await query(x, contactAiStatus, { workspaceId: x.workspaceId });
    expect(status.recent[0]).toMatchObject({ status: 'cancelled', reviewed: 0 });
    await expect(
      run(x, contactAiCancelSweep, { workspaceId: x.workspaceId, sweepId }),
    ).rejects.toMatchObject({ rule: 'contact_ai_stopped' });
    await x.app.close();
  });
});
