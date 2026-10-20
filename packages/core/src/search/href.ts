/**
 * Where a search result opens (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Web: where a result opens"): every link
 * is a web path under /app/w/<business>/, built here once. The phone opens the same path through its route map, as
 * a screen of its own or in the browser.
 *
 * What's typed only ever travels after `#` (decision 37): a browser never sends that part, so it never reaches the
 * web's own server or its host's request logs.
 */

/** The record types a timeline line or a file hangs off, as their pages are found. */
export type SearchRecordRef =
  | { readonly type: 'person'; readonly id: string }
  | { readonly type: 'company'; readonly id: string }
  | { readonly type: 'lead'; readonly id: string }
  | { readonly type: 'custom_record'; readonly id: string };

export type SearchTarget =
  | SearchRecordRef
  | { readonly type: 'invoice'; readonly id: string }
  | { readonly type: 'estimate'; readonly id: string }
  | { readonly type: 'knowledge'; readonly id: string }
  | { readonly type: 'bin'; readonly id: string }
  | {
      readonly type: 'conversation';
      readonly id: string;
      readonly messageId?: string;
      readonly at?: string;
    }
  | { readonly type: 'task'; readonly id: string }
  | { readonly type: 'appointment'; readonly id: string; readonly day: string }
  | { readonly type: 'form_response'; readonly formId: string; readonly id: string }
  | { readonly type: 'activity'; readonly id: string; readonly on: SearchRecordRef }
  | {
      readonly type: 'file';
      readonly id: string;
      readonly on: SearchRecordRef;
      readonly page?: number | null;
    }
  | { readonly type: 'compose_text'; readonly personId: string }
  | { readonly type: 'merge'; readonly personId: string; readonly otherId: string };

/** A record's own page, under the business. */
function recordPath(r: SearchRecordRef): string {
  switch (r.type) {
    case 'person':
      return `customers/people/${r.id}`;
    case 'company':
      return `customers/companies/${r.id}`;
    case 'lead':
      return `leads/${r.id}`;
    case 'custom_record':
      return `customers/records/${r.id}`;
  }
}

const query = (pairs: Record<string, string | number | null | undefined>): string => {
  const parts = Object.entries(pairs)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? parts.join('&') : '';
};

/** The path a result opens, `/app/w/<business>/customers/people/<id>`. */
export function searchHref(workspaceId: string, t: SearchTarget): string {
  const base = `/app/w/${workspaceId}/`;
  switch (t.type) {
    case 'person':
    case 'company':
    case 'lead':
    case 'custom_record':
      return base + recordPath(t);
    case 'invoice':
      return `${base}money/invoices/${t.id}`;
    case 'estimate':
      return `${base}money/estimates/${t.id}`;
    case 'knowledge':
      return `${base}knowledge/items/${t.id}`;
    case 'bin':
      return `${base}settings/deleted-bin?${query({ item: t.id })}`;
    case 'conversation': {
      const q = query({ message: t.messageId, at: t.at });
      return `${base}inbox/${t.id}${q ? `?${q}` : ''}`;
    }
    case 'task':
      return `${base}tasks?${query({ task: t.id })}`;
    case 'appointment':
      return `${base}calendar?${query({ appt: t.id, date: t.day })}`;
    case 'form_response':
      return `${base}forms/${t.formId}/answers/${t.id}`;
    case 'activity':
      return `${base}${recordPath(t.on)}?${query({ activity: t.id })}`;
    case 'file':
      return `${base}${recordPath(t.on)}?${query({ tab: 'files', file: t.id, page: t.page })}`;
    case 'compose_text':
      return `${base}customers/people/${t.personId}?compose=sms`;
    case 'merge':
      return `${base}customers/people/${t.personId}?${query({ merge: t.otherId })}`;
  }
}

/** The fragment of a Search page link: `q=…&kind=…`, and whichever of its switches are on. */
export interface SearchPageState {
  readonly q: string;
  readonly kind?: string | null;
  readonly archived?: boolean;
  readonly mine?: boolean;
  readonly sort?: 'best' | 'recent' | 'name' | null;
  readonly show?: 'leads' | 'clients' | null;
  readonly before?: string | null;
}

/** The Search page for a search: `/app/w/<business>/search#q=…&kind=…`, what's typed after `#` only. */
export function searchPageHref(workspaceId: string, s: SearchPageState): string {
  const fragment = query({
    q: s.q,
    kind: s.kind,
    archived: s.archived ? 1 : null,
    mine: s.mine ? 1 : null,
    sort: s.sort && s.sort !== 'best' ? s.sort : null,
    show: s.show,
    before: s.before,
  });
  return `/app/w/${workspaceId}/search#${fragment}`;
}

/** Reads a Search page's fragment back (`#q=…&kind=…`, with or without the `#`); `q` cut to 120 characters. */
export function readSearchFragment(hash: string): SearchPageState {
  const pairs = new Map<string, string>();
  for (const pair of hash.replace(/^#/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    let value = eq >= 0 ? pair.slice(eq + 1) : '';
    try {
      value = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      // A broken escape is read as it stands.
    }
    pairs.set(key, value);
  }
  const sort = pairs.get('sort');
  const show = pairs.get('show');
  return {
    q: (pairs.get('q') ?? '').trim().slice(0, 120),
    kind: pairs.get('kind') || null,
    archived: pairs.get('archived') === '1',
    mine: pairs.get('mine') === '1',
    sort: sort === 'recent' || sort === 'name' ? sort : 'best',
    show: show === 'leads' || show === 'clients' ? show : null,
    before: pairs.get('before') || null,
  };
}

/** "Add a contact" with what was typed as the name: `/app/w/<business>/customers#add=person&name=…`. */
export function addContactHref(workspaceId: string, name: string): string {
  return `/app/w/${workspaceId}/customers#${query({ add: 'person', name: name.trim() })}`;
}
