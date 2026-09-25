import { createScreenTracker, screenOf } from '../analytics';

const fields = (body: string) => Object.fromEntries(new URLSearchParams(body));

function tracker() {
  const sent: Record<string, string>[] = [];
  let now = 0;
  const t = createScreenTracker({
    siteId: '4',
    visitorId: () => '0123456789abcdef',
    phone: () => ({ ua: 'test', res: '1170x2532', lang: 'en-US' }),
    post: async (body) => void sent.push(fields(body)),
    now: () => now,
  });
  return { t, sent, later: (ms: number) => void (now += ms) };
}

describe('analytics', () => {
  it('names a screen by its route, never by what is on it', () => {
    expect(screenOf(['app', 'w', '[workspaceId]', '(tabs)', 'inbox'])).toBe('/app/w/:id/inbox');
    expect(screenOf(['app', 'w', '[workspaceId]', 'customers', 'people', '[personId]'])).toBe(
      '/app/w/:id/customers/people/:id',
    );
    expect(screenOf(['(auth)', 'sign-in'])).toBe('/sign-in');
    expect(screenOf(['app', 'w', '[workspaceId]', '(tabs)', '(more)', 'settings', 'index'])).toBe(
      '/app/w/:id/settings',
    );
    expect(screenOf([])).toBe('');
  });

  it('counts each screen once, with the one before it as the referrer', () => {
    const { t, sent } = tracker();
    t.screen('/app/w/:id/inbox');
    t.screen('/app/w/:id/inbox');
    t.screen('/app/w/:id/inbox/:id');
    t.screen('');

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      idsite: '4',
      rec: '1',
      url: 'https://com.gobizhelp.handsfreeos/app/w/:id/inbox',
      action_name: '/app/w/:id/inbox',
      _id: '0123456789abcdef',
      lang: 'en-US',
    });
    expect(sent[0]).not.toHaveProperty('urlref');
    expect(sent[1]).toMatchObject({
      url: 'https://com.gobizhelp.handsfreeos/app/w/:id/inbox/:id',
      urlref: 'https://com.gobizhelp.handsfreeos/app/w/:id/inbox',
    });
  });

  it('counts the screen again only when the app comes back after the visit has closed', () => {
    const { t, sent, later } = tracker();
    t.resume();
    expect(sent).toHaveLength(0);

    t.screen('/app/w/:id/pipeline');
    later(5 * 60 * 1000);
    t.resume();
    expect(sent).toHaveLength(1);

    later(30 * 60 * 1000);
    t.resume();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ action_name: '/app/w/:id/pipeline' });
  });

  it('never lets a failed send reach the screen', async () => {
    const t = createScreenTracker({
      siteId: '4',
      visitorId: () => '0123456789abcdef',
      phone: () => ({}),
      post: () => Promise.reject(new Error('no signal')),
      now: () => 0,
    });
    expect(() => t.screen('/app')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
