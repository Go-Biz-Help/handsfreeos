/**
 * Signing in with a prompt (src/hfos/prompt.ts): the secret stays in the background and goes with every collect, a
 * prompt that ends forgets it, an approval is redeemed once, and only the prompt this extension started is asked about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/hfos/config', () => ({
  config: { workerUrl: 'https://hooks.example.test', apiUrl: 'x', webUrl: 'y' },
}));

let stored: Record<string, unknown> = {};
const area = {
  get: async (key: string) => ({ [key]: stored[key] }),
  set: async (values: Record<string, unknown>) => void Object.assign(stored, values),
  remove: async (key: string) => void delete stored[key],
};
vi.stubGlobal('chrome', { storage: { session: area, local: area } });
vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/140.0' });

const { browserName, checkPrompt, startPrompt, PromptRefused } = await import('../src/hfos/prompt');

const REQUEST = '3f1c2a4e-8b7d-4c1e-9a2f-5d6e7f8a9b0c';
const SECRET = 'a'.repeat(43);

function worker(answers: Record<string, () => { status: number; body: unknown }>) {
  const calls: { path: string; body: unknown }[] = [];
  const impl = (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body) as unknown });
    const a = answers[path]!();
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const started = () => ({
  status: 200,
  body: { requestId: REQUEST, number: 42, secret: SECRET, expiresAt: new Date().toISOString() },
});

beforeEach(() => {
  stored = {};
});

describe('a sign-in prompt', () => {
  it('shows the number, keeps the secret here, and sends the browser’s name', async () => {
    const w = worker({ '/public/extension-sign-in/start': started });
    const out = await startPrompt('dale@example.com', w.impl);
    expect(out).toEqual({ requestId: REQUEST, number: 42, expiresAt: expect.any(String) });
    expect(out).not.toHaveProperty('secret');
    expect(w.calls[0]!.body).toEqual({ email: 'dale@example.com', browser: 'Chrome' });
    expect(JSON.stringify(stored)).toContain(SECRET);
  });

  it('collects with the secret, keeps it while waiting, and redeems an approval once', async () => {
    let next: unknown = { status: 'waiting' };
    const w = worker({
      '/public/extension-sign-in/start': started,
      '/public/extension-sign-in/collect': () => ({ status: 200, body: next }),
    });
    await startPrompt('dale@example.com', w.impl);
    const redeem = vi.fn(async () => undefined);
    expect(await checkPrompt(REQUEST, redeem, w.impl)).toBe('waiting');
    expect(w.calls[1]!.body).toEqual({ requestId: REQUEST, secret: SECRET });
    next = { status: 'approved', tokenHash: 'hash-1' };
    expect(await checkPrompt(REQUEST, redeem, w.impl)).toBe('signed-in');
    expect(redeem).toHaveBeenCalledExactlyOnceWith('hash-1');
    // Done with: the secret is gone, so nothing is asked again.
    expect(await checkPrompt(REQUEST, redeem, w.impl)).toBe('expired');
    expect(w.calls).toHaveLength(3);
  });

  it('forgets a prompt that was refused, and never asks about one it didn’t start', async () => {
    const w = worker({
      '/public/extension-sign-in/start': started,
      '/public/extension-sign-in/collect': () => ({ status: 200, body: { status: 'refused' } }),
    });
    expect(await checkPrompt(REQUEST, async () => undefined, w.impl)).toBe('expired');
    expect(w.calls).toHaveLength(0);
    await startPrompt('dale@example.com', w.impl);
    expect(await checkPrompt(REQUEST, async () => undefined, w.impl)).toBe('refused');
    expect(stored).toEqual({});
  });

  it('says HandsFreeOS’s words when the worker refuses', async () => {
    const w = worker({
      '/public/extension-sign-in/start': () => ({
        status: 429,
        body: { error: { message: 'That’s a lot of sign-in prompts.' } },
      }),
    });
    await expect(startPrompt('dale@example.com', w.impl)).rejects.toThrow(PromptRefused);
    await expect(startPrompt('dale@example.com', w.impl)).rejects.toThrow(
      'That’s a lot of sign-in prompts.',
    );
  });

  it('names the browser', () => {
    expect(browserName('Mozilla/5.0 Chrome/140.0 Edg/140.0')).toBe('Edge');
    expect(browserName('Mozilla/5.0 Chrome/140.0')).toBe('Chrome');
  });
});
