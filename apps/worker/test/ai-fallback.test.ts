import {
  AiProviderError,
  FallbackProvider,
  ScriptedProvider,
  emptyUsage,
  type AiProvider,
  type AiRequest,
  type AiRoute,
  type AiSwitch,
  type AiTurn,
} from '@hfos/ai';
import { rows, sql, type Db } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AiSwitchboard,
  CLAUDE_STATUS_URL,
  GOOD_CHECKS_TO_RETURN,
  TRIP_FAILURES,
  TRIP_WINDOW_MS,
} from '../src/ai/switch';
import type { MailMessage } from '../src/mailer';
import { testServices } from './helpers';

/** Claude with OpenAI behind it: who answers, and when the backup takes a request Claude failed. */

const request: AiRequest = { system: 'Be brief.', messages: [{ role: 'user', content: 'Hi' }] };
const turn = (text: string): AiTurn => ({
  text,
  toolCalls: [],
  stopReason: 'end_turn',
  usage: emptyUsage,
});

/** A provider that answers `text`, or fails with `error`, after saying `streamed` first. */
function fake(
  id: string,
  model: string,
  opts: { error?: AiProviderError; streamed?: string; toolSearch?: boolean; warms?: boolean } = {},
) {
  const calls: AiRequest[] = [];
  const provider: AiProvider = {
    id,
    model,
    toolSearch: opts.toolSearch ?? false,
    async stream(r, o) {
      calls.push(r);
      if (opts.streamed) o?.onText?.(opts.streamed);
      if (opts.error) throw opts.error;
      return turn(`${id} answered`);
    },
    ...(opts.warms ? { warm: async () => ({ ...emptyUsage, cacheWriteTokens: 1000 }) } : {}),
  };
  return { provider, calls };
}

function fakeSwitch(route: AiRoute = 'primary') {
  const told = { failed: [] as string[], worked: 0 };
  const sw: AiSwitch & { route: () => AiRoute; set: (r: AiRoute) => void } = {
    route: () => route,
    set: (r) => (route = r),
    primaryFailed: (e) => told.failed.push(e.code),
    primaryWorked: () => void told.worked++,
  };
  return { sw, told };
}

const overloaded = () => new AiProviderError('Overloaded', 'overloaded', true, 529);

