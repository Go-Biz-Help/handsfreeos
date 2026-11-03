/**
 * The AI's hearing and voice on the wallet, at 1.5× (money/speech-usage.ts), on the real database: each use is
 * tallied in exact quantities; a running total is billed once it's worth a quarter or a day old, as one ledger row
 * per price line, priced by the card; a batch the sweep claimed and never marked is billed again on the same key,
 * so never twice; and with the wallet off nothing is billed and the tally waits.
 */
import { randomUUID } from 'node:crypto';
import { organizationCreate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs } from '@hfos/db/testing';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '@hfos/core/server';
import { chargeSpeech, noteSpeech } from '../src/money/speech-usage';
import type { WalletDeps } from '../src/money/wallet';
import type { TenantScope } from '../src/services';

const admin = () => testDbs().admin.db;
const log = pino({ level: process.env.DEBUG_SPEECH ? 'debug' : 'silent' });
let scope: TenantScope;
let deps: WalletDeps;

beforeAll(async () => {
  const owner = await createTestUser('speech-bill-owner');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Speech Billing HVAC' },
    { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
    { correlationId: randomUUID(), channel: 'test' },
  );
  scope = { workspaceId: output.workspaceId, organizationId: output.organizationId };
  deps = { db: testDbs().worker.db, log, mode: 'shadow' };
});
afterAll(async () => {
  await closeTestDbs();
});

const ledger = (key: string) =>
  rows<{
    amount_cents: string;
    cost_cents: string;
    quantity: string;
    unit: string;
    subject: string;
    idempotency_key: string;
  }>(
    admin(),
    sql`select amount_cents::text, cost_cents::text, quantity::text, unit::text, subject, idempotency_key
        from app.usage_ledger where workspace_id = ${scope.workspaceId} and rate_key = ${key}
        order by created_at`,
  );
const tally = (key: string) =>
  rows<{ quantity: string; batch_id: string | null; charged_at: Date | null; source: string }>(
    admin(),
    sql`select quantity::text, batch_id, charged_at, source from app.speech_usage
        where workspace_id = ${scope.workspaceId} and rate_key = ${key} order by created_at`,
  );

describe('the tally', () => {
  it('keeps each use exactly, and bills nothing while it’s worth under a quarter and under a day old', async () => {
    await noteSpeech(deps, scope, [
      { key: 'speech.recording.minute', quantity: 0.25, source: 'talk' },
      { key: 'speech.recording.minute', quantity: 0.125, source: 'talk' },
      // Nothing at all is not a use.
      { key: 'speech.recording.minute', quantity: 0, source: 'talk' },
    ]);
    await chargeSpeech(deps);
    const kept = await tally('speech.recording.minute');
    expect(kept.map((r) => Number(r.quantity))).toEqual([0.25, 0.125]);
    expect(kept.every((r) => r.charged_at === null && r.batch_id === null)).toBe(true);
    expect(await ledger('speech.recording.minute')).toEqual([]);
  });

  it('bills a running total at one and a half times what it cost, once it’s worth a quarter', async () => {
    await noteSpeech(deps, scope, [
      { key: 'speech.live.minute', quantity: 20, source: 'call', ref: 'CA1' },
      { key: 'speech.live.minute', quantity: 10, source: 'call', ref: 'CA2' },
    ]);
    await chargeSpeech(deps);
    const [row, ...more] = await ledger('speech.live.minute');
    expect(more).toEqual([]);
    // 30 minutes at $0.0092 is 27.6¢; at 1.5× it's 41.4¢, rounded once.
    expect(row).toMatchObject({
      amount_cents: '-41',
      cost_cents: '28',
      unit: 'minute',
      subject: 'AI voice: listening on calls',
    });
    expect(Number(row!.quantity)).toBe(30);
    expect(row!.idempotency_key).toMatch(/^speech:[0-9a-f-]{36}:speech\.live\.minute$/);
    expect((await tally('speech.live.minute')).every((r) => r.charged_at !== null)).toBe(true);
  });

  it('bills a Rime voice on its own line, at one and a half times its own price', async () => {
    await noteSpeech(deps, scope, [
      { key: 'speech.voice.coda.kchar', quantity: 10, source: 'call', ref: 'CA3' },
      { key: 'speech.voice.mist.kchar', quantity: 10, source: 'call', ref: 'CA3' },
    ]);
    await chargeSpeech(deps);
    // 10,000 characters: Coda's 50¢ is 75¢ at 1.5×, and Mist's 30¢ is 45¢.
    expect(await ledger('speech.voice.coda.kchar')).toEqual([
      expect.objectContaining({
        amount_cents: '-75',
        cost_cents: '50',
        unit: 'kchar',
        subject: 'AI voice: speaking in a Rime Coda voice',
      }),
    ]);
    expect(await ledger('speech.voice.mist.kchar')).toEqual([
      expect.objectContaining({
        amount_cents: '-45',
        cost_cents: '30',
        subject: 'AI voice: speaking in a Rime Mist voice',
      }),
    ]);
  });

  it('bills a total that has waited a day, whatever it’s worth', async () => {
    await rows(
      admin(),
      sql`update app.speech_usage set created_at = now() - interval '2 days'
          where workspace_id = ${scope.workspaceId} and rate_key = 'speech.recording.minute'`,
    );
    await chargeSpeech(deps);
    const [row] = await ledger('speech.recording.minute');
    // 0.375 minutes is 0.29¢ at 1.5×: the line's one-cent floor keeps the promise.
    expect(row).toMatchObject({
      amount_cents: '-1',
      subject: 'AI voice: turning speech into words',
    });
  });

  it('bills a batch it claimed and never marked on the same key, so never twice', async () => {
    await noteSpeech(deps, scope, [{ key: 'speech.voice.kchar', quantity: 12, source: 'talk' }]);
    await chargeSpeech(deps);
    expect(await ledger('speech.voice.kchar')).toHaveLength(1);
    // The sweep charged it and stopped before marking it: the next one finds the batch and charges it again.
    await rows(
      admin(),
      sql`update app.speech_usage set charged_at = null
          where workspace_id = ${scope.workspaceId} and rate_key = 'speech.voice.kchar'`,
    );
    await chargeSpeech(deps);
    const rowsNow = await ledger('speech.voice.kchar');
    expect(rowsNow).toHaveLength(1);
    // 12,000 characters at $0.030 per thousand is 36¢; 54¢ at 1.5×.
    expect(rowsNow[0]).toMatchObject({ amount_cents: '-54', unit: 'kchar' });
    expect((await tally('speech.voice.kchar')).every((r) => r.charged_at !== null)).toBe(true);
  });

  it('bills nothing with the wallet off, and keeps the tally for when it’s on', async () => {
    await noteSpeech(deps, scope, [{ key: 'speech.voice.kchar', quantity: 50, source: 'call' }]);
    expect(await chargeSpeech({ ...deps, mode: 'off' })).toBe(0);
    expect((await tally('speech.voice.kchar')).filter((r) => r.charged_at === null)).toHaveLength(
      1,
    );
    await chargeSpeech(deps);
    expect(await ledger('speech.voice.kchar')).toHaveLength(2);
  });
});
