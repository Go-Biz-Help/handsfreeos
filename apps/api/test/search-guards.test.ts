/**
 * Search's guards on the API (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 6 and 7), the wiring only:
 * both search routes carry their own rate limit, per person, 90 and 60 a minute, each counted on its own and refused
 * with `search_too_fast`; a search that can't get one of the machine's slots is refused `search_busy` while other
 * routes never wait; the invitations' own limit still answers as it did; both queries are in the OpenAPI export; and
 * when a search fails, neither the answer nor the API's error log holds what was typed.
 */
import type { Db, DbHandle } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { searchSlots } from '../src/search-slots';
import { apiEnv, testApp } from './helpers';

let app: Awaited<ReturnType<typeof testApp>>;
let dana: TestUser, sam: TestUser;
let danaToken: string, samToken: string;
let workspaceId: string;

const post = (
  a: Awaited<ReturnType<typeof testApp>>,
  url: string,
  body: Record<string, unknown>,
  token: string,
) =>
  a.inject({ method: 'POST', url, payload: body, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  app = await testApp();
  [dana, sam] = await Promise.all([
    createTestUser('search-guard-dana'),
    createTestUser('search-guard-sam'),
  ]);
  [danaToken, samToken] = await Promise.all([signInTestUser(dana), signInTestUser(sam)]);
  const made = await post(
    app,
    '/v1/commands/organization.create',
    { businessName: 'Search Guard Plumbing' },
    danaToken,
  );
  expect(made.statusCode).toBe(200);
  ({ workspaceId } = made.json());
});
afterAll(async () => {
  await app.close();
  await closeTestDbs();
});

describe('search’s rate limits', () => {
  it('refuses the 91st search in a minute from one person with search_too_fast, and nobody else', async () => {
    // One letter is too short to run anything, so these cost no searching.
    for (let i = 0; i < 90; i++) {
      const res = await post(
        app,
        '/v1/queries/search.everything',
        { workspaceId, q: 'd' },
        danaToken,
      );
      expect(res.statusCode, `search ${i + 1}`).toBe(200);
    }
    const refused = await post(
      app,
      '/v1/queries/search.everything',
      { workspaceId, q: 'd' },
      danaToken,
    );
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toMatchObject({ rule: 'search_too_fast', disposition: 'retry' });
    expect(refused.json().error.message).toMatch(/faster than HandsFreeOS can keep up/);
    // Sam isn't in the business, so his search is refused, but by the kernel, not the limit.
    const other = await post(
      app,
      '/v1/queries/search.everything',
      { workspaceId, q: 'd' },
      samToken,
    );
    expect(other.statusCode).not.toBe(429);
    // search.kind has its own count.
    const kind = await post(
      app,
      '/v1/queries/search.kind',
      { workspaceId, q: 'd', kind: 'contacts' },
      danaToken,
    );
    expect(kind.statusCode).toBe(200);
  });

  it('refuses the 61st search.kind in a minute from one person, and leaves their search.everything answering', async () => {
    const kim = await createTestUser('search-guard-kim');
    const kimToken = await signInTestUser(kim);
    const made = await post(
      app,
      '/v1/commands/organization.create',
      { businessName: 'Search Guard Heating' },
      kimToken,
    );
    expect(made.statusCode).toBe(200);
    const kimWorkspace = made.json().workspaceId as string;
    for (let i = 0; i < 60; i++) {
      const res = await post(
        app,
        '/v1/queries/search.kind',
        { workspaceId: kimWorkspace, q: 'd', kind: 'contacts' },
        kimToken,
      );
      expect(res.statusCode, `search.kind ${i + 1}`).toBe(200);
    }
    const refused = await post(
      app,
      '/v1/queries/search.kind',
      { workspaceId: kimWorkspace, q: 'd', kind: 'contacts' },
      kimToken,
    );
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toMatchObject({ rule: 'search_too_fast', disposition: 'retry' });
    const everything = await post(
      app,
      '/v1/queries/search.everything',
      { workspaceId: kimWorkspace, q: 'd' },
      kimToken,
    );
    expect(everything.statusCode).toBe(200);
  });

  it('leaves the invitations’ own limit answering as it did', async () => {
    let last: Awaited<ReturnType<typeof post>> | null = null;
    for (let i = 0; i < 12; i++)
      last = await post(
        app,
        '/v1/commands/invitation.accept',
        { token: 'tok_0000000000000000000000' },
        samToken,
      );
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many attempts. Try again in a minute.',
        disposition: 'retry',
      },
    });
  });
});

