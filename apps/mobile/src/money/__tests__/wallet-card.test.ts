import { walletCard } from '../use-wallet';

/**
 * Putting a card on the balance from the phone: the worker's route, with the person's own token.
 *
 * The card never comes near this call. The first half asks for the provider's page and gets an address; the
 * second half hands back the session they returned on, and the worker reads the card off the provider itself —
 * so nothing here, and nothing in the app's address bar, is ever a card number.
 */

const mockFetch = jest.fn();
jest.mock('@/lib/network', () => ({ appFetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('@/lib/config', () => ({ config: { workerUrl: 'http://worker.test' } }));
jest.mock('@/lib/auth', () => ({
  session: { accessToken: () => Promise.resolve('a-real-token') },
}));

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('a card for the balance', () => {
  beforeEach(() => mockFetch.mockReset());

  it('asks the worker for the provider’s page, with the person’s own token', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ stage: 'started', hostedUrl: 'https://pay.test/card/abc' }),
    });
    await expect(walletCard({ workspaceId })).resolves.toEqual({
      stage: 'started',
      hostedUrl: 'https://pay.test/card/abc',
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://worker.test/v1/wallet/card');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-real-token');
    expect(JSON.parse(init.body as string)).toEqual({ workspaceId });
  });

  it('hands back the session they returned on, and nothing else', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ stage: 'saved', card: { cardLast4: '4242' } }),
    });
    await expect(walletCard({ workspaceId, sessionRef: 'cses_1' })).resolves.toEqual({
      stage: 'saved',
      card: { cardLast4: '4242' },
    });
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ workspaceId, sessionRef: 'cses_1' });
  });

  it('says it needs signal when the worker can’t be reached, and the worker’s own words when it refuses', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await expect(walletCard({ workspaceId })).rejects.toThrow('Your balance needs a signal.');
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Connect Stripe to keep your balance topped up.' } }),
    });
    await expect(walletCard({ workspaceId })).rejects.toThrow(
      'Connect Stripe to keep your balance topped up.',
    );
  });
});
