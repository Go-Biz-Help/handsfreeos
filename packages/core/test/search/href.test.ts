/**
 * Where a search result opens (search/href.ts), with no database: every link a web path under the business, and
 * what's typed only ever after `#`.
 */
import { describe, expect, it } from 'vitest';
import {
  addContactHref,
  readSearchFragment,
  searchHref,
  searchPageHref,
} from '../../src/search/href';

const WS = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('result links', () => {
  it('open each kind’s own page under the business', () => {
    const base = `/app/w/${WS}/`;
    expect(searchHref(WS, { type: 'person', id: ID })).toBe(`${base}customers/people/${ID}`);
    expect(searchHref(WS, { type: 'company', id: ID })).toBe(`${base}customers/companies/${ID}`);
    expect(searchHref(WS, { type: 'lead', id: ID })).toBe(`${base}leads/${ID}`);
    expect(searchHref(WS, { type: 'custom_record', id: ID })).toBe(
      `${base}customers/records/${ID}`,
    );
    expect(searchHref(WS, { type: 'invoice', id: ID })).toBe(`${base}money/invoices/${ID}`);
    expect(searchHref(WS, { type: 'estimate', id: ID })).toBe(`${base}money/estimates/${ID}`);
    expect(searchHref(WS, { type: 'knowledge', id: ID })).toBe(`${base}knowledge/items/${ID}`);
    expect(searchHref(WS, { type: 'bin', id: ID })).toBe(`${base}settings/deleted-bin?item=${ID}`);
  });

  it('open the deeper places search reaches', () => {
    const base = `/app/w/${WS}/`;
    expect(
      searchHref(WS, {
        type: 'conversation',
        id: ID,
        messageId: OTHER,
        at: '2026-10-01T10:00:00.000Z',
      }),
    ).toBe(`${base}inbox/${ID}?message=${OTHER}&at=2026-10-01T10%3A00%3A00.000Z`);
    expect(searchHref(WS, { type: 'conversation', id: ID })).toBe(`${base}inbox/${ID}`);
    expect(searchHref(WS, { type: 'task', id: ID })).toBe(`${base}tasks?task=${ID}`);
    expect(searchHref(WS, { type: 'appointment', id: ID, day: '2026-10-23' })).toBe(
      `${base}calendar?appt=${ID}&date=2026-10-23`,
    );
    expect(searchHref(WS, { type: 'form_response', formId: OTHER, id: ID })).toBe(
      `${base}forms/${OTHER}/answers/${ID}`,
    );
    expect(searchHref(WS, { type: 'activity', id: ID, on: { type: 'lead', id: OTHER } })).toBe(
      `${base}leads/${OTHER}?activity=${ID}`,
    );
    expect(
      searchHref(WS, { type: 'file', id: ID, on: { type: 'person', id: OTHER }, page: 3 }),
    ).toBe(`${base}customers/people/${OTHER}?tab=files&file=${ID}&page=3`);
    expect(searchHref(WS, { type: 'compose_text', personId: ID })).toBe(
      `${base}customers/people/${ID}?compose=sms`,
    );
    expect(searchHref(WS, { type: 'merge', personId: ID, otherId: OTHER })).toBe(
      `${base}customers/people/${ID}?merge=${OTHER}`,
    );
  });
});

describe('the Search page’s address', () => {
  it('keeps what was typed after #, never in a query string', () => {
    const href = searchPageHref(WS, { q: 'dana smith & co', kind: 'contacts', mine: true });
    expect(href).toBe(`/app/w/${WS}/search#q=dana%20smith%20%26%20co&kind=contacts&mine=1`);
    expect(href.split('#')[0]).not.toContain('dana');
    expect(addContactHref(WS, ' Dana Smith ')).toBe(
      `/app/w/${WS}/customers#add=person&name=Dana%20Smith`,
    );
  });

  it('reads back what it wrote, cutting what was typed to 120 characters', () => {
    expect(
      readSearchFragment('#q=dana%20smith&kind=contacts&archived=1&sort=recent&show=leads'),
    ).toEqual({
      q: 'dana smith',
      kind: 'contacts',
      archived: true,
      mine: false,
      sort: 'recent',
      show: 'leads',
      before: null,
    });
    expect(readSearchFragment(`q=${'x'.repeat(200)}&sort=sideways`).q).toHaveLength(120);
    expect(readSearchFragment('q=%E0%A4%A&sort=sideways')).toMatchObject({
      q: '%E0%A4%A',
      sort: 'best',
    });
  });
});
