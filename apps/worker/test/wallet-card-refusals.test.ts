/**
 * When the provider will not put a card on a balance, what the person is told and what we are.
 *
 * Every refusal here used to reach the worker's last-resort handler and come back as "Something went wrong on
 * our side." The first real one was Stripe saying, on every single press, that it had never heard of
 * `setup_intent_data[usage]` — and nobody could see that, because the page said nothing and the log said
 * nothing either. So the first case below is that exact answer, replayed through the real Stripe provider.
 *
 * Runs without a database.
 */
import { HfosError } from '@hfos/core/server';
import { describe, expect, it, vi } from 'vitest';
import { refused } from '../src/money/wallet-card-routes';
import { PaymentError, PlatformUnsupportedError } from '../src/payments/provider';
import { createStripePayments } from '../src/payments/stripe';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

const logs = () => {
  const log = { error: vi.fn(), warn: vi.fn() };
  return { deps: { log } as unknown as Parameters<typeof refused>[0], log };
};

/** Stripe, answering every request with one status and body. */
function stripeRefusing(status: number, body: unknown) {
  const fetchStub = async (): Promise<Response> =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return createStripePayments({
    clientId: 'ca_test',
    secretKey: 'sk_test',
    publishableKey: 'pk_test',
    webhookSecret: 'whsec_test',
    fetch: fetchStub as typeof fetch,
  });
}

const start = (provider: ReturnType<typeof createStripePayments>) =>
  provider.platform.startCardSession({
    customerRef: 'cus_hfos_1',
    reference: 'ws-1',
    returnUrl: 'https://app.test/app/w/ws-1/settings/usage',
    idempotencyKey: 'wallet-card:ws-1:1',
  });

describe('a card the provider will not take', () => {
  it('says so in words, and logs what Stripe actually said, when Stripe refuses our own request', async () => {
    // Word for word what the sandbox answered for the request that shipped.
    const provider = stripeRefusing(400, {
      error: {
        type: 'invalid_request_error',
        code: 'parameter_unknown',
        message: 'Received unknown parameter: setup_intent_data[usage]',
      },
    });
    const e = await start(provider).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PaymentError);

    const { deps, log } = logs();
    const told = refused(deps, e, WORKSPACE);
    expect(told).toBeInstanceOf(HfosError);
    expect((told as HfosError).rule).toBe('wallet_card_unavailable');
    expect((told as HfosError).status).toBe(502);
    expect((told as HfosError).message).not.toMatch(/something went wrong/i);
    expect((told as HfosError).message).toMatch(/nothing was charged/i);
    // Ours to fix, so it is an error and it names the reason — which is the whole of what was missing.
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toMatchObject({
      workspaceId: WORKSPACE,
      code: 'parameter_unknown',
      status: 400,
    });
  });

  it('asks for another try, and only warns, when the provider did not answer', async () => {
    const provider = stripeRefusing(503, { error: { type: 'api_error', message: 'Try again' } });
    const e = await start(provider).catch((x: unknown) => x);

    const { deps, log } = logs();
    const told = refused(deps, e, WORKSPACE) as HfosError;
    expect(told.rule).toBe('wallet_card_retry');
    expect(told.message).toMatch(/try again/i);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('passes on the words already written for a provider that cannot bill for us', () => {
    const { deps } = logs();
    const told = refused(deps, new PlatformUnsupportedError('square'), WORKSPACE) as HfosError;
    expect(told.rule).toBe('wallet_card_unsupported');
    expect(told.status).toBe(409);
    expect(told.message).toMatch(/Connect Stripe/);
  });

  it('leaves everything else exactly as it was', () => {
    const { deps, log } = logs();
    const forbidden = HfosError.forbidden();
    expect(refused(deps, forbidden, WORKSPACE)).toBe(forbidden);
    const surprise = new Error('not a payment');
    expect(refused(deps, surprise, WORKSPACE)).toBe(surprise);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
