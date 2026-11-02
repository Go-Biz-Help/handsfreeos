import { randomInt, randomUUID } from 'node:crypto';
import {
  AssistantCard,
  assistantToolByName,
  executeCommand,
  executeQuery,
  metaAccountConnect,
  metaConnectionActivate,
  metaConnectionConnect,
  organizationCreate,
  registry,
  type HumanActor,
} from '@hfos/core/server';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/assistant/runtime';
import { allScreenActionTools } from '../src/assistant/tools-screen-actions';
import { createToolExecutor } from '../src/assistant/tools-write';
import { systemActor, workerMeta } from '../src/services';

/**
 * Settings → Facebook & Instagram and Settings → Lead intake, by asking: disconnecting a Page or a whole Facebook
 * sign-in (saying only the person can connect it again), each way a lead comes in by itself, Messenger, Instagram,
 * lead ads and Indeed included, and adding a website form or giving one a new key. Each is a card that changes
 * nothing until Confirm, and an app's secret key never goes through a chat.
 */

const CHI = 'America/Chicago';
const api = () => testDbs().api.db;
const worker = () => testDbs().worker.db;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: { sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated' },
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
const mark = randomUUID().slice(0, 8);
const digits = (n: number) =>
  String(randomInt(1, 10)) + Array.from({ length: n - 1 }, () => randomInt(0, 10)).join('');

type ConfirmCard = Extract<AssistantCard, { type: 'confirm' }>;
interface IntakeRow {
  kind: string;
  sourceId: string | null;
  name: string;
  active: boolean;
  createLead: boolean;
  pipelineId: string | null;
  stageId: string | null;
  dailyCap: number;
  publicKey: string | null;
  allowedOrigins: string[];
}
interface Intake {
  sources: IntakeRow[];
  pipelines: { id: string; name: string; stages: { id: string; name: string; kind: string }[] }[];
}
interface MetaList {
  accounts: { id: string; name: string; status: string }[];
  connections: { id: string; status: string }[];
}

const ctx = (): ToolContext => ({
  actor: actor(owner),
  workspaceId,
  organizationId,
  correlationId: randomUUID(),
  timezone: CHI,
});
const exec = () => createToolExecutor(api());
const tool = (name: string) =>
  assistantToolByName.get(name) ?? allScreenActionTools().find((t) => t.name === name)!;
const argsOf = (name: string, args: Record<string, unknown>) =>
  tool(name).input.parse(args) as Record<string, unknown>;
const prepare = async (name: string, args: Record<string, unknown>) => {
  const out = await exec().prepare(tool(name), argsOf(name, args), ctx(), randomUUID());
  expect(AssistantCard.safeParse(out.card).success).toBe(true);
  return out as { card: ConfirmCard };
};
const commit = (name: string, args: Record<string, unknown>) =>
  exec().commit(tool(name), argsOf(name, args), ctx(), { toolCallId: randomUUID() });
const field = (card: ConfirmCard, label: string) =>
  card.fields.find((f) => f.label === label)?.value;
const warned = (card: ConfirmCard) => card.warnings.map((w) => w.text).join(' ');

const ask = async <T>(name: string) =>
  (await executeQuery(api(), registry.query(name)!, { workspaceId }, actor(owner), meta())) as T;
const intake = () => ask<Intake>('intake.list');
const channel = async (kind: string) => (await intake()).sources.find((s) => s.kind === kind)!;
const facebook = () => ask<MetaList>('meta_account.list');

/** Somebody signed in to Facebook for the business, the way the worker finishes it, and picked these Pages. */
async function connectFacebook(pages: string[]): Promise<{ connectionId: string }> {
  const { output } = await executeCommand(
    api(),
    metaConnectionConnect,
    { workspaceId },
    actor(owner),
    meta(),
  );
  const sys = systemActor({ workspaceId, organizationId });
  await executeCommand(
    worker(),
    metaConnectionActivate,
    {
      workspaceId,
      connectionId: output.connectionId,
      facebookUserId: digits(15),
      facebookUserName: 'Dale Owner',
      tokenEnc: 'sealed-test-token',
      tokenKeyId: 'test',
      tokenExpiresAt: null,
    },
    sys,
    workerMeta(),
  );
  for (const name of pages) {
    const id = digits(15);
    await executeCommand(
      worker(),
      metaAccountConnect,
      {
        workspaceId,
        connectionId: output.connectionId,
        platform: 'facebook',
        externalId: id,
        pageId: id,
        name,
        tokenEnc: 'sealed-test-token',
        tokenKeyId: 'test',
        subscribed: true,
      },
      sys,
      workerMeta(),
    );
  }
  return { connectionId: output.connectionId };
}

beforeAll(async () => {
  owner = await createTestUser('aintake-dale', { fullName: 'Dale Owner' });
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: `Intake HVAC ${mark}`, timezone: CHI },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
}, 60_000);

