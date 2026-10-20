/**
 * How search ranks (search/rank.ts), with no database: tiers from a name, the order inside a kind, the best match at
 * tier 2 or better, and document numbers matched the way the SQL matches them.
 */
import { describe, expect, it } from 'vitest';
import { documentNumberMatches, documentNumberProbe } from '../../src/money/numbering';
import type { SearchGroup, SearchHit } from '../../src/schemas/search';
import { searchProbes } from '../../src/search/probes';
import { bestOf, orderGroups, rankHits, tierOf } from '../../src/search/rank';

let n = 0;
const hit = (over: Partial<SearchHit> & Pick<SearchHit, 'kind' | 'title' | 'tier'>): SearchHit => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  subtitle: null,
  badges: [],
  why: { field: 'name', label: null, snippet: null, page: null },
  exact: false,
  at: null,
  href: '/',
  contact: null,
  amount: null,
  facts: {},
  duplicateOf: null,
  ...over,
});
const group = (kind: string, items: SearchHit[]): SearchGroup => ({
  kind,
  label: null,
  icon: null,
  total: items.length,
  capped: false,
  complete: true,
  searchedBack: null,
  unavailable: null,
  items,
});

describe('tiers from a name', () => {
  it('is 1 when every word starts a word, 2 when the name only holds them, null otherwise', () => {
    expect(tierOf('Dana Smith', searchProbes('dana smi'))).toBe(1);
    expect(tierOf('Dana Smith', searchProbes('ana'))).toBe(2);
    expect(tierOf('José García', searchProbes('jose gar'))).toBe(1);
    expect(tierOf('Mary-Jane Ode', searchProbes('jane'))).toBe(1);
    expect(tierOf('Dana Smith', searchProbes('dana jones'))).toBeNull();
  });
});

describe('the order inside a kind', () => {
  it('puts archived last, then by tier, open before finished, one-to-one before automated, then newest', () => {
    const archived = hit({ kind: 'contacts', title: 'Old', tier: 0, badges: ['archived'] });
    const won = hit({ kind: 'leads', title: 'Won one', tier: 1, badges: ['won'] });
    const open = hit({ kind: 'leads', title: 'Open one', tier: 1 });
    const older = hit({ kind: 'leads', title: 'Older', tier: 2, at: '2026-01-01T00:00:00.000Z' });
    const newer = hit({ kind: 'leads', title: 'Newer', tier: 2, at: '2026-06-01T00:00:00.000Z' });
    expect(rankHits([archived, older, won, newer, open]).map((h) => h.title)).toEqual([
      'Open one',
      'Won one',
      'Newer',
      'Older',
      'Old',
    ]);
  });

  it('puts campaign and automated sends after one-to-one ones at the same tier', () => {
    const campaign = hit({
      kind: 'messages',
      title: 'Campaign',
      tier: 4,
      at: '2026-06-02T00:00:00.000Z',
    });
    const own = hit({ kind: 'messages', title: 'Own', tier: 4, at: '2026-06-01T00:00:00.000Z' });
    const ranked = rankHits([campaign, own], { automated: (h) => h.title === 'Campaign' });
    expect(ranked.map((h) => h.title)).toEqual(['Own', 'Campaign']);
  });
});

describe('the best match', () => {
  it('is the best hit at tier 2 or better from contacts, companies, leads, money, records or add-ons', () => {
    const dana = hit({ kind: 'contacts', title: 'Dana Smith', tier: 1 });
    const lead = hit({ kind: 'leads', title: 'Smith job', tier: 1 });
    const knowledge = hit({ kind: 'knowledge', title: 'Smith FAQ', tier: 0 });
    // Ties go to kind order: contacts before leads.
    expect(bestOf([group('leads', [lead]), group('contacts', [dana])])?.title).toBe('Dana Smith');
    // Knowledge never gives the best match, whatever its tier.
    expect(bestOf([group('knowledge', [knowledge])])).toBeNull();
    expect(
      bestOf([group('contacts', [hit({ kind: 'contacts', title: 'X', tier: 3 })])]),
    ).toBeNull();
    const pet = hit({ kind: 'record.pets', title: 'Rex', tier: 0 });
    expect(bestOf([group('contacts', [dana]), group('record.pets', [pet])])?.title).toBe('Rex');
    const archived = hit({ kind: 'contacts', title: 'Gone', tier: 0, badges: ['archived'] });
    expect(bestOf([group('contacts', [archived])])).toBeNull();
  });
});

describe('group order', () => {
  it('puts groups whose best hit is tier 0 to 2 first, by tier, then the rest in kind order', () => {
    const groups = [
      group('knowledge', [hit({ kind: 'knowledge', title: 'k', tier: 4 })]),
      group('money', [hit({ kind: 'money', title: 'm', tier: 3 })]),
      group('leads', [hit({ kind: 'leads', title: 'l', tier: 2 })]),
      group('record.pets', [hit({ kind: 'record.pets', title: 'r', tier: 1 })]),
      group('contacts', [hit({ kind: 'contacts', title: 'c', tier: 3 })]),
    ];
    expect(orderGroups(groups).map((g) => g.kind)).toEqual([
      'record.pets',
      'leads',
      'contacts',
      'money',
      'knowledge',
    ]);
  });
});

describe('document numbers', () => {
  const probe = (typed: string) => documentNumberProbe(typed)!;
  it('matches the whole number, or the counter under the same prefix, a bare number under any', () => {
    expect(documentNumberMatches('2026-1042', probe('2026-1042'))).toBe(true);
    expect(documentNumberMatches('2026-1042', probe('1042'))).toBe(true);
    expect(documentNumberMatches('INV-001042', probe('1042'))).toBe(true);
    expect(documentNumberMatches('1042', probe('#1042'))).toBe(true);
    expect(documentNumberMatches('LS-0042', probe('LS-0042'))).toBe(true);
    expect(documentNumberMatches('LS-42', probe('ls-0042'))).toBe(true);
    expect(documentNumberMatches('INV-0042', probe('LS-0042'))).toBe(false);
    expect(documentNumberMatches('INV-11042', probe('1042'))).toBe(false);
    expect(documentNumberMatches(null, probe('1042'))).toBe(false);
  });
});
