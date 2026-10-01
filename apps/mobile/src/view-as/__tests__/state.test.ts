let mockSignedIn = '11111111-1111-4111-8111-111111111111';
jest.mock('@/lib/auth', () => ({
  session: {
    accessToken: async () => 'token-1',
    getState: () => ({
      status: 'signedIn',
      person: { userId: mockSignedIn, name: 'Dale Ramsey' },
      expiresAt: 0,
    }),
  },
}));

import { VIEW_AS_HEADER, VIEW_AS_WORDS } from '@hfos/core';

import { createAppApi } from '@/lib/api';

import {
  currentView,
  dropView,
  keepView,
  lensOf,
  sees,
  seesThread,
  viewRefusal,
  type PhoneView,
} from '../state';

/**
 * Viewing as a teammate on the phone (20261018000100): the view belongs to whoever started it, stops every change in
 * its business and no other, names itself on every request to HandsFreeOS, and shows the copy through what the
 * teammate sees, never somebody else's own mail.
 */
const DALE = '11111111-1111-4111-8111-111111111111';
const MARIA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BAYOU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VIEW = '99999999-9999-4999-8999-999999999999';

const view: PhoneView = {
  viewerId: DALE,
  workspaceId: LONE_STAR,
  viewId: VIEW,
  by: 'team',
  person: {
    userId: MARIA,
    fullName: 'Maria Lopez',
    email: 'maria@lonestarhvac.test',
    role: 'member',
    permissions: ['records.read', 'inbox.use'],
  },
  conversationIds: ['t1'],
  attentionItemIds: ['a1'],
  estimateIds: [],
  invoiceIds: ['i1'],
  fetchedAt: 0,
};

function capturing(): { seen: Request[]; fetch: typeof fetch } {
  const seen: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seen.push(input as Request);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetch: fetchImpl };
}

afterEach(() => {
  dropView();
  mockSignedIn = DALE;
});

describe('a view on this phone', () => {
  it('is the one who started it’s, and nobody else’s signed in here', () => {
    keepView(view);
    expect(currentView()).toEqual(view);
    mockSignedIn = MARIA;
    expect(currentView()).toBeNull();
    expect(viewRefusal({ workspaceId: LONE_STAR })).toBeNull();
  });

  it('stops every change in its business, and none anywhere else', () => {
    expect(viewRefusal({ workspaceId: LONE_STAR })).toBeNull();
    keepView(view);
    expect(viewRefusal({ workspaceId: LONE_STAR, personId: 'x' })).toBe(
      VIEW_AS_WORDS.readOnly(view.person),
    );
    expect(viewRefusal({ workspaceId: BAYOU })).toBeNull();
    expect(viewRefusal({ token: 'push' })).toBeNull();
  });

  it('names itself on every request to HandsFreeOS while it lasts', async () => {
    const { seen, fetch } = capturing();
    const api = createAppApi(async () => 'token-1', fetch);
    await api.POST('/v1/queries/account.me', { body: {} });
    keepView(view);
    await api.POST('/v1/queries/workspace.get', { body: { workspaceId: LONE_STAR } });
    dropView();
    await api.POST('/v1/queries/workspace.get', { body: { workspaceId: LONE_STAR } });
    expect(seen.map((r) => r.headers.get(VIEW_AS_HEADER))).toEqual([null, VIEW, null]);
  });
});

describe('the copy through a view', () => {
  it('shows everything outside one, and only what the teammate sees inside one', () => {
    expect(sees(lensOf(null)?.conversations, 't2')).toBe(true);
    const lens = lensOf(view)!;
    expect(sees(lens.conversations, 't1')).toBe(true);
    expect(sees(lens.conversations, 't2')).toBe(false);
    expect(sees(lens.estimates, 'e1')).toBe(false);
    expect(sees(lens.invoices, null)).toBe(false);
    const whole = lensOf({ ...view, conversationIds: null })!;
    expect(sees(whole.conversations, 't2')).toBe(true);
  });

  it('never shows somebody else’s own mail, even where the teammate sees the whole inbox', () => {
    const whole = lensOf({ ...view, conversationIds: null });
    expect(seesThread(whole, { id: 't2', private_to: null }, MARIA)).toBe(true);
    expect(seesThread(whole, { id: 't3', private_to: DALE }, MARIA)).toBe(false);
    expect(seesThread(null, { id: 't3', private_to: DALE }, DALE)).toBe(true);
  });
});