afterAll(closeTestDbs);

describe('Settings → Lead intake: the ways in', () => {
  it('says a Facebook Page has to be connected first, and changes nothing until Confirm', async () => {
    expect((await channel('messenger')).active).toBe(true);
    const args = { channel: 'messenger', active: false };
    const { card } = await prepare('manage_lead_intake', args);
    expect(card.title).toBe('Stop opening leads when someone messages your Facebook Page');
    expect(warned(card)).toContain('still reach your inbox');
    expect((await channel('messenger')).active).toBe(true);

    await commit('manage_lead_intake', args);
    expect((await channel('messenger')).active).toBe(false);

    const back = await prepare('manage_lead_intake', { channel: 'messenger', active: true });
    expect(warned(back.card)).toContain('No Facebook Page is connected yet');
  });

  it('turns Indeed applicants on, into the pipeline and stage asked for', async () => {
    expect((await channel('indeed')).active).toBe(false);
    const board = (await intake()).pipelines[0]!;
    const stage = board.stages[1] ?? board.stages[0]!;
    const args = {
      channel: 'indeed',
      active: true,
      pipelineId: board.id,
      stageId: stage.id,
      name: 'Job applicants',
      dailyCap: 20,
    };
    const { card } = await prepare('manage_lead_intake', args);
    expect(card.title).toBe('Open a lead when Indeed emails you about an applicant');
    expect(field(card, 'Lands in')).toBe(board.name);
    expect(field(card, 'Stage')).toBe(stage.name);
    expect(field(card, 'Filed under')).toBe('Job applicants');
    expect(warned(card)).toContain('connected inbox');

    await commit('manage_lead_intake', args);
    expect(await channel('indeed')).toMatchObject({
      active: true,
      pipelineId: board.id,
      stageId: stage.id,
      name: 'Job applicants',
      dailyCap: 20,
    });
  });

  it('says what a lead ad form turned off means, and turns it off only on Confirm', async () => {
    const { card } = await prepare('manage_lead_intake', {
      channel: 'facebook_lead_ad',
      active: false,
    });
    expect(card.warnings[0]).toMatchObject({ kind: 'caution' });
    expect(warned(card)).toContain('aren’t added to your customers or leads');
    expect((await channel('facebook_lead_ad')).active).toBe(true);
  });

  it('refuses a pipeline that isn’t the business’s, and a change to nothing', async () => {
    await expect(
      prepare('manage_lead_intake', { channel: 'text', pipelineId: randomUUID() }),
    ).rejects.toThrow('No pipeline has that id.');
    await expect(prepare('manage_lead_intake', { channel: 'text' })).rejects.toMatchObject({
      rule: 'nothing_to_change',
    });
    await expect(
      prepare('manage_lead_intake', { channel: 'text', active: true }),
    ).rejects.toMatchObject({ rule: 'nothing_to_change' });
  });
});

