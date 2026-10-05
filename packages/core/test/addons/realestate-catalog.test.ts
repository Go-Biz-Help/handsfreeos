/**
 * Real Estate Agent's duty catalog (step 7), without a database: every row of the specification is there once, each
 * tracker is used, every stage, date and document a row names is real for its side, the four product rows are
 * product, contract-date rows are known, and a moment creates exactly the rows it should.
 */
import { describe, expect, it } from 'vitest';
import {
  appliesTo,
  CATALOG,
  catalogIssues,
  dutiesCreatedBy,
  resolveDuty,
  restsOnContract,
  TRACKER_CODES,
  TRACKERS,
  DOCUMENT_KINDS,
  type DealFact,
  type ProofItem,
} from '../../src/addons/realestate/catalog';
import { stage } from '../../src/addons/realestate/catalog/helpers';

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);

describe('the duty catalog', () => {
  it('holds all 148 rows of the specification, each once and in order', () => {
    expect(CATALOG.map((d) => d.id)).toEqual([...ids('B', 31), ...ids('S', 70), ...ids('X', 47)]);
    expect(catalogIssues()).toEqual([]);
  });

  it('uses every one of the 24 trackers, and only them', () => {
    expect(TRACKER_CODES).toHaveLength(24);
    expect(new Set(CATALOG.map((d) => d.tracker))).toEqual(new Set(TRACKER_CODES));
    for (const code of TRACKER_CODES) expect(TRACKERS[code].code).toBe(code);
  });

  it('keeps the product’s own behaviour out of each deal’s list (Chris, 2026-09-30)', () => {
    expect(CATALOG.filter((d) => d.perDeal === false).map((d) => d.id)).toEqual([
      'X-13',
      'X-14',
      'X-44',
      'X-45',
    ]);
    // A buyer deal has the 31 buyer rows and the cross rows but the ten about listings and the four product
    // rows; a listing, its 70 and the cross rows but the thirteen about buyers and the four.
    expect(CATALOG.filter((d) => appliesTo(d, 'buyer'))).toHaveLength(31 + 47 - 10 - 4);
    expect(CATALOG.filter((d) => appliesTo(d, 'listing'))).toHaveLength(70 + 47 - 13 - 4);
  });

  it('names only real documents in its proof, and says who answers for each', () => {
    const items = (d: (typeof CATALOG)[number]): readonly ProofItem[] =>
      resolveDuty(d).proof?.items ?? [];
    for (const d of CATALOG) {
      for (const item of items(d))
        if (item.kind === 'document')
          for (const k of item.documents) expect(DOCUMENT_KINDS, `${d.id} ${k}`).toHaveProperty(k);
      expect(['agent', 'coordinator', 'broker']).toContain(resolveDuty(d).accountable);
    }
  });

  it('knows which rows wait for a contract date to be confirmed', () => {
    const contract = CATALOG.filter(restsOnContract).map((d) => d.id);
    expect(contract).toContain('S-51'); // earnest money, on its due date
    expect(contract).toContain('B-25'); // inspection issues, by the end of the period
    expect(contract).not.toContain('S-10'); // disclosures, before the launch the agent plans
    expect(contract).not.toContain('B-05');
  });

  it('never lets the AI act alone on a wire change or on who someone is', () => {
    expect(CATALOG.find((d) => d.id === 'X-27')?.automation).toBe('AX');
    expect(CATALOG.find((d) => d.id === 'X-43')?.automation).toBe('AX');
  });

  it('creates a stage’s rows for its side, facts permitting, and a second offer’s only later', () => {
    const none = new Set<DealFact>();
    const offer = (round: 'first' | 'later') =>
      dutiesCreatedBy('buyer', stage('offer'), none, round).map((d) => d.id);
    expect(offer('first')).toEqual(['B-09', 'B-10', 'B-11']);
    expect(offer('later')).toEqual(['B-15', 'B-16']);

    const contract = (facts: DealFact[]) =>
      dutiesCreatedBy('buyer', stage('under_contract'), new Set(facts)).map((d) => d.id);
    expect(contract([])).toEqual([
      'B-17',
      'B-18',
      'X-02',
      'X-03',
      'X-07',
      'X-08',
      'X-09',
      'X-15',
      'X-17',
      'X-19',
      'X-27',
    ]);
    expect(contract(['well'])).toContain('X-21');
    expect(contract(['solar'])).toEqual(expect.arrayContaining(['X-21', 'X-22']));

    // A row on both sides starts where each side's work is.
    expect(dutiesCreatedBy('listing', stage('pre_listing'), none).map((d) => d.id)).toEqual(
      expect.arrayContaining(['S-11', 'X-08', 'X-19']),
    );
    expect(
      dutiesCreatedBy('listing', stage('under_contract'), none).map((d) => d.id),
    ).not.toContain('X-08');
  });
});
