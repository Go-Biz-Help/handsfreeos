/**
 * Social Outreach in the worker: the AI (the stand-in model here) writes each network's own words for a customers'
 * playbook (decision 92): the hashtags Instagram looks at, the phrases LinkedIn's post search goes with and the kinds
 * of business Alignable's search looks for, with whether the business works with them online. Only a list that's
 * empty and that it hasn't written before, never a partner playbook's, never again on its own writing, and at the
 * day's AI limit the rest wait.
 */
import { randomUUID } from 'node:crypto';
import type { AiProvider } from '@hfos/ai';
import { blankPlaybook } from '@hfos/core/addons/outreach/playbooks';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  outreachBusiness,
  refused,
  runAs,
  runAsSystem,
} from '../../../packages/core/test/addons/outreach-fixture';
import { addonJobs, withAddons } from '../src/addons/index';
import { WRITE_WORDS_JOB } from '../src/addons/outreach/words';
import { scriptedAi } from '../src/ai/scripted';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { costlyAi, setAiLimit, testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;
const handlers = withAddons({});
const jobs = { ...addonJobs };

let owner: TestUser;

async function drain(s: TestServices, ws: string) {
  for (let i = 0; i < 30; i++) {
    const runner = `vitest-words-${randomUUID().slice(0, 8)}`;
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

/** The stand-in model, counting the words it was asked for. */
function counting(inner: AiProvider = scriptedAi()) {
  let asks = 0;
  const provider: AiProvider = {
    ...inner,
    stream: async (request, options) => {
      if (JSON.stringify(request).includes('Write the words to look with.')) asks += 1;
      return inner.stream(request, options);
    },
  };
  return { provider, asks: () => asks };
}

/** A customers' playbook on every network, for roofers in Austin, with what's given over it. */
const roofers = (over: Record<string, unknown> = {}) => ({
  ...blankPlaybook(),
  offer: 'A free week of answered calls',
  niche: 'Roofers in Austin',
  audience: 'Roofing companies with 2 to 3 crews',
  problem: 'Missed calls while they’re up on a roof',
  area: 'Austin, TX',
  ...over,
});

const detailsOf = async (id: string) =>
  (
    await rows<{ details: Record<string, unknown> }>(
      admin(),
      sql`select details from addon_outreach.playbooks where id = ${id}`,
    )
  )[0]!.details;

const eventsOf = async (ws: string, type: string) =>
  Number(
    (
      await rows<{ n: number | string }>(
        admin(),
        sql`select count(*) as n from app.events where workspace_id = ${ws} and event_type = ${type}`,
      )
    )[0]!.n,
  );

beforeAll(async () => {
  owner = await createTestUser('outreach-words-owner', { fullName: 'Rowan Prentice' });
}, 60_000);

afterAll(closeTestDbs);

describe('the AI’s words for finding people by topic', () => {
  it('fills only the empty lists it hasn’t written, and never one the person emptied', async () => {
    const ai = counting();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(owner, 'Outreach Words Co');
    // The person's own hashtags stay as they are: the AI writes LinkedIn's and Alignable's.
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Austin roofers',
      details: roofers({ hashtags: ['roofleak'] }),
    });
    await drain(s, ws);
    const written = await detailsOf(saved.id);
    expect(written).toMatchObject({
      hashtags: ['roofleak'],
      // A phrase too long for a search, and one twice, are dropped.
      postSearches: ['missed calls', 'roofers tips', 'hiring help'],
      businessKinds: ['Roofers', 'Property Management'],
      // Nobody had said: the AI's guess, from an area and a niche with no word of online.
      worksOnline: false,
      wordsWritten: ['linkedin', 'alignable'],
    });
    expect(ai.asks()).toBe(1);

    // The person empties LinkedIn's list and empties their own hashtags: the AI writes Instagram's, never LinkedIn's
    // again, and leaves works online as it is.
    await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: saved.id,
      name: 'Austin roofers',
      details: { ...written, hashtags: [], postSearches: [], worksOnline: true },
    });
    await drain(s, ws);
    expect(await detailsOf(saved.id)).toMatchObject({
      // The business's own name and a hashtag everyone uses are dropped, and one twice.
      hashtags: ['roofersinaustin', 'rooferslife', 'roofersbusiness', 'austinroofers'],
      postSearches: [],
      businessKinds: ['Roofers', 'Property Management'],
      worksOnline: true,
      wordsWritten: ['instagram', 'linkedin', 'alignable'],
    });
    expect(ai.asks()).toBe(2);

    // Nothing left to write: another save asks nothing.
    await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: saved.id,
      name: 'Austin roofers',
      details: { ...(await detailsOf(saved.id)), offer: 'Two free weeks of answered calls' },
    });
    await drain(s, ws);
    expect(ai.asks()).toBe(2);
  });

  it('waits for who a playbook is for, then writes once: its words never ask for more', async () => {
    const ai = counting();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(owner, 'Outreach Words Once Co');
    // Nothing to write from yet.
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Online coaches',
      details: { ...blankPlaybook(), offer: 'A free week of answered calls' },
    });
    await drain(s, ws);
    expect(ai.asks()).toBe(0);
    await runAs(owner, ws, 'outreach.playbook.save', {
      playbookId: saved.id,
      name: 'Online coaches',
      details: roofers({ niche: 'Coaches who work online', area: null }),
    });
    await drain(s, ws);
    await drain(s, ws);
    expect(ai.asks()).toBe(1);
    expect(await eventsOf(ws, 'outreach.playbook.saved')).toBe(2);
    expect(await eventsOf(ws, 'outreach.playbook.words_written')).toBe(1);
    const [left] = await rows<{ n: number | string }>(
      admin(),
      sql`select count(*) as n from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${WRITE_WORDS_JOB} and status = 'pending'`,
    );
    expect(Number(left!.n)).toBe(0);
    const [p] = await rows<{ details: Record<string, unknown> }>(
      admin(),
      sql`select details from addon_outreach.playbooks where workspace_id = ${ws}`,
    );
    // With no area, nothing local; online, so Alignable searches anywhere.
    expect(p!.details).toMatchObject({
      hashtags: ['coacheswhoworkonline', 'coacheslife', 'coachesbusiness'],
      worksOnline: true,
    });
  });

  it('writes nothing for a partner playbook, and the command refuses one', async () => {
    const ai = counting();
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(owner, 'Outreach Words Partners Co');
    const saved = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Partners',
      details: roofers({ goal: 'partner', groupWords: ['Austin homeowners'] }),
    });
    await drain(s, ws);
    expect(ai.asks()).toBe(0);
    expect(await detailsOf(saved.id)).toMatchObject({
      hashtags: [],
      postSearches: [],
      businessKinds: [],
      worksOnline: null,
      wordsWritten: [],
    });
    expect(
      await refused(
        runAsSystem(ws, 'outreach.playbook.words', {
          playbookId: saved.id,
          hashtags: ['austinroofing'],
        }),
      ),
    ).toBe('outreach_playbook_partner_words');
  });

  it('leaves the rest waiting at the day’s AI limit', async () => {
    const ai = counting(costlyAi());
    const s = testServices({ ai: { provider: ai.provider } });
    const ws = await outreachBusiness(owner, 'Outreach Capped Words Co');
    await setAiLimit(ws, 1);
    const first = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Austin roofers',
      details: roofers(),
    });
    const second = await runAs(owner, ws, 'outreach.playbook.save', {
      name: 'Round Rock roofers',
      details: roofers({ niche: 'Roofers in Round Rock', area: 'Round Rock, TX' }),
    });
    await drain(s, ws);
    expect(ai.asks()).toBe(1);
    expect(await detailsOf(first.id)).toMatchObject({
      wordsWritten: ['instagram', 'linkedin', 'alignable'],
    });
    expect(await detailsOf(second.id)).toMatchObject({ hashtags: [], wordsWritten: [] });
    // The rest come back hours later.
    const [job] = await rows<{ later: boolean }>(
      admin(),
      sql`select run_at > now() + interval '1 hour' as later from app.scheduled_jobs
          where workspace_id = ${ws} and kind = ${WRITE_WORDS_JOB} and status = 'pending'`,
    );
    expect(job?.later).toBe(true);
  });
});
