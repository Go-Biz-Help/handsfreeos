/**
 * Reading GoHighLevel a page at a time, against a stand-in that answers the way the real one does.
 *
 * The first real account had 856 customers and the import counted to 7,700 before somebody paused it. The
 * contacts list pages by a pair — the last id and its `dateAdded` in epoch milliseconds — and given the id
 * alone, GoHighLevel hands back the first page again. The adapter was working the time out with `Number()`
 * on an ISO date, which is NaN, so it never sent one. Every category that hangs off customers then waited
 * on a category that never finished, which is why the invoices never came.
 *
 * No database: the adapter is the only thing under test, and `fetch` is the stand-in.
 */
import type { SourceConnection, SourceScope } from '@hfos/core/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoHighLevelAdapter } from '../src/migrations/adapters/gohighlevel';

const adapter = createGoHighLevelAdapter({ clientId: '', clientSecret: '', configured: false });

const connection: SourceConnection = {
  id: 'conn_1',
  system: 'gohighlevel',
  installKind: 'location',
  authKind: 'private_token',
  externalAccountId: 'loc_1',
  scopes: [],
  accessToken: 'pit-not-a-real-token',
  refreshToken: null,
  expiresAt: null,
};
const scope: SourceScope = { externalScopeId: 'loc_1', name: 'One business' };

/** The i-th customer, added a second after the one before, the way an export is ordered. */
const addedAt = (i: number) => Date.UTC(2020, 0, 1) + i * 1000;
const customer = (i: number) => ({
  id: `con_${i}`,
  firstName: `Customer ${i}`,
  dateAdded: new Date(addedAt(i)).toISOString(),
});

/** Every request the adapter made, and one answer for each. */
function serve(answer: (url: URL) => unknown): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      return new Response(JSON.stringify(answer(url)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

/**
 * GoHighLevel's contacts list, as it behaves: `startAfterId` and `startAfter` together page; the id on its
 * own is ignored and the first page comes back.
 */
function contactsLike(total: number) {
  return (url: URL): unknown => {
    if (url.pathname.startsWith('/contacts/') && url.pathname.length > '/contacts/'.length) {
      const id = decodeURIComponent(url.pathname.slice('/contacts/'.length));
      const i = Number(id.replace('con_', ''));
      return { contact: customer(i) };
    }
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const afterId = url.searchParams.get('startAfterId');
    const after = url.searchParams.get('startAfter');
    const from = afterId && after ? Number(afterId.replace('con_', '')) + 1 : 0;
    const contacts = Array.from({ length: Math.max(0, Math.min(limit, total - from)) }, (_, k) =>
      customer(from + k),
    );
    const last = contacts[contacts.length - 1];
    return {
      contacts,
      meta: {
        total,
        startAfterId: last?.id ?? null,
        startAfter: last ? addedAt(from + contacts.length - 1) : null,
      },
    };
  };
}

async function readAll(category: string, cursor: Record<string, unknown> | null = null) {
  const ids: string[] = [];
  let pages = 0;
  for (;;) {
    const page = await adapter.list(connection, scope, category, { cursor, limit: 100 });
    pages += 1;
    ids.push(...page.records.map((r) => r.objectId));
    if (page.done || !page.cursor) return { ids, pages };
    cursor = page.cursor;
    if (pages > 50) throw new Error('never finished');
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading GoHighLevel page by page', () => {
  it('pages customers by the id and the time GoHighLevel pairs it with, and stops at its total', async () => {
    const calls = serve(contactsLike(250));
    const { ids, pages } = await readAll('contacts');
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
    // Three pages of a hundred, the last of them half full; the total says that is all.
    expect(pages).toBe(3);
    const second = calls[1]!;
    expect(second.searchParams.get('startAfterId')).toBe('con_99');
    expect(second.searchParams.get('startAfter')).toBe(String(addedAt(99)));
  });

  it('puts a walk saved with the id alone back where it stopped', async () => {
    // A checkpoint from before the fix: the id of the last customer read, and no time beside it.
    const calls = serve(contactsLike(150));
    const { ids } = await readAll('contacts', { startAfterId: 'con_99' });
    expect(ids).toEqual(Array.from({ length: 50 }, (_, k) => `con_${100 + k}`));
    // The time was asked for once, and the list was then asked for with the pair.
    expect(calls[0]!.pathname).toBe('/contacts/con_99');
    expect(calls[1]!.searchParams.get('startAfter')).toBe(String(addedAt(99)));
  });

  it('stops rather than counting the same page forever when the source ignores where it was asked to start', async () => {
    // A source that answers every request with its first page and never says how many there are.
    serve(() => ({ contacts: Array.from({ length: 100 }, (_, k) => customer(k)) }));
    const first = await adapter.list(connection, scope, 'contacts', { cursor: null, limit: 100 });
    expect(first.done).toBe(false);
    await expect(
      adapter.list(connection, scope, 'contacts', { cursor: first.cursor, limit: 100 }),
    ).rejects.toThrow(/same page/);
  });

  it('counts customers from the total the answer carries, not the one record it asked for', async () => {
    serve((url) => (url.pathname === '/contacts/' ? contactsLike(856)(url) : {}));
    const seen: { category: string; count: number; countQuality: string }[] = [];
    for await (const r of adapter.scan(connection, scope)) seen.push(r);
    const contacts = seen.find((r) => r.category === 'contacts');
    expect(contacts?.count).toBe(856);
    expect(contacts?.countQuality).toBe('complete');
  });

  it('pages conversations by the last message date and stops at the total', async () => {
    const total = 150;
    const lastMessageAt = (i: number) => Date.UTC(2024, 0, 1) - i * 60_000;
    const calls = serve((url) => {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const before = url.searchParams.get('startAfterDate');
      const from = before ? Math.round((Date.UTC(2024, 0, 1) - Number(before)) / 60_000) + 1 : 0;
      const conversations = Array.from(
        { length: Math.max(0, Math.min(limit, total - from)) },
        (_, k) => ({ id: `cnv_${from + k}`, lastMessageDate: lastMessageAt(from + k) }),
      );
      return { conversations, total };
    });
    const { ids, pages } = await readAll('conversations');
    expect(ids).toHaveLength(150);
    expect(new Set(ids).size).toBe(150);
    expect(pages).toBe(2);
    expect(calls[1]!.searchParams.get('startAfterDate')).toBe(String(lastMessageAt(99)));
  });
});
