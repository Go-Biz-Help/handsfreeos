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
import {
  createGoHighLevelAdapter,
  htmlToText,
  nameCase,
} from '../src/migrations/adapters/gohighlevel';
import { linkExpiry } from '../src/migrations/engine/media';

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
      const body = answer(url);
      // An answer that is not a 200 is given whole.
      if (body instanceof Response) return body;
      // A string is a page, not JSON: a template's rendered copy.
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
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

  it('pages forms by `skip`, which is the only word that list takes for it', async () => {
    const total = 130;
    const calls = serve((url) => {
      if (url.pathname === '/forms/submissions') return { submissions: [], meta: { total: 0 } };
      // What the real one answers to `offset`.
      if (url.searchParams.has('offset'))
        return { statusCode: 422, message: ['property offset should not exist'] };
      const skip = Number(url.searchParams.get('skip') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const forms = Array.from({ length: Math.max(0, Math.min(limit, total - skip)) }, (_, k) => ({
        id: `form_${skip + k}`,
        name: `Form ${skip + k}`,
      }));
      return { forms, total };
    });
    const { ids } = await readAll('forms');
    expect(ids).toHaveLength(130);
    expect(new Set(ids).size).toBe(130);
    expect(calls.some((c) => c.searchParams.has('offset'))).toBe(false);
  });

  it('reads a total given as `[{ total }]`, the way products and the email builder give it', async () => {
    serve((url) =>
      url.pathname === '/products/'
        ? { products: [{ _id: 'prod_1', name: 'SEO 500' }], total: [{ total: 26 }] }
        : {},
    );
    const seen: { category: string; count: number; countQuality: string }[] = [];
    for await (const r of adapter.scan(connection, scope)) seen.push(r);
    const products = seen.find((r) => r.category === 'products');
    expect(products?.count).toBe(26);
    expect(products?.countQuality).toBe('complete');
  });

  it('waits out a 429 and asks again rather than failing the batch', async () => {
    let refused = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (refused < 2) {
          refused += 1;
          return new Response('{}', { status: 429, headers: { 'retry-after': '0.01' } });
        }
        return new Response(JSON.stringify({ tags: [{ id: 'tag_1', name: 'vip' }] }), {
          status: 200,
        });
      }),
    );
    const page = await adapter.list(connection, scope, 'tags', { cursor: null, limit: 100 });
    expect(page.records.map((r) => r.objectId)).toEqual(['tag_1']);
    expect(refused).toBe(2);
  });

  it('brings an email template with the words from its rendered copy, and leaves folders out', async () => {
    const preview =
      'https://firebasestorage.googleapis.com/v0/b/highlevel-backend.appspot.com/o/t.html?alt=media';
    serve((url) =>
      url.hostname === 'firebasestorage.googleapis.com'
        ? '<html><head><style>p{}</style></head><body><p>Hi {{contact.first_name}},</p>' +
          '<p>Thanks &amp; see you soon.</p></body></html>'
        : {
            builders: [
              { id: 'tpl_1', name: 'Welcome', templateType: 'builder', previewUrl: preview },
              { id: 'tpl_2', name: 'Saved things', templateType: 'folder' },
            ],
            total: [{ total: 2 }],
          },
    );
    const page = await adapter.list(connection, scope, 'templates', { cursor: null, limit: 100 });
    expect(page.records.map((r) => r.objectId)).toEqual(['tpl_1']);
    const [envelope] = adapter.normalize(page.records[0]!, {
      locationId: 'loc_1',
      installationId: 'conn_1',
      adapterVersion: '1',
      timezone: 'America/Chicago',
      defaultCountry: 'US',
      customFields: new Map(),
    });
    expect((envelope!.data as { body: string }).body).toBe(
      'Hi {{contact.first_name}},\nThanks & see you soon.',
    );
  });

  it('asks for a rendered copy again when the first try does not come back', async () => {
    const preview =
      'https://firebasestorage.googleapis.com/v0/b/highlevel-backend.appspot.com/o/t.html?alt=media';
    let tries = 0;
    serve((url) => {
      if (url.hostname !== 'firebasestorage.googleapis.com')
        return {
          builders: [
            { id: 'tpl_1', name: 'Welcome', templateType: 'builder', previewUrl: preview },
          ],
          total: [{ total: 1 }],
        };
      tries += 1;
      return tries === 1
        ? new Response('upstream hiccup', { status: 503 })
        : '<html><body><p>Hello again.</p></body></html>';
    });
    const page = await adapter.list(connection, scope, 'templates', { cursor: null, limit: 100 });
    expect(page.records[0]!.payload['__previewText']).toBe('Hello again.');
    expect(tries).toBe(2);
  }, 15_000);

  it("never follows a template link to somewhere that is not HighLevel's storage", async () => {
    const calls = serve(() => ({
      builders: [
        { id: 'tpl_1', name: 'Odd', templateType: 'builder', previewUrl: 'https://example.com/x' },
      ],
    }));
    await adapter.list(connection, scope, 'templates', { cursor: null, limit: 100 });
    expect(calls.some((c) => c.hostname === 'example.com')).toBe(false);
  });

  it("leaves HighLevel's activity log out of the messages", async () => {
    serve((url) =>
      url.pathname === '/conversations/search'
        ? { conversations: [{ id: 'cnv_1', lastMessageDate: 1 }], total: 1 }
        : {
            messages: {
              messages: [
                { id: 'm1', messageType: 'TYPE_SMS', body: 'On our way', dateAdded: '2026-01-01' },
                { id: 'm2', messageType: 'TYPE_ACTIVITY_INVOICE', dateAdded: '2026-01-01' },
                { id: 'm3', messageType: 'TYPE_CALL', dateAdded: '2026-01-01' },
              ],
              nextPage: false,
            },
          },
    );
    const messages = await adapter.list(connection, scope, 'messages', {
      cursor: null,
      limit: 100,
    });
    expect(messages.records.map((r) => r.objectId)).toEqual(['m1']);
    const calls = await adapter.list(connection, scope, 'calls', { cursor: null, limit: 100 });
    expect(calls.records.map((r) => r.objectId)).toEqual(['m3']);
  });
});

