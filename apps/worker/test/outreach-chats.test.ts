/**
 * Social Outreach in the worker: the chats brought in from Facebook's download are read by the AI (the stand-in model
 * here) once the file's last part is in, a batch at a time, the latest first. The tagged go in Contacts with their
 * tags; the rest keep their summary. At the day's AI limit the rest wait, unread.
 */
import { randomUUID } from 'node:crypto';
import { PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outreachBusiness, runAs } from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { READ_CHATS_BATCH, READ_CHATS_JOB } from '../src/addons/outreach/chats';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { costlyAi, setAiLimit, testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

let owner: TestUser;

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-chats-${randomUUID().slice(0, 8)}`;
    await rows(
      admin(),
      sql`update app.outbox set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws}`,
    );
    const outbox = await processOnce({
      ...s,
      handlers,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    await rows(
      admin(),
      sql`update app.scheduled_jobs set locked_at = now(), locked_by = ${runner}
          where status = 'pending' and workspace_id = ${ws} and run_at <= now()`,
    );
    const done = await processJobs({
      ...s,
      jobs,
      workerId: runner,
      batchSize: 100,
      reservedOnly: true,
    });
    if (outbox.claimed === 0 && done.claimed === 0) return;
  }
  throw new Error('the worker never settled');
}

/** A business with the CRM playbook, and a file with these chats brought in. */
async function broughtIn(name: string, chats: readonly Record<string, unknown>[]) {
  const ws = await outreachBusiness(owner, name);
  const crm = PLAYBOOK_TEMPLATES.crm_demos;
  await runAs(owner, ws, 'outreach.playbook.save', {
    name: crm.name,
    template: 'crm_demos',
    details: crm.details,
  });
  await runAs(owner, ws, 'outreach.download.save', { madeAt: daysAgo(1), last: true, chats });
  return ws;
}

const chat = (name: string, said: string, at: string) => ({
  name,
  firstAt: at,
  lastAt: at,
  messages: 1,
  lastFromMe: false,
  recent: [{ fromMe: false, text: said, at }],
});

const states = (ws: string) =>
  rows<{
    name: string;
    read_state: string;
    tags: string[];
    prospect: boolean | null;
    person: string | null;
  }>(
    admin(),
    sql`select c.name, c.read_state, c.tags, c.prospect,
          (select p.first_name || ' ' || p.last_name from app.people p where p.id = c.person_id) as person
        from addon_outreach.file_chats c where c.workspace_id = ${ws} order by c.name`,
  );

beforeAll(async () => {
  owner = await createTestUser('outreach-chats-owner', { fullName: 'Pat Owner' });
}, 60_000);

afterAll(closeTestDbs);

describe('reading the chats a download brought in', () => {
  it('reads each one, and puts the tagged and likely prospects in Contacts with their tags', async () => {
    const s = testServices({ ai: { provider: scriptedAi() } });
    const ws = await broughtIn('Outreach Chats Worker Co', [
      chat('Avery Lane', 'I’m a business owner and want a demo', daysAgo(3)),
      chat('Quinn Harper', 'Happy birthday!', daysAgo(2)),
      chat('Sam Lee', 'How much is it?', daysAgo(4)),
    ]);
    await drain(s, ws);
    expect(await states(ws)).toEqual([
      {
        name: 'Avery Lane',
        read_state: 'read',
        tags: ['Business owner'],
        prospect: true,
        person: 'Avery Lane',
      },
      { name: 'Quinn Harper', read_state: 'read', tags: [], prospect: false, person: null },
      { name: 'Sam Lee', read_state: 'read', tags: [], prospect: true, person: 'Sam Lee' },
    ]);
    const tagged = await rows<{ name: string }>(
      admin(),
      sql`select t.name::text as name from app.record_tags rt join app.tags t on t.id = rt.tag_id
          join addon_outreach.file_chats c on c.person_id = rt.record_id
          where c.workspace_id = ${ws} and c.name = 'Avery Lane'`,
    );
    expect(tagged.map((t) => t.name)).toEqual(['Business owner']);
  });

  it('reads a long list a batch at a time, and leaves the rest waiting at the day’s AI limit', async () => {
    const many = Array.from({ length: READ_CHATS_BATCH + 5 }, (_, i) =>
      chat(`Made Up Person ${i}`, 'Hello there', daysAgo(10 + i)),
    );
    const all = testServices({ ai: { provider: scriptedAi() } });
    const ws = await broughtIn('Outreach Many Chats Co', many);
    await drain(all, ws);
    expect((await states(ws)).every((c) => c.read_state === 'read')).toBe(true);

    const none = testServices({ ai: { provider: costlyAi() } });
    const capped = await broughtIn('Outreach Capped Chats Co', many.slice(0, 3));
    await setAiLimit(capped, 1);
    await drain(none, capped);
    // The first, the latest, used up the day; the others wait.
    expect((await states(capped)).map((c) => c.read_state)).toEqual(['read', 'waiting', 'waiting']);
    const [job] = await rows<{ later: boolean }>(
      admin(),
      sql`select run_at > now() + interval '1 hour' as later from app.scheduled_jobs
          where workspace_id = ${capped} and kind = ${READ_CHATS_JOB} and status = 'pending'`,
    );
    expect(job?.later).toBe(true);
  });
});