describe('Settings → Lead intake: website forms', () => {
  const site = `form-${mark}.com`;
  const form = async () => (await intake()).sources.find((s) => s.name === 'Quote form');

  it('adds a form on the site and its www twin, only on Confirm', async () => {
    const args = { action: 'create', name: 'Quote form', websites: [site] };
    const { card } = await prepare('manage_lead_form', args);
    expect(card.title).toBe('Add a website form: Quote form');
    expect(field(card, 'Sites')).toBe(`${site}, www.${site}`);
    expect(warned(card)).toContain('Copy');
    expect(await form()).toBeUndefined();

    await commit('manage_lead_form', args);
    const made = (await form())!;
    expect(made.kind).toBe('website_form');
    expect(made.allowedOrigins).toEqual([`https://${site}`, `https://www.${site}`]);
    expect(made.publicKey).toBeTruthy();
  });

  it('asks which site, and turns away one the screen wouldn’t take', async () => {
    await expect(
      prepare('manage_lead_form', { action: 'create', name: 'Other form' }),
    ).rejects.toThrow('Say which website the form goes on');
    await expect(
      prepare('manage_lead_form', {
        action: 'create',
        name: 'Other form',
        websites: ['*.acme.com'],
      }),
    ).rejects.toThrow('Wildcards like *.acme.com don’t work here.');
  });

  it('gives a form a new key only on Confirm, warning the site’s copy stops working', async () => {
    const before = (await form())!;
    const args = { action: 'new_key', sourceId: before.sourceId };
    const { card } = await prepare('manage_lead_form', args);
    expect(card.title).toBe('Give Quote form a new key?');
    expect(card.warnings[0]).toMatchObject({ kind: 'caution' });
    expect((await form())!.publicKey).toBe(before.publicKey);

    await commit('manage_lead_form', args);
    expect((await form())!.publicKey).not.toBe(before.publicKey);
  });
});

describe('Settings → Facebook & Instagram', () => {
  it('disconnects one Page only on Confirm, saying only the person can bring it back', async () => {
    await connectFacebook([`Lone Star HVAC ${mark}`, `Lone Star Plumbing ${mark}`]);
    const page = (await facebook()).accounts.find((a) => a.name === `Lone Star HVAC ${mark}`)!;
    expect(page.status).toBe('active');

    const args = { accountId: page.id };
    const { card } = await prepare('do_meta_account_disconnect', args);
    expect(card.warnings[0]).toMatchObject({ kind: 'caution' });
    expect(warned(card)).toContain('Only you can bring it back');
    expect((await facebook()).accounts.find((a) => a.id === page.id)!.status).toBe('active');

    await commit('do_meta_account_disconnect', args);
    expect((await facebook()).accounts.find((a) => a.id === page.id)!.status).toBe('disconnected');
    await expect(prepare('do_meta_account_disconnect', args)).rejects.toThrow(
      'isn’t connected anymore',
    );
  });

  it('no longer says a Page has to be connected for Messenger leads once one is', async () => {
    const { card } = await prepare('manage_lead_intake', { channel: 'messenger', active: true });
    expect(warned(card)).not.toContain('No Facebook Page is connected yet');
  });

  it('disconnects a whole sign-in and every Page it connected, only on Confirm', async () => {
    const sign = (await facebook()).connections.find((c) => c.status !== 'disconnected')!;
    const args = { connectionId: sign.id };
    const { card } = await prepare('do_meta_connection_disconnect', args);
    expect(warned(card)).toContain('Every Page and Instagram account it connected');
    expect(
      (await facebook()).accounts.filter((a) => a.status !== 'disconnected').length,
    ).toBeGreaterThan(0);

    await commit('do_meta_connection_disconnect', args);
    const after = await facebook();
    expect(after.accounts.every((a) => a.status === 'disconnected')).toBe(true);
    expect(after.connections.find((c) => c.id === sign.id)?.status ?? 'disconnected').toBe(
      'disconnected',
    );
  });
});
