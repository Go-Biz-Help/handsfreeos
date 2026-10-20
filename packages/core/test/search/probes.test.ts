/**
 * What a search looks for (search/probes.ts), with no database: a phone however it's typed, an email, a web
 * address's domain, an amount only when it reads as money, a document number and its counter (after "invoice" too),
 * and nothing at all from punctuation alone, or from a digit or two that every phone holds.
 */
import { describe, expect, it } from 'vitest';
import { documentNumberMatches, documentNumberProbe } from '../../src/money/numbering';
import { foldPattern } from '../../src/search/fold';
import { escapeLike, searchProbes, searchWords } from '../../src/search/probes';

describe('phones', () => {
  it('reads a phone typed four ways as one E.164 number', () => {
    for (const typed of ['(504) 555-0142', '504.555.0142', '+1 504 555 0142', '5045550142']) {
      const p = searchProbes(typed);
      expect(p.phoneE164, typed).toBe('+15045550142');
      expect(p.looksLike, typed).toBe('phone');
      expect(p.number, typed).toBeNull();
    }
  });

  it('keeps a part of a number as digits only', () => {
    const p = searchProbes('555-0142');
    expect(p.phoneE164).toBeNull();
    expect(p.digits).toBe('5550142');
  });

  it('looks for digits only from three on, and only when nothing else was typed', () => {
    expect(searchProbes('12').digits).toBeNull();
    expect(searchProbes('504').digits).toBe('504');
    expect(searchProbes('dana 504').digits).toBeNull();
    expect(searchProbes('1 2 3').digits).toBe('123');
  });

  it('makes no words of a digit or two on their own, which every phone holds, but keeps them beside a word', () => {
    for (const typed of ['+1', '15', '1 2', '#2', '04'])
      expect(searchProbes(typed).words, typed).toEqual([]);
    expect(searchProbes('+1').tooShort).toBe(true);
    expect(searchProbes('1 2').tooShort).toBe(true);
    // Still a document number, and three digits apart are still digits.
    expect(searchProbes('15')).toMatchObject({ tooShort: false, number: { counter: '15' } });
    expect(searchProbes('1 2 3')).toMatchObject({ tooShort: false, words: [] });
    expect(searchProbes('12 oak').words).toEqual(['12', 'oak']);
    expect(searchProbes('+1 504').words).toEqual(['+1', '504']);
  });
});

describe('emails and web addresses', () => {
  it('reads an email, lower-cased', () => {
    const p = searchProbes('Dana.Smith@Gmail.com');
    expect(p.email).toBe('dana.smith@gmail.com');
    expect(p.looksLike).toBe('email');
    expect(p.domain).toBeNull();
  });

  it('reads a web address’s domain, without the www or the page', () => {
    for (const typed of [
      'https://www.gulfcoastrealty.com/about',
      'www.gulfcoastrealty.com',
      'GulfCoastRealty.com',
    ]) {
      const p = searchProbes(typed);
      expect(p.domain, typed).toBe('gulfcoastrealty.com');
      expect(p.looksLike, typed).toBe('domain');
    }
  });
});

describe('amounts', () => {
  it('reads money only with a dollar sign, cents or a thousands comma', () => {
    expect(searchProbes('$1,280').amount).toBe(128_000);
    expect(searchProbes('1,280.00').amount).toBe(128_000);
    expect(searchProbes('$1,280').looksLike).toBe('amount');
    expect(searchProbes('12.50').amount).toBe(1_250);
    expect(searchProbes('1042').amount).toBeNull();
  });
});

