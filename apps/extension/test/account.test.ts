/**
 * Who's signed in and where they save, and how often HandsFreeOS is asked (src/hfos/session.ts, 0.152.0): every ten
 * minutes for the background's own work; within the minute for the panel, and while there's nowhere to save; and at
 * the next look after a call refused in a way that says the person's businesses may have changed. Supabase Auth,
 * HandsFreeOS and the extension's storage are stood in for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/hfos/config', () => ({
  config: {
    apiUrl: 'https://api.example.test',
    workerUrl: '',
    webUrl: 'https://app.example.test',
    supabaseUrl: 'https://auth.example.test',
    supabasePublishableKey: 'publishable',
  },
  canSignIn: () => true,
}));
vi.mock('@supabase/auth-js', () => ({
  GoTrueClient: class {
    getSession = async () => ({
      data: { session: { access_token: 'token', user: { id: 'u-dana' } } },
      error: null,
    });
    signOut = async () => ({ error: null });
  },
  isAuthError: () => false,
  isAuthRetryableFetchError: () => false,
}));

/** What HandsFreeOS was asked, and what it answers. */
const posted: string[] = [];
let answers: Record<string, { readonly status: number; readonly body: unknown }> = {};
vi.mock('@hfos/api-client', async (original) => ({
  // Its own way of telling an error's body, kept: only the client is stood in for.
  ...(await original<Record<string, unknown>>()),
  createApiClient: () => ({
    use: () => undefined,
    POST: async (path: string) => {
      posted.push(path);
      const answer = answers[path] ?? { status: 503, body: undefined };
      const ok = answer.status < 400;
      return {
        data: ok ? answer.body : undefined,
        error: ok ? undefined : answer.body,
        response: { ok, status: answer.status },
      };
    },
  }),
}));

const ME = '/v1/queries/account.me';
const LIVE = '/v1/queries/outreach.live';
const business = (id: string, name: string, on = true) => ({
  id,
  name,
  addons: on ? ['outreach'] : [],
  permissions: ['outreach.use'],
});
const me = (workspaces: unknown[]) => ({
  status: 200,
  body: {
    user: { id: 'u-dana', email: 'dana@example.com', fullName: 'Dana Reyes' },
    workspaces,
  },
});
const asked = () => posted.filter((path) => path === ME).length;

const store = new Map<string, unknown>();
const START = Date.UTC(2026, 10, 23, 15);
const MINUTE = 60_000;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(values)) store.set(k, v);
        },
        remove: async (key: string) => void store.delete(key),
      },
    },
    runtime: { getManifest: () => ({ version: '0.152.0' }) },
  });
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A background just woken: it knows nobody yet. */
async function background() {
  vi.resetModules();
  return import('../src/hfos/session');
}

beforeEach(() => {
  store.clear();
  posted.length = 0;
  answers = { [ME]: me([business('b-one', 'Reyes Roofing')]) };
  vi.setSystemTime(START);
});

describe('who’s signed in, for the background’s own work', () => {
  it('asks HandsFreeOS once, then goes by what it said for ten minutes', async () => {
    const { savingTo, ME_FOR_MS } = await background();
    expect(await savingTo()).toEqual({ userId: 'u-dana', businessId: 'b-one' });
    for (const minutes of [1, 5, 9]) {
      vi.setSystemTime(START + minutes * MINUTE);
      expect(await savingTo()).toEqual({ userId: 'u-dana', businessId: 'b-one' });
    }
    expect(asked()).toBe(1);
    vi.setSystemTime(START + ME_FOR_MS + 1_000);
    await savingTo();
    expect(asked()).toBe(2);
  });

  it('asks within the minute while there’s nowhere to save, so a business that turns it on is there', async () => {
    answers[ME] = me([business('b-one', 'Reyes Roofing', false)]);
    const { savingTo } = await background();
    expect(await savingTo()).toBeNull();
    vi.setSystemTime(START + 30_000);
    expect(await savingTo()).toBeNull();
    expect(asked()).toBe(1);
    answers[ME] = me([business('b-one', 'Reyes Roofing')]);
    vi.setSystemTime(START + MINUTE + 1_000);
    expect(await savingTo()).toEqual({ userId: 'u-dana', businessId: 'b-one' });
    expect(asked()).toBe(2);
  });
});

