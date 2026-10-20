/**
 * Search's limits and its guard on every statement (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 6 and
 * 7), on the local database, with test-only searchers passed through `runSearch`'s `searchers` option:
 *
 *   - "%" and "_" match only themselves; more than 120 characters is a validation error; too short runs nothing.
 *   - A statement past its timeout marks only its kind, the Archived page included; a spent budget skips the rest,
 *     and a timeout is never set to 0 (no limit at all) or under 50 ms; every kind too slow refuses
 *     `search_took_too_long`, retried. The winners' facts are read after every kind's candidates.
 *   - Nothing is written.
 *   - A failure anywhere — a kind, the facts of its winners, close matches, a kind's own page — leaves the answer
 *     standing with the group marked, or refuses with a rule, or throws an error holding only where it failed and
 *     its SQLSTATE: never what was typed.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HfosError } from '../../src/errors';
import type { SearchEverythingOutput, SearchKindOutput } from '../../src/schemas/search';
import { contactsSearcher } from '../../src/search/server/kinds/contacts';
import { companiesSearcher } from '../../src/search/server/kinds/companies';
import { closeSearcher } from '../../src/search/server/kinds/close';
import { formsSearcher } from '../../src/search/server/kinds/forms';
import { messagesSearcher } from '../../src/search/server/kinds/messages';
import { notesSearcher } from '../../src/search/server/kinds/notes';
import { unavailableLine } from '../../src/search/dropdown';
import { hitOf } from '../../src/search/server/hit';
import {
  MIN_STATEMENT_MS,
  SearchFailed,
  type KindSearcher,
  type RunOptions,
} from '../../src/search/server/run';
import {
  admin,
  everything,
  expectHfos,
  groupOf,
  runAs,
  searchWorld,
  titles,
  type World,
} from './helpers';

let w: World;
beforeAll(async () => {
  w = await searchWorld('search-limits');
  await rows(
    admin(),
    sql`insert into app.people (workspace_id, first_name, last_name) values
        (${w.wsId}, 'Promo', '50%_off'), (${w.wsId}, 'Promo', '50xxoff'), (${w.wsId}, 'Promo', '50aoff')`,
  );
});
afterAll(closeTestDbs);

const SECRET = 'zqtypedwords';

const everythingAs = (q: string, opts: RunOptions, more: Record<string, unknown> = {}) =>
  runAs(w, w.owner, { workspaceId: w.wsId, q, ...more }, opts) as Promise<SearchEverythingOutput>;
const kindAs = (q: string, kind: string, opts: RunOptions) =>
  runAs(w, w.owner, { workspaceId: w.wsId, q, kind }, opts) as Promise<SearchKindOutput>;

/** A searcher standing in for a kind, its statements written by the test. */
const fake = (
  key: string,
  find: KindSearcher['find'],
  facts?: KindSearcher['facts'],
): KindSearcher => ({ key, find, ...(facts ? { facts } : {}) });

/** One plain hit, for a fake searcher to find. */
const aHit = (kind: string) =>
  hitOf({
    kind,
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Found',
    href: '/',
    tier: 1,
  });

/** Nothing of what was typed anywhere in an error: its message, its stack, its cause. */
function holdsNothingTyped(e: unknown, typed: string) {
  expect(e).toBeInstanceOf(Error);
  const err = e as Error;
  expect(err.message).not.toContain(typed);
  expect(err.stack ?? '').not.toContain(typed);
  expect(err.cause).toBeUndefined();
  expect(JSON.stringify(err)).not.toContain(typed);
}

/** An answer as text, past the search it echoes back to the person who typed it. */
const nothingButQ = (a: SearchEverythingOutput) => JSON.stringify({ ...a, q: '' });

async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected it to throw');
}

describe('what is typed', () => {
  it('matches "%" and "_" only as themselves', async () => {
    const a = await everything(w, w.owner, '50%_off');
    expect(titles(groupOf(a, 'contacts'))).toEqual(['Promo 50%_off']);
  });

  it('refuses more than 120 characters with the input’s own words', async () => {
    const e = await expectHfos(() => everything(w, w.owner, 'x'.repeat(121)), 'validation', 400);
    expect(JSON.stringify(e.details)).toContain('Keep a search to 120 characters.');
  });

  it('runs nothing at all for one character, "--", "@@" or a lone "1"', async () => {
    let statements = 0;
    let finds = 0;
    const counting = fake('contacts', async () => {
      finds++;
      return [];
    });
    for (const q of ['d', '--', '@@', '1']) {
      const a = await everythingAs(q, { searchers: [counting], onStatement: () => statements++ });
      expect(a.tooShort, q).toBe(true);
      expect(a.groups, q).toEqual([]);
    }
    expect(statements).toBe(0);
    expect(finds).toBe(0);
  });

  it('finds no contact for "12", though their phone holds it, with no word or digit arm', async () => {
    await rows(
      admin(),
      sql`insert into app.people (workspace_id, first_name, last_name, phone_e164)
          values (${w.wsId}, 'Twelve', 'Phone', '+15045551212')`,
    );
    let seen: { likes: readonly string[]; digits: string | null } | null = null;
    const seeing = fake('contacts', async (_db, plan) => {
      seen = { likes: plan.p.likes, digits: plan.p.digits };
      return [];
    });
    await everythingAs('12', { searchers: [seeing] });
    expect(seen).toEqual({ likes: [], digits: null });
    expect(groupOf(await everything(w, w.owner, '12'), 'contacts')).toBeUndefined();
    expect(titles(groupOf(await everything(w, w.owner, '1212'), 'contacts'))).toEqual([
      'Twelve Phone',
    ]);
  });
});