describe('FallbackProvider', () => {
  it('answers from Claude while Claude is well, and says so', async () => {
    const claude = fake('anthropic', 'claude-sonnet-5');
    const openai = fake('openai', 'gpt-6-sol');
    const { sw, told } = fakeSwitch();
    const provider = new FallbackProvider(claude.provider, openai.provider, sw);
    const answer = await provider.stream(request);
    expect(answer.text).toBe('anthropic answered');
    expect(answer.model).toBe('claude-sonnet-5');
    expect(openai.calls).toHaveLength(0);
    expect(told.worked).toBe(1);
  });

  it('has the backup answer the same request at once when Claude is down before saying anything', async () => {
    const claude = fake('anthropic', 'claude-sonnet-5', { error: overloaded() });
    const openai = fake('openai', 'gpt-6-sol');
    const { sw, told } = fakeSwitch();
    const answer = await new FallbackProvider(claude.provider, openai.provider, sw).stream(request);
    expect(answer.text).toBe('openai answered');
    // Recorded as the model that really answered.
    expect(answer.model).toBe('gpt-6-sol');
    expect(openai.calls).toEqual([request]);
    expect(told.failed).toEqual(['overloaded']);
  });

  it('leaves a failure alone once words were shown, or when the request itself was wrong', async () => {
    const midway = fake('anthropic', 'claude-sonnet-5', {
      streamed: 'Let me',
      error: new AiProviderError('Gone', 'unavailable', true, 500),
    });
    const openai = fake('openai', 'gpt-6-sol');
    const { sw, told } = fakeSwitch();
    const shown: string[] = [];
    await expect(
      new FallbackProvider(midway.provider, openai.provider, sw).stream(request, {
        onText: (d) => shown.push(d),
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(shown).toEqual(['Let me']);
    // It still counts: Claude is in trouble either way.
    expect(told.failed).toEqual(['unavailable']);

    const wrong = fake('anthropic', 'claude-sonnet-5', {
      error: new AiProviderError('Bad', 'bad_request', false, 400),
    });
    await expect(
      new FallbackProvider(wrong.provider, openai.provider, sw).stream(request),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(openai.calls).toHaveLength(0);
    expect(told.failed).toEqual(['unavailable']);
  });

  it('sends everything to the backup while switched, and names it as the model', async () => {
    const claude = fake('anthropic', 'claude-opus-5-5', { toolSearch: true, warms: true });
    const openai = fake('openai', 'gpt-6-sol', { toolSearch: false });
    const { sw } = fakeSwitch('backup');
    const provider = new FallbackProvider(claude.provider, openai.provider, sw);
    expect(provider.id).toBe('openai');
    expect(provider.model).toBe('gpt-6-sol');
    expect(provider.toolSearch).toBe(false);
    expect((await provider.stream(request)).text).toBe('openai answered');
    expect(claude.calls).toHaveLength(0);
    // OpenAI's cache fills itself: nothing to warm, nothing spent.
    expect(await provider.warm(request)).toEqual(emptyUsage);

    sw.set('primary');
    expect(provider.model).toBe('claude-opus-5-5');
    expect(provider.toolSearch).toBe(true);
    expect((await provider.warm(request)).cacheWriteTokens).toBe(1000);
  });

  it('pinned on Claude, never falls back', async () => {
    const claude = fake('anthropic', 'claude-sonnet-5', { error: overloaded() });
    const openai = fake('openai', 'gpt-6-sol');
    const { sw, told } = fakeSwitch('primary_only');
    await expect(
      new FallbackProvider(claude.provider, openai.provider, sw).stream(request),
    ).rejects.toMatchObject({ code: 'overloaded' });
    expect(openai.calls).toHaveLength(0);
    expect(told.failed).toEqual([]);
  });
});

describe('AiSwitchboard', () => {
  /** A database that isn't there: moves are still made on this machine, and the failure to record one is logged. */
  const noDb = { transaction: () => Promise.reject(new Error('no database')) } as unknown as Db;

  it(`moves to OpenAI after ${TRIP_FAILURES} failures within the window, not before`, async () => {
    let now = 1_000_000;
    const board = new AiSwitchboard({
      db: noDb,
      log: pino({ level: 'silent' }),
      mailer: { send: async () => ({ messageId: '' }) },
      alertEmails: [],
      webUrl: 'https://app.test',
      claude: new ScriptedProvider([]),
      now: () => now,
    });
    expect(board.route()).toBe('primary');
    for (let i = 0; i < TRIP_FAILURES - 1; i++) board.primaryFailed(overloaded());
    // Out of the window: the earlier ones no longer count.
    now += TRIP_WINDOW_MS;
    board.primaryFailed(overloaded());
    expect(board.route()).toBe('primary');
    board.primaryWorked();
    for (let i = 0; i < TRIP_FAILURES - 1; i++) board.primaryFailed(overloaded());
    expect(board.route()).toBe('primary');
    board.primaryFailed(overloaded());
    expect(board.route()).toBe('backup');
    expect(board.answering()).toBe('openai');
  });
});

describe('the 5-minute check', () => {
  const admin = () => testDbs().admin.db;
  const sent: MailMessage[] = [];
  let status = 'operational';
  let claudeAnswers = true;
  const statusPage = (async (url: string | URL | Request) => {
    expect(String(url)).toBe(CLAUDE_STATUS_URL);
    return Response.json({
      components: [
        { name: 'claude.ai', status: 'major_outage' },
        { name: 'Claude API (api.anthropic.com)', status },
      ],
    });
  }) as unknown as typeof fetch;
  const claude: AiProvider = {
    id: 'anthropic',
    model: 'claude-sonnet-5',
    async stream() {
      if (!claudeAnswers) throw overloaded();
      return turn('Yes');
    },
  };
  const board = () =>
    new AiSwitchboard({
      db: testDbs().worker.db,
      log: testServices().log,
      mailer: {
        send: async (m) => {
          sent.push(m);
          return { messageId: 'm' };
        },
      },
      alertEmails: ['chris@example.test'],
      webUrl: 'https://app.test/',
      claude,
      fetch: statusPage,
    });
  const row = async () =>
    (
      await rows<{
        active: string;
        reason: string | null;
        good_checks: number;
        claude_status: string;
      }>(admin(), sql`select active, reason, good_checks, claude_status from platform.ai_provider`)
    )[0]!;

  /** The one row is shared by everything that runs against this database, so it goes back as it was found. */
  let found: Record<string, unknown>;
  let letGo: () => Promise<void>;
  beforeAll(async () => {
    // `pnpm test` runs every package's tests at once, and core's switch tests use the same row: whoever holds
    // this lock has it to themselves (packages/core/test/ai-provider.test.ts). The lock is the connection's.
    const conn = await testDbs().admin.client.reserve();
    await conn`select pg_advisory_lock(hashtext('platform.ai_provider'))`;
    letGo = async () => {
      await conn`select pg_advisory_unlock(hashtext('platform.ai_provider'))`;
      conn.release();
    };
    [found] = await rows<Record<string, unknown>>(
      admin(),
      sql`select mode, active, reason, claude_status, good_checks, checked_at, switched_at
          from platform.ai_provider`,
    );
  });

  beforeEach(async () => {
    sent.length = 0;
    status = 'operational';
    claudeAnswers = true;
    await rows(
      admin(),
      sql`update platform.ai_provider set mode = 'auto', active = 'claude', reason = null, good_checks = 0,
            claude_status = null, checked_at = null, switched_at = null`,
    );
  });
  afterAll(async () => {
    const f = found as {
      mode: string;
      active: string;
      reason: string | null;
      claude_status: string | null;
      good_checks: number;
      checked_at: Date | null;
      switched_at: Date | null;
    };
    await rows(
      admin(),
      sql`update platform.ai_provider set mode = ${f.mode}, active = ${f.active}, reason = ${f.reason},
            claude_status = ${f.claude_status}, good_checks = ${f.good_checks},
            checked_at = ${f.checked_at}, switched_at = ${f.switched_at}`,
    );
    await letGo();
    await closeTestDbs();
  });

  it('moves to OpenAI when the status page says the Claude API is slow, and tells the team once', async () => {
    const one = board();
    const other = board();
    status = 'degraded_performance';
    expect(await one.check()).toEqual({ status: 'degraded_performance', answering: 'openai' });
    expect(await other.check()).toEqual({ status: 'degraded_performance', answering: 'openai' });
    expect(await row()).toMatchObject({ active: 'openai', reason: 'status', good_checks: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'chris@example.test',
      subject: 'The AI switched to OpenAI',
    });
    expect(sent[0]!.text).toContain('the Claude API is slow');
    expect(sent[0]!.text).toContain('https://app.test/admin/health');
  });

  it(`comes back after ${GOOD_CHECKS_TO_RETURN} good checks in a row, only when Claude answers too`, async () => {
    const b = board();
    status = 'major_outage';
    await b.check();
    status = 'operational';
    claudeAnswers = false;
    await b.check();
    expect(await row()).toMatchObject({ active: 'openai', good_checks: 0 });
    claudeAnswers = true;
    await b.check();
    expect(await row()).toMatchObject({ active: 'openai', good_checks: 1 });
    expect(b.route()).toBe('backup');
    await b.check();
    expect(await row()).toMatchObject({ active: 'claude', reason: null, good_checks: 0 });
    expect(b.route()).toBe('primary');
    expect(sent.map((m) => m.subject)).toEqual([
      'The AI switched to OpenAI',
      'The AI is back on Claude',
    ]);
  });

  it('changes nothing when the status page can’t be read', async () => {
    const b = new AiSwitchboard({
      db: testDbs().worker.db,
      log: testServices().log,
      mailer: { send: async () => ({ messageId: '' }) },
      alertEmails: [],
      webUrl: 'https://app.test',
      claude,
      fetch: (async () => new Response('down', { status: 502 })) as unknown as typeof fetch,
    });
    expect(await b.check()).toEqual({ status: null, answering: 'claude' });
    expect(await row()).toMatchObject({ active: 'claude', claude_status: null });
  });

  it('follows support’s switch whatever the checks say, and tells nobody while pinned', async () => {
    const b = board();
    await rows(admin(), sql`update platform.ai_provider set mode = 'openai'`);
    await b.refresh();
    expect(b.route()).toBe('backup');
    await rows(admin(), sql`update platform.ai_provider set mode = 'claude'`);
    await b.refresh();
    status = 'major_outage';
    await b.check();
    expect(b.route()).toBe('primary_only');
    expect(await row()).toMatchObject({ active: 'openai' });
    expect(sent).toHaveLength(0);
  });
});
