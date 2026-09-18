import { moneyLink } from '../actions';

/**
 * The customer's own link comes from the worker, with the person's own token. The token is a promise (it refreshes one
 * that ran out while the phone was offline), and not awaiting it sends the word "[object Promise]" as the bearer,
 * which the worker answers "Sign in to continue." — step 16 shipped exactly that, so this is the guard.
 */

const mockFetch = jest.fn();
jest.mock('@/lib/network', () => ({ appFetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('@/lib/config', () => ({ config: { workerUrl: 'http://worker.test' } }));
jest.mock('@/lib/auth', () => ({
  session: { accessToken: () => Promise.resolve('a-real-token') },
}));
// `actions.ts` also pulls in the queue, which opens the phone's own store when it loads; the link never touches it.
jest.mock('@/changes', () => ({ change: jest.fn() }));

const input = { workspaceId: 'ws', kind: 'invoice' as const, id: 'inv' };

describe('a customer’s payment link', () => {
  beforeEach(() => mockFetch.mockReset());

  it('asks the worker with the person’s own token, and gives the link back', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://app.test/i/abc' }),
    });
    await expect(moneyLink(input)).resolves.toBe('https://app.test/i/abc');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://worker.test/v1/money/link');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer a-real-token');
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

  it('says it needs signal when the worker can’t be reached, and the worker’s own words when it answers', async () => {
    mockFetch.mockRejectedValue(new TypeError('Network request failed'));
    await expect(moneyLink(input)).rejects.toThrow('This needs signal.');
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Send the invoice first.' } }),
    });
    await expect(moneyLink(input)).rejects.toThrow('Send the invoice first.');
  });
});
