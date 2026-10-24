import { describe, expect, it } from 'vitest';
import { splitLeadgen } from '../src/social/events';
import { createMetaGraph, leadFormOf, leadOf } from '../src/social/graph';

/** The real graph against a stand-in for Meta's servers: each ask kept, and answered by `answer`. */
function graphAnswering(
  answer: (url: URL) => { status: number; body: unknown },
  opts: { leadAds?: boolean } = {},
) {
  const asked: URL[] = [];
  const graph = createMetaGraph({
    appId: '1234',
    appSecret: 'not-a-real-secret',
    version: 'v26.0',
    loginConfigId: null,
    leadAds: opts.leadAds ?? false,
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

describe('lead ads', () => {
  it('asks for leads at sign-in and on the Page only when the server is set to', async () => {
    const off = graphAnswering(ok);
    const on = graphAnswering(ok, { leadAds: true });
    const scopes = (url: string) => new URL(url).searchParams.get('scope')!.split(',');
    const authorize = { state: 'x', redirectUri: 'https://hooks.example.com/cb' };
    expect(scopes(off.graph.authorizeUrl(authorize))).not.toContain('leads_retrieval');
    expect(scopes(on.graph.authorizeUrl(authorize))).toEqual(
      expect.arrayContaining(['leads_retrieval', 'pages_manage_ads']),
    );
    await off.graph.subscribe('1000', 'page-token');
    await on.graph.subscribe('1000', 'page-token');
    const fields = (u: URL) => u.searchParams.get('subscribed_fields')!.split(',');
    expect(fields(off.asked[0]!)).not.toContain('leadgen');
    expect(fields(on.asked[0]!)).toContain('leadgen');
  });

  it('keeps a Page’s messages coming when Meta won’t send its leads', async () => {
    const { graph, asked } = graphAnswering(
      (u) =>
        u.searchParams.get('subscribed_fields')?.includes('leadgen')
          ? {
              status: 403,
              body: { error: { message: '(#200) Requires pages_manage_ads', code: 200 } },
            }
          : ok(),
      { leadAds: true },
    );

    await graph.subscribe('1000', 'page-token');

    expect(asked).toHaveLength(2);
    expect(asked[1]!.searchParams.get('subscribed_fields')).toContain('messages');
    expect(asked[1]!.searchParams.get('subscribed_fields')).not.toContain('leadgen');
  });

  it('reads a lead: its answers, its ticked boxes, and where it was seen', () => {
    const lead = leadOf({
      id: '9001',
      created_time: '2026-10-27T15:04:05+0000',
      form_id: '7001',
      ad_id: '120200000000001',
      platform: 'ig',
      is_organic: false,
      field_data: [
        { name: 'full_name', values: ['Morgan Lee'] },
        { name: 'phone_number', values: ['+15125550701'] },
        { name: 'broken' },
      ],
      custom_disclaimer_responses: [
        { checkbox_key: 'texts', is_checked: '1' },
        { checkbox_key: 'calls', is_checked: '' },
      ],
    });
    expect(lead).toMatchObject({
      id: '9001',
      formId: '7001',
      platform: 'instagram',
      createdAt: '2026-10-27T15:04:05.000Z',
      answers: [
        { name: 'full_name', values: ['Morgan Lee'] },
        { name: 'phone_number', values: ['+15125550701'] },
        { name: 'broken', values: [] },
      ],
      consents: [
        { key: 'texts', checked: true },
        { key: 'calls', checked: false },
      ],
    });
    expect(() => leadOf({ field_data: [] })).toThrow();
  });

  it('reads a lead form’s questions and its own tick boxes', () => {
    const form = leadFormOf({
      id: '7001',
      name: 'Meet the team',
      status: 'ACTIVE',
      questions: [{ key: 'what_brings_you_here?', label: 'What brings you here?', type: 'CUSTOM' }],
      legal_content: {
        custom_disclaimer: {
          checkboxes: [{ key: 'texts', text: 'Text me about this', is_required: false }],
        },
      },
    });
    expect(form).toEqual({
      id: '7001',
      name: 'Meet the team',
      status: 'ACTIVE',
      questions: [{ key: 'what_brings_you_here?', label: 'What brings you here?' }],
      consentBoxes: [{ key: 'texts', text: 'Text me about this' }],
    });
  });

  it('cuts a lead out of a Page webhook, and leaves the rest', () => {
    const split = splitLeadgen({
      object: 'page',
      entry: [
        {
          id: '1000',
          changes: [
            { field: 'leadgen', value: { leadgen_id: '9001', page_id: '1000', form_id: '7001' } },
            { field: 'feed', value: { item: 'comment' } },
            { field: 'leadgen', value: { leadgen_id: 'not-a-lead', page_id: '1000' } },
          ],
        },
      ],
    });
    expect(split).toEqual([
      {
        pageId: '1000',
        leadgenId: '9001',
        formId: '7001',
        adId: null,
        dedupeKey: 'leadgen:9001',
      },
    ]);
    expect(splitLeadgen({ object: 'instagram', entry: [] })).toEqual([]);
  });
});
