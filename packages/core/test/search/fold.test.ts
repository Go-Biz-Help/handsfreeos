/**
 * Folding accents (search/fold.ts) on the local database: core's `fold` and `private.search_fold` give the same
 * text, letter for letter, so the server finds and marks what the phone would. Each letter folds to one letter, so
 * the length never changes and a mark found in the folded text fits the original. And the database's stays cheap
 * enough to run on every name of a business.
 */
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fold, FOLD_FROM, FOLD_TO } from '../../src/search/fold';

let person: TestUser;

beforeAll(async () => {
  person = await createTestUser('search-fold');
});
afterAll(closeTestDbs);

/** Each text folded by the database, as a signed-in person runs it. */
async function foldedBySql(
  texts: readonly string[],
): Promise<{ folded: string; length: number }[]> {
  const out = await asUser(testDbs().api.db, person.claims, (tx) =>
    rows<{ folded: string; length: number }>(
      tx,
      sql`select private.search_fold(x.text) as folded, length(private.search_fold(x.text)) as length
          from jsonb_array_elements_text(${JSON.stringify(texts)}::jsonb) with ordinality as x(text, n)
          order by x.n`,
    ),
  );
  return out.map((r) => ({ folded: r.folded, length: Number(r.length) }));
}

const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

/** The words the plan names, and the things people type that must come through untouched but for case. */
const CORPUS = [
  'José García',
  'JOSÉ GARCÍA',
  'Łódź',
  'Bjørn Ødegård',
  'Æsir Ærø',
  'Œuvre cœur',
  'Straße STRASSE ẞ',
  'Đặng Nguyễn Thị Hương',
  'İstanbul İzmir ıspanak',
  'Ðóra Þór',
  // é written as e and a combining accent: left as it is, so it stays two characters.
  'José García',
  'ΟΔΟΣ ΣΟΦΙΑΣ οδος σοφίας',
  'Μάριος Παπαδόπουλος',
  'Иван Петров',
  'INV-001042 2026-1042 LS-0042',
  '(504) 555-0142 +1 504 555 0142',
  'dana.smith@gmail.com DANA.SMITH@GMAIL.COM',
  'https://www.GulfCoastRealty.com/about',
  '#1042 $1,280.00 50%_off',
  '',
];

describe('core’s fold and the database’s', () => {
  it('give the same text over the corpus, and never change its length', async () => {
    const sqlSide = await foldedBySql(CORPUS);
    CORPUS.forEach((text, i) => {
      expect(sqlSide[i]!.folded, text).toBe(fold(text));
      expect(fold(text)).toHaveLength(text.length);
      expect(sqlSide[i]!.length, text).toBe([...text].length);
    });
  });

  it('agree on every letter of the map, and on the blocks around it, one at a time', async () => {
    // Every letter that folds, then Latin up to Latin Extended-B, Greek, Cyrillic and Latin Extended Additional, so
    // a letter added to one map and not the other shows up here. Not NUL, which no Postgres text holds.
    const letters = [
      ...new Set([
        ...FOLD_FROM,
        ...range(0x01, 0x24f),
        ...range(0x370, 0x4ff),
        ...range(0x1e00, 0x1eff),
      ]),
    ];
    const sqlSide = await foldedBySql(letters);
    const differ = letters.filter((ch, i) => sqlSide[i]!.folded !== fold(ch));
    expect(differ).toEqual([]);
    expect(sqlSide.filter((r) => r.length !== 1)).toEqual([]);
  });

  it('reads nothing as an empty text', async () => {
    const [row] = await asUser(testDbs().api.db, person.claims, (tx) =>
      rows<{ folded: string }>(tx, sql`select private.search_fold(null) as folded`),
    );
    expect(row!.folded).toBe('');
  });

  it('is worked out inline, and skips the map for plain ASCII, so a whole business’s names fold quickly', async () => {
    // A function with a search_path set is never inlined, and the call alone costs more than lower(); `translate`
    // checks each character against the whole map. Over 20,000 names that was over a second, against the quick
    // search's 1.5 s a statement (the plan's Capacity).
    const plan = await asUser(testDbs().api.db, person.claims, (tx) =>
      rows<{ 'QUERY PLAN': string }>(
        tx,
        sql`explain (verbose, costs off)
            select private.search_fold(x.text) from jsonb_array_elements_text('["Dana"]'::jsonb) as x(text)`,
      ),
    );
    const output = plan.map((line) => line['QUERY PLAN']).join('\n');
    expect(output).not.toContain('search_fold');
    expect(output).toMatch(
      /CASE WHEN \(octet_length\(\S+\) = length\(\S+\)\) THEN \S+ ELSE translate\(/,
    );
  });
});

describe('the map', () => {
  it('turns each letter into one plain letter, and names each letter once', () => {
    expect([...FOLD_FROM]).toHaveLength([...FOLD_TO].length);
    expect(new Set(FOLD_FROM).size).toBe([...FOLD_FROM].length);
    expect(FOLD_TO).toMatch(/^[a-zσ]+$/);
  });

  it('folds the letters the plan names, and lower-cases each character on its own', () => {
    expect(fold('José')).toBe('jose');
    expect(fold('ŁÓDŹ')).toBe('lodz');
    expect(fold('Bjørn')).toBe('bjorn');
    expect(fold('Đặng')).toBe('dang');
    expect(fold('Straße')).toBe('strase');
    expect(fold('Æsir')).toBe('asir');
    expect(fold('Œuvre')).toBe('ouvre');
    expect(fold('İstanbul')).toBe('istanbul');
    // Σ is σ wherever it falls, so the word's end doesn't change it.
    expect(fold('ΟΔΟΣ')).toBe(fold('οδος'));
    // A letter outside the map only changes case.
    expect(fold('Иван')).toBe('иван');
  });

  it('never changes the length of any character', () => {
    const changed: string[] = [];
    for (let cp = 1; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (fold(ch).length !== ch.length) changed.push(`U+${cp.toString(16).toUpperCase()}`);
    }
    expect(changed).toEqual([]);
  });
});
