/**
 * Which HTTP requests are worked for a practice business with its stand-ins (practice/request.ts). Naming a practice
 * business's id is never enough: the stand-ins' signing secrets and payments are pretend and public in this repo, so
 * a provider calling back, a signed-out page and someone who isn't practising there all get the real services.
 */
import { describe, expect, it, vi } from 'vitest';
import { practiceForRequest, type PracticeRequestDeps } from '../src/practice/request';
import type { PracticeRun } from '../src/practice/scope';

const PRACTICE_WS = '11111111-1111-4111-8111-111111111111';
const run: PracticeRun = {
  organizationId: '22222222-2222-4222-8222-222222222222',
  ownerEmail: 'pat@handsfreeos.test',
};

function deps(over: Partial<PracticeRequestDeps> = {}): PracticeRequestDeps {
  return {
    runFor: vi.fn(async () => run),
    signedIn: vi.fn(async () => 'staff-user'),
    practises: vi.fn(async (userId: string) => userId === 'staff-user'),
    ...over,
  };
}

describe('a request about a practice business', () => {
  it('gets the stand-ins when the person practising there is signed in', async () => {
    const d = deps();
    expect(
      await practiceForRequest('/v1/telephony/available-numbers', { workspaceId: PRACTICE_WS }, d),
    ).toEqual(run);
    expect(d.practises).toHaveBeenCalledWith('staff-user', run.organizationId);
  });

  it.each([
    '/webhooks/stripe?workspaceId=' + PRACTICE_WS,
    '/webhooks/stripe/platform?organizationId=' + run.organizationId,
    '/webhooks/square',
    '/webhooks/paypal',
    '/webhooks/twilio/messaging/inbound?workspaceId=' + PRACTICE_WS,
    '/webhooks/zoom',
    '/Webhooks/stripe',
    '/meta/deauthorize',
  ])('never for a provider calling back: %s', async (url) => {
    const d = deps();
    expect(await practiceForRequest(url, { workspaceId: PRACTICE_WS }, d)).toBeNull();
    // Not even looked up: the real secrets decide.
    expect(d.runFor).not.toHaveBeenCalled();
  });

  it('never for a signed-out request, such as a public pay page naming one', async () => {
    const d = deps({ signedIn: vi.fn(async () => null) });
    expect(
      await practiceForRequest(
        '/public/invoice/tok/pay?workspaceId=' + PRACTICE_WS,
        { workspaceId: PRACTICE_WS },
        d,
      ),
    ).toBeNull();
  });

  it('never for someone signed in who doesn’t practise there', async () => {
    const d = deps({ signedIn: vi.fn(async () => 'someone-else') });
    expect(
      await practiceForRequest(
        '/v1/plan/card?organizationId=' + run.organizationId,
        { organizationId: run.organizationId },
        d,
      ),
    ).toBeNull();
  });

  it('a real business needs no sign-in check at all', async () => {
    const d = deps({ runFor: vi.fn(async () => null) });
    expect(await practiceForRequest('/v1/telephony/account', { workspaceId: 'x' }, d)).toBeNull();
    expect(d.signedIn).not.toHaveBeenCalled();
  });
});
