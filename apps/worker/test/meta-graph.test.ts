import { describe, expect, it } from 'vitest';
import { createMetaGraph } from '../src/social/graph';

/** The real graph against a stand-in for Meta's servers: each ask kept, and answered by `answer`. */
function graphAnswering(answer: (url: URL) => { status: number; body: unknown }) {
  const asked: URL[] = [];
  const graph = createMetaGraph({
    appId: '1234',
    appSecret: 'not-a-real-secret',
    version: 'v26.0',
    loginConfigId: null,
    fetchUrl: () => Promise.reject(new Error('No file is fetched here.')),
    fetch: (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      asked.push(u);
      const { status, body } = answer(u);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  return { graph, asked };
}

const ok = () => ({ status: 200, body: { success: true } });
const fieldsOf = (u: URL) => u.searchParams.get('fields')!.split(',');

describe('the Meta graph', () => {
  it('asks Meta for the chats another app holds when it subscribes a Page', async () => {
    const { graph, asked } = graphAnswering(ok);

    await graph.subscribe('1000', 'page-token');

    expect(asked.map((u) => u.pathname)).toEqual(['/v26.0/1000/subscribed_apps']);
    expect(asked[0]!.searchParams.get('subscribed_fields')!.split(',')).toEqual(
      expect.arrayContaining(['messages', 'messaging_referrals', 'message_echoes', 'standby']),
    );
  });

  it('points the app’s own webhook here for Pages and Instagram, standby included', async () => {
    const { graph, asked } = graphAnswering(ok);

    const out = await graph.subscribeApp({
      callbackUrl: 'https://hooks.example.com/webhooks/meta',
      verifyToken: 'a-verify-token-of-sixteen',
    });

    expect(out.refused).toEqual([]);
    expect(asked.map((u) => [u.pathname, u.searchParams.get('object')])).toEqual([
      ['/v26.0/1234/subscriptions', 'page'],
      ['/v26.0/1234/subscriptions', 'instagram'],
    ]);
    for (const u of asked) {
      expect(u.searchParams.get('callback_url')).toBe('https://hooks.example.com/webhooks/meta');
      expect(u.searchParams.get('verify_token')).toBe('a-verify-token-of-sixteen');
      // The app's own token: its id and secret.
      expect(u.searchParams.get('access_token')).toBe('1234|not-a-real-secret');
    }
    expect(fieldsOf(asked[0]!)).toEqual(
      expect.arrayContaining(['messages', 'messaging_referrals', 'message_echoes', 'standby']),
    );
    expect(fieldsOf(asked[1]!)).toEqual(
      expect.arrayContaining(['messages', 'messaging_referral', 'standby']),
    );
  });

  it('still asks for the rest when Meta won’t take standby, and says so', async () => {
    const { graph, asked } = graphAnswering((u) =>
      fieldsOf(u).includes('standby')
        ? {
            status: 400,
            body: { error: { message: '(#100) Invalid field: standby', code: 100 } },
          }
        : ok(),
    );

    const out = await graph.subscribeApp({
      callbackUrl: 'https://hooks.example.com/webhooks/meta',
      verifyToken: 'a-verify-token-of-sixteen',
    });

    expect(out.refused).toEqual(['page.standby', 'instagram.standby']);
    const taken = asked.filter((u) => !fieldsOf(u).includes('standby'));
    expect(taken.flatMap(fieldsOf)).toEqual(
      expect.arrayContaining(['messages', 'message_echoes', 'message_edits', 'message_edit']),
    );
  });

  it('gives up on the app’s webhook when Meta can’t check the address', async () => {
    const { graph, asked } = graphAnswering(() => ({
      status: 400,
      body: { error: { message: '(#2200) Callback verification failed', code: 2200 } },
    }));

    await expect(
      graph.subscribeApp({
        callbackUrl: 'https://hooks.example.com/webhooks/meta',
        verifyToken: 'a-verify-token-of-sixteen',
      }),
    ).rejects.toThrow('Callback verification failed');
    expect(asked).toHaveLength(1);
  });
});
