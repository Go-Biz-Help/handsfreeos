/**
 * Folding accents (search/fold.ts) on the local database: core's `fold` and `private.search_fold` give the same
 * text, letter for letter, so the server finds and marks what the phone would. Each letter folds to one letter, so
 * the length never changes and a mark found in the folded text fits the original. And the database's stays cheap
 * enough to run on every name of a business.
 *
 * Then the words inside files (Search 5): core's `searchWords` and `private.search_words` split a text alike, so the
 * query core builds (`tsq`, asked as the Files searcher asks it) finds the words the database keeps for a file, model
 * numbers Postgres splits in two included; `foldPattern` finds a word where the folded text has it, without folding
 * the text; and `termPattern` only where a word starts.
 */
import { asUser, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fold, FOLD_FROM, FOLD_TO, foldPattern } from '../../src/search/fold';
import { searchProbes, searchWords } from '../../src/search/probes';
import { termPattern, wordsQuery } from '../../src/search/server/kinds/files';

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

/** Each text split by the database, as a signed-in person runs it. */
async function wordsBySql(texts: readonly string[]): Promise<string[]> {
  const out = await asUser(testDbs().api.db, person.claims, (tx) =>
    rows<{ words: string }>(
      tx,
      sql`select private.search_words(x.text) as words
          from jsonb_array_elements_text(${JSON.stringify(texts)}::jsonb) with ordinality as x(text, n)
          order by x.n`,
    ),
  );
  return out.map((r) => r.words);
}

/** What a file's words read for search look like besides the corpus: punctuation, numbers and curly quotes. */
const FILE_CORPUS = [
  ...CORPUS,
  'Invoice INV-001042 for 007 Bond St.',
  '“Quoted,” she said — it’s 50% off… (really!)',
  'x² ½ Ⅻ ①',
  'tab\there\nnew line',
  '0 00 000 0042 10 100',
  // Postgres's parser splits these, 65e8 and m, 12e3 and e4: never a phrase.
  'Samsung TV model 65E8M, serial 4E2A1B, 3E8F 10E5A 12e3e4 1e2e3',
];

describe('core’s searchWords and the database’s', () => {
  it('split the corpus alike', async () => {
    const sqlSide = await wordsBySql(FILE_CORPUS);
    FILE_CORPUS.forEach((text, i) => expect(sqlSide[i], text).toBe(searchWords(text)));
  });

  it('agree on every character of Latin, Greek, Cyrillic, punctuation and number forms, one at a time', async () => {
    const chars = [
      ...range(0x01, 0x24f),
      ...range(0x370, 0x4ff),
      ...range(0x1e00, 0x1eff),
      ...range(0x2000, 0x218f),
    ];
    const sqlSide = await wordsBySql(chars);
    expect(chars.filter((ch, i) => sqlSide[i] !== searchWords(ch))).toEqual([]);
  });

  it('find the words the database keeps for a text with the query core builds from it', async () => {
    const texts = FILE_CORPUS.filter((t) => searchProbes(t).tsq);
    const found = await asUser(testDbs().api.db, person.claims, (tx) =>
      rows<{ hit: boolean }>(
        tx,
        sql`select strip(to_tsvector('simple'::regconfig, private.search_words(x.e ->> 'text')))
                @@ ${wordsQuery(sql`x.e ->> 'tsq'`)} as hit
            from jsonb_array_elements(${JSON.stringify(
              texts.map((text) => ({ text, tsq: searchProbes(text).tsq })),
            )}::jsonb) with ordinality as x(e, n)
            order by x.n`,
      ),
    );
    expect(texts.filter((_, i) => !found[i]!.hit)).toEqual([]);
    // A typed part of a number, or a word inside an address, finds them too.
    const parts = await asUser(testDbs().api.db, person.claims, (tx) =>
      rows<{ hit: boolean }>(
        tx,
        sql`select strip(to_tsvector('simple'::regconfig, private.search_words(x.e ->> 'text')))
                @@ ${wordsQuery(sql`x.e ->> 'tsq'`)} as hit
            from jsonb_array_elements(${JSON.stringify(
              [
                ['Invoice INV-001042 for 007 Bond St.', '1042'],
                ['(504) 555-0142 +1 504 555 0142', '0142'],
                ['dana.smith@gmail.com DANA.SMITH@GMAIL.COM', 'smith'],
                ['https://www.GulfCoastRealty.com/about', 'gulfcoast'],
                ['José García', 'jose garc'],
                ['Samsung TV model 65E8M', '65E8M'],
                ['Serial 4E2A1B on the back', '4e2a1b'],
                ['Serial 4E2A1B on the back', '4e2a'],
              ].map(([text, q]) => ({ text, tsq: searchProbes(q!).tsq })),
            )}::jsonb) with ordinality as x(e, n)
            order by x.n`,
      ),
    );
    expect(parts.map((r) => r.hit)).toEqual([true, true, true, true, true, true, true, true]);
  });

  it('find a word with foldPattern exactly where the folded text holds it', async () => {
    const cases = [
      ['Bill to: JOSÉ García, Łódź', 'jose'],
      ['Bill to: JOSÉ García, Łódź', 'lodz'],
      ['Straße 5, ΟΔΟΣ', 'strase'],
      ['Straße 5, ΟΔΟΣ', 'οδοσ'],
      ['nothing here', 'jose'],
      ['Invoice INV-001042', '1042'],
    ] as const;
    const out = await asUser(testDbs().api.db, person.claims, (tx) =>
      rows<{ at: number; folded: number }>(
        tx,
        sql`select regexp_instr(x.e ->> 'text', x.e ->> 'pattern', 1, 1, 0, 'i') as at,
                   strpos(private.search_fold(x.e ->> 'text'), x.e ->> 'word') as folded
            from jsonb_array_elements(${JSON.stringify(
              cases.map(([text, word]) => ({ text, word, pattern: foldPattern(word) })),
            )}::jsonb) with ordinality as x(e, n)
            order by x.n`,
      ),
    );
    expect(out.map((r) => Number(r.at))).toEqual(out.map((r) => Number(r.folded)));
    expect(out.map((r) => Number(r.at))).toEqual([10, 23, 1, 11, 0, 15]);
  });

  it('find a word with termPattern only where a word starts, a number past its leading zeros', async () => {
    const cases = [
      ['Latest contest. Page two: test cock', 'test', 27],
      ['Call (504) 555-0142', '142', 16],
      ['Invoice INV-001042', '1042', 13],
      ['Bill to: JOSÉ García', 'jose', 10],
      ['Model 65E8M', '65e8m', 7],
      ['Dr. Patel, Andrew', 'dr', 1],
      ['Andrew, Dr. Patel', 'dr', 9],
      ['Ladder', 'dd', 0],
    ] as const;
    const out = await asUser(testDbs().api.db, person.claims, (tx) =>
      rows<{ at: number }>(
        tx,
        sql`select regexp_instr(x.e ->> 'text', x.e ->> 'pattern', 1, 1, 0, 'i') as at
            from jsonb_array_elements(${JSON.stringify(
              cases.map(([text, term]) => ({ text, pattern: termPattern(term) })),
            )}::jsonb) with ordinality as x(e, n)
            order by x.n`,
      ),
    );
    expect(out.map((r) => Number(r.at))).toEqual(cases.map((c) => c[2]));
  });
});
