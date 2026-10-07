import { describe, expect, it } from 'vitest';
import { createMetaGraph } from '../src/social/graph';

describe('the Meta graph', () => {
  it('asks Meta for the chats another app holds when it subscribes a Page', async () => {
    const asked: URL[] = [];
    const graph = createMetaGraph({
      appId: '1234',
      appSecret: 'not-a-real-secret',
      version: 'v26.0',
      loginConfigId: null,
      fetchUrl: () => Promise.reject(new Error('No file is fetched here.')),
      fetch: (async (url: string | URL | Request) => {
        asked.push(new URL(String(url)));
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    await graph.subscribe('1000', 'page-token');

    expect(asked.map((u) => u.pathname)).toEqual(['/v26.0/1000/subscribed_apps']);
    expect(asked[0]!.searchParams.get('subscribed_fields')!.split(',')).toEqual(
      expect.arrayContaining(['messages', 'messaging_referrals', 'message_echoes', 'standby']),
    );
  });
});