describe('the slot gate', () => {
  it('refuses a search with search_busy when no slot comes free, and never holds other routes', async () => {
    // Warmed first, so its own time is only its own.
    await post(app, '/v1/queries/pipeline.list', { workspaceId }, danaToken);
    const held = await Promise.all([1, 2, 3].map(() => searchSlots.acquireSlot(5_000)));
    try {
      const done: string[] = [];
      const started = Date.now();
      const busy = post(
        app,
        '/v1/queries/search.kind',
        { workspaceId, q: 'dana', kind: 'contacts' },
        danaToken,
      ).then((r) => (done.push('search'), r));
      const quick = await post(app, '/v1/queries/pipeline.list', { workspaceId }, danaToken);
      done.push('other');
      expect(quick.statusCode).toBe(200);
      const refused = await busy;
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error).toMatchObject({ rule: 'search_busy', disposition: 'retry' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      expect(done).toEqual(['other', 'search']);
    } finally {
      held.forEach((release) => release?.());
    }
    expect(searchSlots.held).toBe(0);
    const free = await post(
      app,
      '/v1/queries/search.kind',
      { workspaceId, q: 'dana', kind: 'contacts' },
      danaToken,
    );
    expect(free.statusCode).toBe(200);
    expect(searchSlots.held).toBe(0);
  });
});

describe('the OpenAPI export', () => {
  it('has both search queries', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const paths = Object.keys(res.json().paths);
    expect(paths).toEqual(
      expect.arrayContaining(['/v1/queries/search.everything', '/v1/queries/search.kind']),
    );
  });
});

/** Whether any text in a statement holds `marker`: what was typed reaches a statement only as its parameters. */
function holds(chunk: unknown, marker: string): boolean {
  if (typeof chunk === 'string') return chunk.includes(marker);
  if (Array.isArray(chunk)) return chunk.some((c) => holds(c, marker));
  if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk)
    return holds((chunk as { queryChunks: unknown }).queryChunks, marker);
  return false;
}

/**
 * The database, failing every statement that carries `marker` the way Drizzle fails one: its message holds the
 * statement and its parameters, and its cause the SQLSTATE.
 */
function failingOn(real: Db, marker: string): Db {
  const wrap = <T extends object>(tx: T): T =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === 'execute')
          return async (query: unknown) => {
            if (holds(query, marker))
              throw new Error(`Failed query: select … like all ($1)\nparams: %${marker}%`, {
                cause: Object.assign(new Error(`relation "nope" does not exist (${marker})`), {
                  code: '42P01',
                }),
              });
            return (value as (q: unknown) => Promise<unknown>).call(target, query);
          };
        if (prop === 'transaction')
          return (fn: (tx: unknown) => Promise<unknown>, config?: unknown) =>
            (value as (f: (tx: object) => Promise<unknown>, c?: unknown) => Promise<unknown>).call(
              target,
              (inner: object) => fn(wrap(inner)),
              config,
            );
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return wrap(real);
}

describe('when a search fails', () => {
  it('answers 500 with nothing typed in the answer or the error log', async () => {
    const marker = 'zqmarkerdana';
    const logs: string[] = [];
    const real = testDbs().api;
    const handle: DbHandle = {
      db: failingOn(real.db, marker),
      client: real.client,
      close: async () => {},
    };
    const failing = await buildApp({
      env: apiEnv(),
      db: handle,
      logger: { level: 'info', stream: { write: (line: string) => logs.push(line) } },
    });
    try {
      const res = await post(
        failing,
        '/v1/queries/search.everything',
        { workspaceId, q: `${marker} smith` },
        danaToken,
      );
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(marker);
      const errors = logs.filter((l) => l.includes('"level":50'));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join('\n')).toContain('search contacts failed: 42P01');
      expect(logs.join('\n')).not.toContain(marker);
    } finally {
      await failing.close();
    }
  });
});