describe('an email, as the words in it', () => {
  it('keeps where a link goes and drops what nobody reads', () => {
    expect(
      htmlToText(
        '<!--[if mso]>x<![endif]--><div>Book <a href="https://x.test/b">here</a><br>Thanks&nbsp;&#8212; Chris</div>',
      ),
    ).toBe('Book here (https://x.test/b)\nThanks — Chris');
  });
});

describe("a customer's name", () => {
  it("comes from what was typed, not HighLevel's lowercased copy", () => {
    const [envelope] = adapter.normalize(
      {
        objectType: 'contact',
        objectId: 'con_1',
        payload: {
          id: 'con_1',
          firstName: 'bobby',
          lastName: 'barber',
          firstNameRaw: 'Bobby',
          lastNameRaw: 'Barber',
          contactName: 'bobby barber',
        },
      },
      {
        locationId: 'loc_1',
        installationId: 'conn_1',
        adapterVersion: '1',
        timezone: 'America/Chicago',
        defaultCountry: 'US',
        customFields: new Map(),
      },
    );
    expect(envelope!.data).toMatchObject({
      firstName: 'Bobby',
      lastName: 'Barber',
      fullName: 'Bobby Barber',
    });
  });

  it('is capitalized when it was typed all in lowercase, and left alone otherwise', () => {
    expect(nameCase('david')).toBe('David');
    expect(nameCase("mary-jane o'brien")).toBe("Mary-Jane O'Brien");
    expect(nameCase('McDonald')).toBe('McDonald');
    expect(nameCase('NYC SEO PRO')).toBe('NYC SEO PRO');
    expect(nameCase('(805) 319-3388')).toBe('(805) 319-3388');
    expect(nameCase('bob@example.com')).toBe('bob@example.com');
    expect(nameCase(null)).toBeNull();
  });
});