describe('the budget', () => {
  it('marks only the kind whose statement ran out of time', async () => {
    const slow = fake('contacts', async (db) => {
      await db.rows(sql`select pg_sleep(2)`);
      return [];
    });
    const a = await everythingAs('smith', {
      searchers: [slow, companiesSearcher],
      budget: { requestMs: 4_000, statementMs: 200 },
    });
    expect(groupOf(a, 'contacts')).toMatchObject({ unavailable: 'too_slow', items: [] });
    expect(titles(groupOf(a, 'companies'))).toEqual(['Smithfield Property Mgmt']);
  });

  it('skips the next kind with too little budget left, and never sets a timeout under 50 ms', async () => {
    const timeouts: number[] = [];
    const lingering = fake('contacts', async (db) => {
      await db.rows(sql`select 1`);
      await new Promise((r) => setTimeout(r, 270));
      return [{ kind: 'contacts', label: null, icon: null, hits: [aHit('contacts')] }];
    });
    const a = await everythingAs('smith', {
      searchers: [lingering, companiesSearcher],
      budget: { requestMs: 300, statementMs: 1_000 },
      onStatement: (_kind, ms) => timeouts.push(ms),
    });
    expect(groupOf(a, 'companies')).toMatchObject({ unavailable: 'skipped' });
    expect(titles(groupOf(a, 'contacts'))).toEqual(['Found']);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((ms) => ms >= MIN_STATEMENT_MS)).toBe(true);
  });

  it('marks the business’s own kinds together when they run out of time, in the records’ place', async () => {
    const slow = fake('records', async (db) => {
      await db.rows(sql`select pg_sleep(2)`);
      return [];
    });
    const a = await everythingAs('smith', {
      searchers: [companiesSearcher, slow],
      budget: { requestMs: 4_000, statementMs: 200 },
    });
    expect(groupOf(a, 'records')).toMatchObject({
      label: null,
      unavailable: 'too_slow',
      items: [],
    });
    expect(unavailableLine(groupOf(a, 'records')!)).toBe(
      'Your own kinds of records took too long to search. Try again.',
    );
  });

  it('reads the winners’ facts after every kind’s candidates', async () => {
    const order: string[] = [];
    const kind = (key: string) =>
      fake(
        key,
        async (db) => {
          await db.rows(sql`select 1`);
          order.push(`find ${key}`);
          return [{ kind: key, label: null, icon: null, hits: [aHit(key)] }];
        },
        async (db, _plan, hits) => {
          await db.rows(sql`select 1`);
          order.push(`facts ${key}`);
          return [...hits];
        },
      );
    await everythingAs('smith', { searchers: [kind('contacts'), kind('companies')] });
    expect(order).toEqual(['find contacts', 'find companies', 'facts contacts', 'facts companies']);
  });

  it('marks the Archived page when one of its kinds ran out of time', async () => {
    const slow = fake('contacts', async (db) => {
      await db.rows(sql`select pg_sleep(2)`);
      return [];
    });
    const page = await kindAs('becnel', 'archived', {
      searchers: [slow, companiesSearcher],
      budget: { requestMs: 4_000, statementMs: 200 },
    });
    expect(page.group).toMatchObject({
      kind: 'archived',
      unavailable: 'too_slow',
      complete: false,
    });
  });

  it('refuses search_took_too_long, to be retried, when every kind was too slow', async () => {
    const slow = (key: string) =>
      fake(key, async (db) => {
        await db.rows(sql`select pg_sleep(2)`);
        return [];
      });
    const e = await thrown(() =>
      everythingAs('smith', {
        searchers: [slow('contacts'), slow('companies')],
        budget: { requestMs: 3_000, statementMs: 100 },
      }),
    );
    expect(e).toBeInstanceOf(HfosError);
    expect(e).toMatchObject({ rule: 'search_took_too_long', status: 503, disposition: 'retry' });
    const kind = await thrown(() =>
      kindAs('smith', 'contacts', {
        searchers: [slow('contacts')],
        budget: { requestMs: 3_000, statementMs: 100 },
      }),
    );
    expect(kind).toMatchObject({ rule: 'search_took_too_long', status: 503 });
  });
});

