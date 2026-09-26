/**
 * Conversions sent to Opinly (analytics/opinly.ts): what goes over the wire, and what happens when Opinly says
 * no. The sender is exercised with no user attached, so these need no database; queueing with analytics off is
 * checked to touch nothing at all.
 */
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalytics, queueConversion, sendConversion } from '../src/analytics/opinly';
import type { JobContext } from '../src/jobs';
import type { Tx } from '@hfos/db/client';

const log = pino({ level: 'silent' });
const analytics = { apiKey: 'sk-test', url: 'https://opinly.test' };

const jobCtx = (payload: Record<string, unknown>, withAnalytics = true) =>
  ({
    log,
    ...(withAnalytics ? { analytics } : {}),
    job: { payload },
    scope: {},
  }) as unknown as JobContext;

const purchase = {
  event: 'purchase',
  properties: { value: 497, currency: 'USD', transaction_id: 'chk_1' },
  externalEventId: 'chk_1',
  userId: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAnalytics', () => {
  it('is absent without a key, so nothing is ever queued', () => {
    expect(createAnalytics({ opinlyApiKey: null, opinlyApiUrl: 'https://sdk.opinly.ai' })).toEqual(
      {},
    );
    expect(
      createAnalytics({ opinlyApiKey: 'sk-live', opinlyApiUrl: 'https://sdk.opinly.ai/' }),
    ).toEqual({ analytics: { apiKey: 'sk-live', url: 'https://sdk.opinly.ai' } });
  });
});

describe('queueConversion', () => {
  it('does nothing at all when analytics is off', async () => {
    const tx = { transaction: vi.fn(), execute: vi.fn() } as unknown as Tx;
    await queueConversion(
      { log },
      tx,
      { workspaceId: null, organizationId: null },
      {
        event: 'sign_up',
        properties: {},
        externalEventId: 'sign_up:u1',
        userId: 'u1',
      },
    );
    expect(tx.transaction).not.toHaveBeenCalled();
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('never fails the work it rides on', async () => {
    const tx = { transaction: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as Tx;
    await expect(
      queueConversion(
        { log, analytics },
        tx,
        { workspaceId: 'w', organizationId: 'o' },
        {
          event: 'purchase',
          properties: {},
          externalEventId: 'chk_1',
          userId: null,
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('sendConversion', () => {
  it('posts the event to /v1/events with the secret key', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"recorded":true}', { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await sendConversion(jobCtx(purchase));
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://opinly.test/v1/events');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
    expect(JSON.parse(init.body)).toEqual({
      event: 'purchase',
      properties: { value: 497, currency: 'USD', transaction_id: 'chk_1' },
      externalEventId: 'chk_1',
    });
  });

  it('drops an event Opinly refuses, rather than retrying it for ever', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 400 })));
    await expect(sendConversion(jobCtx(purchase))).resolves.toBeUndefined();
  });

  it('throws on an outage, so the job tries again later', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('down', { status: 503 })));
    await expect(sendConversion(jobCtx(purchase))).rejects.toThrow(/503/);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(sendConversion(jobCtx(purchase))).rejects.toThrow(/fetch failed/);
  });

  it('sends nothing once analytics has been switched off', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await sendConversion(jobCtx(purchase, false));
    expect(fetch).not.toHaveBeenCalled();
  });
});