describe('what a GoHighLevel thread is made of', () => {
  const context = {
    locationId: 'loc_1',
    installationId: 'conn_1',
    adapterVersion: '1',
    timezone: 'America/Chicago',
    defaultCountry: 'US',
    customFields: new Map(),
  };

  it('reads a TYPE_PHONE thread as a text thread, carrying the number and the address', () => {
    const [envelope] = adapter.normalize(
      {
        objectType: 'conversation',
        objectId: 'cnv_1',
        payload: {
          id: 'cnv_1',
          type: 'TYPE_PHONE',
          contactId: 'con_1',
          phone: '+15125550101',
          email: 'dave@example.com',
        },
      },
      context,
    );
    expect(envelope!.data).toMatchObject({
      channel: 'sms',
      counterpart: '+15125550101',
      phone: '+15125550101',
      email: 'dave@example.com',
    });
  });

  it("keeps an email's subject, and names the channel a chat came from", () => {
    const [email] = adapter.normalize(
      {
        objectType: 'message',
        objectId: 'm1',
        parentObjectId: 'cnv_1',
        payload: {
          id: 'm1',
          messageType: 'TYPE_EMAIL',
          direction: 'outbound',
          body: 'Here is your invoice.',
          meta: { email: { subject: 'Your invoice' } },
        },
      },
      context,
    );
    expect(email!.data).toMatchObject({ channel: 'email', subject: 'Your invoice' });
    const [facebook] = adapter.normalize(
      {
        objectType: 'message',
        objectId: 'm2',
        parentObjectId: 'cnv_1',
        payload: { id: 'm2', messageType: 'TYPE_FACEBOOK', direction: 'inbound', body: 'Hi' },
      },
      context,
    );
    expect(facebook!.data).toMatchObject({ channel: 'chat', channelName: 'facebook' });
  });

  it('files dialer and phone-menu calls as calls, and leaves chat notices out', async () => {
    serve((url) =>
      url.pathname === '/conversations/search'
        ? { conversations: [{ id: 'cnv_1', lastMessageDate: 1 }], total: 1 }
        : {
            messages: {
              messages: [
                { id: 'c1', messageType: 'TYPE_CUSTOM_CALL', dateAdded: '2026-01-01' },
                { id: 'c2', messageType: 'TYPE_IVR_CALL', dateAdded: '2026-01-01' },
                { id: 'n1', messageType: 'TYPE_LIVE_CHAT_INFO_MESSAGE', dateAdded: '2026-01-01' },
                { id: 'm1', messageType: 'TYPE_SMS_REACTION', dateAdded: '2026-01-01' },
              ],
              nextPage: false,
            },
          },
    );
    const calls = await adapter.list(connection, scope, 'calls', { cursor: null, limit: 100 });
    expect(calls.records.map((r) => r.objectId)).toEqual(['c1', 'c2']);
    const messages = await adapter.list(connection, scope, 'messages', {
      cursor: null,
      limit: 100,
    });
    expect(messages.records.map((r) => r.objectId)).toEqual(['m1']);
    const [reaction] = adapter.normalize(messages.records[0]!, context);
    expect(reaction!.data).toMatchObject({ channel: 'sms' });
  });

  it('asks for each email the list leaves without words, and brings each email of an exchange as itself', async () => {
    const emails: Record<string, Record<string, unknown>> = {
      em_1: {
        id: 'em_1',
        direction: 'inbound',
        dateAdded: '2026-01-02T10:00:00.000Z',
        from: 'Dave Smith <dave@example.com>',
        to: ['office@example.com'],
        subject: 'Question',
        body: '<p>Can you come <b>Tuesday</b>?</p>',
      },
      em_2: {
        id: 'em_2',
        direction: 'outbound',
        dateAdded: '2026-01-03T09:00:00.000Z',
        from: 'Office <office@example.com>',
        to: ['dave@example.com'],
        subject: 'Invoice',
        body: '<p>Here it is.</p>',
      },
      em_3: {
        id: 'em_3',
        direction: 'inbound',
        dateAdded: '2026-01-03T09:30:00.000Z',
        from: 'dave@example.com',
        to: ['office@example.com'],
        subject: 'Re: Invoice',
        body: 'Paid.',
      },
    };
    const asked = serve((url) => {
      if (url.pathname === '/conversations/search')
        return { conversations: [{ id: 'cnv_1', lastMessageDate: 1 }], total: 1 };
      if (url.pathname.startsWith('/conversations/messages/email/')) {
        const one = emails[decodeURIComponent(url.pathname.split('/').pop()!)];
        return one
          ? { emailMessage: one }
          : new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
      }
      const email = (id: string, ids: string[], extra: Record<string, unknown> = {}) => ({
        id,
        messageType: 'TYPE_EMAIL',
        dateAdded: '2026-01-02T10:00:00.000Z',
        ...extra,
        meta: { email: { messageIds: ids, direction: 'inbound', subject: `Listed ${id}` } },
      });
      return {
        messages: {
          messages: [
            // No words, and which way it went only under `meta.email`.
            email('m1', ['em_1']),
            // One entry for an exchange of two.
            email('m2', ['em_2', 'em_3']),
            // Its words are already here: nothing more to ask.
            email('m3', ['em_4'], { direction: 'outbound', body: 'See you then.' }),
            // One HighLevel no longer has: kept as it was listed.
            email('m4', ['em_gone']),
          ],
          nextPage: false,
        },
      };
    });
    const page = await adapter.list(connection, scope, 'messages', { cursor: null, limit: 100 });
    expect(page.records.map((r) => r.objectId)).toEqual(['m1', 'm2', 'em_3', 'm3', 'm4']);
    const lookedUp = asked
      .filter((u) => u.pathname.startsWith('/conversations/messages/email/'))
      .map((u) => u.pathname.split('/').pop());
    expect(lookedUp.sort()).toEqual(['em_1', 'em_2', 'em_3', 'em_gone']);

    const data = page.records.map((r) => adapter.normalize(r, context)[0]!.data);
    expect(data[0]).toMatchObject({
      direction: 'inbound',
      fromAddress: 'dave@example.com',
      toAddresses: ['office@example.com'],
      subject: 'Question',
      body: null,
      bodyHtml: '<p>Can you come <b>Tuesday</b>?</p>',
    });
    expect(data[1]).toMatchObject({
      direction: 'outbound',
      subject: 'Invoice',
      toAddresses: ['dave@example.com'],
      occurredAt: '2026-01-03T09:00:00.000Z',
      providerMessageId: 'm2',
    });
    expect(data[2]).toMatchObject({
      direction: 'inbound',
      subject: 'Re: Invoice',
      body: 'Paid.',
      bodyHtml: null,
      occurredAt: '2026-01-03T09:30:00.000Z',
      providerMessageId: 'em_3',
    });
    expect(data[3]).toMatchObject({ direction: 'outbound', body: 'See you then.' });
    // Its direction was only under `meta.email` too, and it was the customer's.
    expect(data[4]).toMatchObject({ direction: 'inbound', subject: 'Listed m4', body: null });
  });

  it('keeps a customer who texted STOP from being texted, whichever word HighLevel used for it', () => {
    const consent = (dndSettings: Record<string, unknown>, dnd = false) =>
      (
        adapter.normalize(
          {
            objectType: 'contact',
            objectId: 'con_1',
            payload: { id: 'con_1', firstName: 'Dave', phone: '+15125550101', dnd, dndSettings },
          },
          context,
        )[0]!.data as { consent: { channel: string; state: string }[] }
      ).consent.find((c) => c.channel === 'sms')!.state;
    expect(consent({ SMS: { status: 'permanent', message: 'STOP_KEYWORD' } })).toBe('opted_out');
    expect(consent({ SMS: { status: 'active' } })).toBe('opted_out');
    expect(consent({ SMS: { status: 'inactive' } })).toBe('unknown');
    expect(consent({})).toBe('unknown');
    expect(consent({}, true)).toBe('opted_out');
  });

  it('reads a booked call as a step on the way, and only a won or lost name as won or lost', () => {
    const [pipeline] = adapter.normalize(
      {
        objectType: 'pipeline',
        objectId: 'pip_1',
        payload: {
          id: 'pip_1',
          name: 'Prospect Funnel',
          stages: [
            { id: 'st_1', name: 'New Lead' },
            { id: 'st_2', name: 'Booked Call' },
            { id: 'st_3', name: 'Ai Booked Sales Call ' },
            { id: 'st_4', name: 'Signed Up For Service' },
            { id: 'st_5', name: 'Closed Lost' },
          ],
        },
      },
      context,
    );
    const stages = (pipeline!.data as { stages: { name: string; kind: string }[] }).stages;
    expect(stages.map((st) => st.kind)).toEqual(['open', 'open', 'open', 'won', 'lost']);
  });

  it('reads a plan whose first payment never went through as over, not as running', () => {
    const plan = (status: string) =>
      adapter.normalize(
        {
          objectType: 'subscription',
          objectId: `sub_${status}`,
          payload: { _id: `sub_${status}`, status, amount: 99, contactId: 'con_1' },
        },
        context,
      )[0]!.data as { status: string };
    expect(plan('incomplete_expired').status).toBe('cancelled');
    expect(plan('canceled').status).toBe('cancelled');
    expect(plan('active').status).toBe('active');
    expect(plan('past_due').status).toBe('past_due');
  });

  it('asks each product for its prices, which the list leaves off', async () => {
    serve((url) => {
      if (url.pathname === '/products/')
        return {
          products: [
            { _id: 'prd_1', name: 'SEO 500', hasPrices: false },
            { _id: 'prd_2', name: 'Free consult', hasPrices: false },
          ],
          total: [{ total: 2 }],
        };
      if (url.pathname === '/products/prd_1/price')
        return { prices: [{ _id: 'pr_1', name: '500', amount: 500, currency: 'USD' }], total: 1 };
      return { prices: [], total: 0 };
    });
    const page = await adapter.list(connection, scope, 'products', { cursor: null, limit: 100 });
    const data = page.records.map(
      (r) => adapter.normalize(r, context)[0]!.data as { name: string; unitPriceCents: number },
    );
    expect(data.map((d) => [d.name, d.unitPriceCents])).toEqual([
      ['SEO 500', 50_000],
      ['Free consult', 0],
    ]);
  });

  it('counts invoices by asking the way the list insists on, with an offset', async () => {
    const calls = serve((url) => {
      if (url.pathname === '/invoices/' && !url.searchParams.has('offset'))
        return { statusCode: 422, message: ['offset should not be empty'] };
      if (url.pathname === '/invoices/') return { invoices: [{ _id: 'inv_1' }], total: 146 };
      if (url.pathname.endsWith('/tags'))
        return {
          tags: [
            { id: 't1', name: 'a' },
            { id: 't2', name: 'b' },
          ],
        };
      return {};
    });
    const seen: { category: string; count: number; countQuality: string }[] = [];
    for await (const r of adapter.scan(connection, scope)) seen.push(r);
    expect(seen.find((r) => r.category === 'invoices')).toMatchObject({
      count: 146,
      countQuality: 'complete',
    });
    // The tags list answers with every tag whatever the limit, so that is a whole count, not "at least".
    expect(seen.find((r) => r.category === 'tags')).toMatchObject({
      count: 2,
      countQuality: 'complete',
    });
    expect(calls.find((c) => c.pathname === '/invoices/')!.searchParams.get('offset')).toBe('0');
  });

  it('counts email templates without the folders they are listed among', async () => {
    serve((url) =>
      url.pathname === '/emails/builder'
        ? {
            builders: [
              { id: 't1', templateType: 'builder' },
              { id: 't2', templateType: 'builder' },
              { id: 'f1', templateType: 'folder' },
            ],
            total: [{ total: 3 }],
          }
        : {},
    );
    const seen: { category: string; count: number; countQuality: string }[] = [];
    for await (const r of adapter.scan(connection, scope)) seen.push(r);
    expect(seen.find((r) => r.category === 'templates')).toMatchObject({
      count: 2,
      countQuality: 'complete',
    });
  });

  it('asks again when HighLevel says its own command timed out, which it says with a 401', async () => {
    let answered = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        answered += 1;
        return answered === 1
          ? new Response(JSON.stringify({ statusCode: 401, message: 'Command timed out' }), {
              status: 401,
            })
          : new Response(JSON.stringify({ tags: [{ id: 'tag_1', name: 'vip' }] }), {
              status: 200,
            });
      }),
    );
    const page = await adapter.list(connection, scope, 'tags', { cursor: null, limit: 100 });
    expect(page.records.map((r) => r.objectId)).toEqual(['tag_1']);
    expect(answered).toBe(2);
  }, 15_000);

  it('asks again when a request times out, rather than failing the page', async () => {
    let dropped = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (dropped < 1) {
          dropped += 1;
          throw new TypeError('fetch failed');
        }
        return new Response(JSON.stringify({ tags: [{ id: 'tag_1', name: 'vip' }] }), {
          status: 200,
        });
      }),
    );
    const page = await adapter.list(connection, scope, 'tags', { cursor: null, limit: 100 });
    expect(page.records.map((r) => r.objectId)).toEqual(['tag_1']);
    expect(dropped).toBe(1);
  }, 15_000);
});

describe('a file behind a signed link', () => {
  it('knows when the link ran out, in the forms Google and Amazon sign them', () => {
    expect(
      linkExpiry(
        'https://storage.googleapis.com/highlevel-backend.appspot.com/receipts/r.pdf?GoogleAccessId=x&Expires=1749515963&Signature=y',
      )?.toISOString(),
    ).toBe('2025-06-10T00:39:23.000Z');
    expect(
      linkExpiry(
        'https://storage.googleapis.com/b/o.pdf?X-Goog-Date=20250101T000000Z&X-Goog-Expires=3600&X-Goog-Signature=z',
      )?.toISOString(),
    ).toBe('2025-01-01T01:00:00.000Z');
    expect(
      linkExpiry(
        'https://bucket.s3.amazonaws.com/o.pdf?X-Amz-Date=20250102T030405Z&X-Amz-Expires=60',
      ),
    ).toEqual(new Date('2025-01-02T03:05:05.000Z'));
    expect(linkExpiry('https://brand.example.com/photo.jpg')).toBeNull();
    expect(linkExpiry('not a link')).toBeNull();
  });
});