describe('nothing written', () => {
  it('leaves no event, outbox or audit row behind', async () => {
    const count = async () =>
      (
        await rows<{ n: number }>(
          admin(),
          sql`select (select count(*) from app.events where workspace_id = ${w.wsId})
                   + (select count(*) from app.outbox where workspace_id = ${w.wsId})
                   + (select count(*) from app.audit_logs where workspace_id = ${w.wsId}) as n`,
        )
      )[0]!.n;
    const before = Number(await count());
    await everything(w, w.owner, 'smith');
    await everything(w, w.owner, 'dnaa smtih');
    await everything(w, w.owner, '$1,280');
    expect(Number(await count())).toBe(before);
  });
});

describe('a failure never carries what was typed', () => {
  const broken = (key: string) =>
    fake(key, async (db, plan) => {
      await db.rows(sql`select * from app.no_such_table where name like ${plan.p.likes[0]!}`);
      return [];
    });

  it('in a kind: thrown again with only the kind and its SQLSTATE', async () => {
    const e = await thrown(() =>
      everythingAs(`${SECRET} smith`, { searchers: [broken('contacts')] }),
    );
    expect(e).toBeInstanceOf(SearchFailed);
    expect((e as Error).message).toBe('search contacts failed: 42P01');
    holdsNothingTyped(e, SECRET);
  });

  it('in a kind, stopped for time: the group marked, the answer standing', async () => {
    const slow = fake('contacts', async (db, plan) => {
      await db.rows(sql`select pg_sleep(2), ${plan.p.likes[0]!}::text`);
      return [];
    });
    const a = await everythingAs(`${SECRET} smith`, {
      searchers: [slow, companiesSearcher],
      budget: { requestMs: 3_000, statementMs: 100 },
    });
    expect(groupOf(a, 'contacts')?.unavailable).toBe('too_slow');
    expect(nothingButQ(a)).not.toContain(SECRET);
  });

  it('in the facts of the winners: the hits kept, the group marked failed or too slow', async () => {
    for (const [failing, mark] of [
      [(typed: string) => sql`select * from app.no_such_table where name = ${typed}`, 'failed'],
      [(typed: string) => sql`select pg_sleep(2), ${typed}::text`, 'too_slow'],
    ] as const) {
      const snippets = fake(
        'contacts',
        async () => [{ kind: 'contacts', label: null, icon: null, hits: [aHit('contacts')] }],
        async (db, plan) => {
          await db.rows(failing(plan.p.likes[0]!));
          return [];
        },
      );
      const a = await everythingAs(`${SECRET} smith`, {
        searchers: [snippets],
        budget: { requestMs: 3_000, statementMs: 200 },
      });
      expect(groupOf(a, 'contacts'), mark).toMatchObject({
        unavailable: mark,
        items: [{ title: 'Found' }],
      });
      expect(nothingButQ(a)).not.toContain(SECRET);
    }
  });

  it('in close matches: thrown again scrubbed, or left out when too slow', async () => {
    const nothing = fake('contacts', async () => []);
    const e = await thrown(() =>
      everythingAs(`${SECRET}x smtih`, { searchers: [nothing, broken('close')] }),
    );
    expect((e as Error).message).toBe('search close failed: 42P01');
    holdsNothingTyped(e, SECRET);
    const slowClose = fake('close', async (db) => {
      await db.rows(sql`select pg_sleep(2)`);
      return [];
    });
    const a = await everythingAs(`${SECRET}x smtih`, {
      searchers: [contactsSearcher, slowClose],
      budget: { requestMs: 3_000, statementMs: 100 },
    });
    expect(a).toMatchObject({ close: false, groups: [] });
  });

  it('on a kind’s own page: thrown again scrubbed', async () => {
    const e = await thrown(() =>
      kindAs(`${SECRET} smith`, 'contacts', { searchers: [broken('contacts')] }),
    );
    expect((e as Error).message).toBe('search contacts failed: 42P01');
    holdsNothingTyped(e, SECRET);
  });

  it('and the real searchers answer through the same guard', async () => {
    const a = await everythingAs('dnaa smtih', { searchers: [contactsSearcher, closeSearcher] });
    expect(a.close).toBe(true);
  });

  it('the windowed kinds too: every statement through a step, skipped with no budget left', async () => {
    const windowed = [messagesSearcher, notesSearcher, formsSearcher];
    const timeouts: number[] = [];
    const a = await everythingAs(`${SECRET} smith`, {
      searchers: windowed,
      onStatement: (_kind, ms) => timeouts.push(ms),
    });
    expect(nothingButQ(a)).not.toContain(SECRET);
    // Threads, messages and calls; notes; forms by name and their answers: one step each.
    expect(timeouts).toHaveLength(6);
    const e = await thrown(() =>
      everythingAs('smith', { searchers: windowed, budget: { requestMs: 30, statementMs: 1_000 } }),
    );
    expect(e).toMatchObject({ rule: 'search_took_too_long', status: 503 });
  });
});