describe('document numbers', () => {
  it('gives the number as typed and its counter, read from the end', () => {
    expect(documentNumberProbe('2026-1042')).toEqual({
      text: '2026-1042',
      prefix: '2026-',
      counter: '1042',
    });
    expect(documentNumberProbe('#1042')).toEqual({ text: '1042', prefix: '', counter: '1042' });
    expect(documentNumberProbe('INV-001042')).toEqual({
      text: 'inv-001042',
      prefix: 'inv-',
      counter: '1042',
    });
    expect(documentNumberProbe('LS-0042')).toEqual({
      text: 'ls-0042',
      prefix: 'ls-',
      counter: '42',
    });
    expect(documentNumberProbe('dana smith')).toBeNull();
    expect(documentNumberProbe('dana@x.com')).toBeNull();
  });

  it('reads a number typed after "invoice" or "estimate", as people write one', () => {
    for (const [typed, text] of [
      ['Invoice #2026-1042', '2026-1042'],
      ['invoice 2026-1042', '2026-1042'],
      ['Estimate #LS-0042', 'ls-0042'],
      ['est 388', '388'],
      ['inv. 1042', '1042'],
    ] as const) {
      const p = searchProbes(typed);
      expect(p.number?.text, typed).toBe(text);
      expect(p.looksLike, typed).toBe('number');
    }
    expect(searchProbes('invoice').number).toBeNull();
    expect(searchProbes('dana 1042').number).toBeNull();
    expect(searchProbes('invoice 1042 smith').number).toBeNull();
  });

  it('matches a prefix whatever its punctuation, and never another prefix', () => {
    const ls = documentNumberProbe('LS0042')!;
    expect(documentNumberMatches('LS-0042', ls)).toBe(true);
    expect(documentNumberMatches('ls.42', ls)).toBe(true);
    expect(documentNumberMatches('INV-0042', ls)).toBe(false);
    expect(documentNumberMatches('LS-0042', documentNumberProbe('ls-42')!)).toBe(true);
    expect(documentNumberMatches('INV-001042', documentNumberProbe('1042')!)).toBe(true);
    expect(documentNumberMatches('INV-1042', documentNumberProbe('2026-1042')!)).toBe(false);
  });

  it('is a search’s number probe when one word was typed', () => {
    const p = searchProbes('#1042');
    expect(p.number?.counter).toBe('1042');
    expect(p.looksLike).toBe('number');
    expect(p.card4).toBe(null);
    expect(searchProbes('1042').card4).toBe('1042');
  });
});

describe('words', () => {
  it('keeps only words with a letter or a digit, so "--" and "@@" are too short', () => {
    for (const typed of ['--', '@@', '1', 'a', '', '  ']) {
      const p = searchProbes(typed);
      expect(p.tooShort, typed).toBe(true);
    }
    expect(searchProbes('--').words).toEqual([]);
    expect(searchProbes('@@').words).toEqual([]);
    expect(searchProbes('jo').tooShort).toBe(false);
  });

  it('folds, lower-cases and trims what surrounds a word, and escapes LIKE’s own characters', () => {
    const p = searchProbes('“José”, SMITH 50%_off');
    expect(p.words).toEqual(['josé', 'smith', '50%_off']);
    expect(p.folded).toEqual(['jose', 'smith', '50%_off']);
    expect(p.likes).toEqual(['%josé%', '%smith%', '%50\\%\\_off%']);
    expect(p.folds).toEqual(['%jose%', '%smith%', '%50\\%\\_off%']);
    expect(p.starts).toEqual(['% jose%', '% smith%', '% 50\\%\\_off%']);
    expect(p.firstWord).toBe('jose');
  });

  it('escapes a backslash too', () => {
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });
});

describe('the words inside a file (Search 5)', () => {
  it('splits a text as a file’s words are kept: folded, punctuation a space, digits without leading zeros', () => {
    expect(searchWords('INV-001042')).toBe('inv 1042');
    expect(searchWords('(504) 555-0142')).toBe(' 504 555 142');
    expect(searchWords('dana.smith@gmail.com')).toBe('dana smith gmail com');
    expect(searchWords('www.GulfCoastRealty.com')).toBe('www gulfcoastrealty com');
    expect(searchWords('José’s 007 0 00 x²')).toBe('jose s 7 0 0 x ');
  });

  it('asks a file for every word as a prefix, split the same way, and never holds an operator', () => {
    expect(searchProbes('dana smith').tsq).toBe('dana:* & smith:*');
    expect(searchProbes('INV-001042').tsq).toBe('inv:* & 1042:*');
    expect(searchProbes('555-0142').tsq).toBe('555:* & 142:*');
    expect(searchProbes('José').tsq).toBe('jose:*');
    // A word twice, or twice once split, is asked for once.
    expect(searchProbes('smith smith.smith').tsq).toBe('smith:*');
    for (const typed of [
      "o'brien & (co) | !x <-> y:* 'z'",
      '50%_off \\ "quoted" a:b',
      '«résumé» — ½ ¼',
    ]) {
      const tsq = searchProbes(typed).tsq!;
      expect(tsq, typed).toMatch(/^[\p{L}\p{Nd}]+:\*( & [\p{L}\p{Nd}]+:\*)*$/u);
    }
    // Nothing to ask for: no words, or a digit or two alone.
    expect(searchProbes('--').tsq).toBeNull();
    expect(searchProbes('12').tsq).toBeNull();
  });

  it('finds a word in a file’s words as fold would, without folding them', () => {
    // Each letter a bracket of itself and every letter that folds to it; the database runs it (fold.test.ts).
    expect(foldPattern('jose')).toMatch(
      /^\[jĴĵǰ\]\[o[^\]]*Ö[^\]]*\]\[s[^\]]*\]\[e[^\]]*é[^\]]*\]$/,
    );
    expect(foldPattern('1042')).toBe('1042');
    expect(foldPattern('a.b')).toMatch(/\\\.\[b/);
  });
});