describe('who’s signed in, for the panel', () => {
  it('is never older than a minute, and the background goes by the panel’s look', async () => {
    const { answer, savingTo } = await background();
    await savingTo();
    vi.setSystemTime(START + 30_000);
    await answer({ type: 'hfos-account' });
    expect(asked()).toBe(1);
    answers[ME] = me([business('b-one', 'Reyes Roofing'), business('b-two', 'Reyes Gutters')]);
    vi.setSystemTime(START + MINUTE + 1_000);
    const shown = await answer({ type: 'hfos-account' });
    expect(asked()).toBe(2);
    expect(shown).toMatchObject({
      ok: true,
      value: { businesses: [{ id: 'b-one' }, { id: 'b-two' }], businessId: 'b-one' },
    });
    vi.setSystemTime(START + 9 * MINUTE);
    await savingTo();
    expect(asked()).toBe(2);
  });

  it('asks at once when the panel says to', async () => {
    const { answer } = await background();
    await answer({ type: 'hfos-account' });
    await answer({ type: 'hfos-account', fresh: true });
    expect(asked()).toBe(2);
  });
});

describe('a call HandsFreeOS refused', () => {
  const refusals = [
    [
      'Social Outreach is off there',
      {
        status: 403,
        body: { error: { code: 'forbidden', message: 'Off.', rule: 'addon_inactive' } },
      },
    ],
    [
      'it’s out of the person’s reach',
      {
        status: 403,
        body: { error: { code: 'forbidden', message: 'Ask an owner of this business.' } },
      },
    ],
  ] as const;

  it.each(refusals)(
    'because %s has the next look ask who they are, and where they save follows',
    async (_why, refusal) => {
      const { api, call, savingTo, Refused } = await background();
      await savingTo();
      vi.setSystemTime(START + 2 * MINUTE);
      answers[LIVE] = refusal;
      answers[ME] = me([business('b-one', 'Reyes Roofing', false)]);
      const refused = await call(
        api().POST(LIVE, { body: { workspaceId: 'b-one' } }) as never,
        'b-one',
      ).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(Refused);
      expect((refused as InstanceType<typeof Refused>).problem.recheck).toBe(true);
      expect(asked()).toBe(1);
      expect(await savingTo()).toBeNull();
      expect(asked()).toBe(2);
    },
  );

  it('asks who they are at most once a minute, however many are refused', async () => {
    const { api, call, savingTo } = await background();
    await savingTo();
    answers[LIVE] = refusals[1][1];
    const refuse = () =>
      call(api().POST(LIVE, { body: { workspaceId: 'b-one' } }) as never, 'b-one').catch(
        () => null,
      );
    vi.setSystemTime(START + 2 * MINUTE);
    await refuse();
    await savingTo();
    expect(asked()).toBe(2);
    // Still theirs, HandsFreeOS says: the next refusals within the minute ask nothing more.
    vi.setSystemTime(START + 2 * MINUTE + 20_000);
    await refuse();
    await refuse();
    expect(await savingTo()).toEqual({ userId: 'u-dana', businessId: 'b-one' });
    expect(asked()).toBe(2);
  });

  it('for another reason asks nothing: a look that found nothing isn’t a business gone', async () => {
    const { api, call, savingTo } = await background();
    await savingTo();
    vi.setSystemTime(START + 2 * MINUTE);
    answers[LIVE] = {
      status: 409,
      body: { error: { code: 'conflict', message: 'Try again.', rule: 'busy' } },
    };
    await call(api().POST(LIVE, { body: { workspaceId: 'b-one' } }) as never, 'b-one').catch(
      () => null,
    );
    await savingTo();
    expect(asked()).toBe(1);
  });
});
