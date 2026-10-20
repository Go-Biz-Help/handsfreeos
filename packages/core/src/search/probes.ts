/**
 * What a search looks for, worked out once from what was typed (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "The
 * searchers"): the words, and whether it reads as a phone, an email, a web address, a document number or an amount.
 * Browser-safe, so the server, the web and the phone read a search the same way, and an add-on gets these rather than
 * the raw text to parse.
 */
import type { CountryCode } from 'libphonenumber-js';
import { normalizePhone } from '../crm/phone';
import { parseMoney } from '../money/format';
import { documentNumberProbe, type DocumentNumberProbe } from '../money/numbering';
import { fold } from './fold';

/** Fewer characters than this is too short to search. */
export const SEARCH_MIN_CHARS = 2;
/** Typed digits are looked for inside numbers only from this many on, as the inbox does. */
export const SEARCH_MIN_DIGITS = 3;

export type SearchLooksLike = 'phone' | 'email' | 'domain' | 'number' | 'amount' | 'words';

export interface SearchProbes {
  /** What was typed, trimmed. */
  readonly q: string;
  /** Under 2 characters, or nothing with a letter or a digit in it: answered empty, with no SQL. */
  readonly tooShort: boolean;
  readonly looksLike: SearchLooksLike;
  /**
   * The words, lower-cased: only those holding a letter or a digit, and none when every one is a digit or two
   * ("+1", "15").
   */
  readonly words: readonly string[];
  /** The same words folded (search/fold.ts). */
  readonly folded: readonly string[];
  /** `%word%` patterns of `words`, LIKE's wildcards escaped (`$likes`). */
  readonly likes: readonly string[];
  /** `%word%` patterns of `folded` (`$folds`). */
  readonly folds: readonly string[];
  /** `% word%` patterns of `folded`, matched against `' ' || private.search_fold(name)` (`$starts`). */
  readonly starts: readonly string[];
  /** A phone however it was typed, in E.164. */
  readonly phoneE164: string | null;
  /** An email, lower-cased. */
  readonly email: string | null;
  /** A web address's domain without `www.` (`gulfcoastrealty.com`), when that is all that was typed. */
  readonly domain: string | null;
  /** 3 or more digits, when only digits and a phone's punctuation were typed. */
  readonly digits: string | null;
  /** A document number: one word, or one after "invoice", "estimate", "inv" or "est". */
  readonly number: DocumentNumberProbe | null;
  /** An amount in cents, only when the text reads as money ("$1,280", "1,280.00"). */
  readonly amount: number | null;
  /** Four digits on their own: a card's last 4. */
  readonly card4: string | null;
  /** The first folded word, where a snippet is cut. */
  readonly firstWord: string | null;
}

/** A text with LIKE's own characters escaped, so "50%_off" matches only itself. Backslash is LIKE's escape. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Quotes, brackets and the punctuation that ends a sentence, trimmed off a word's ends. */
const EDGES = /^[\s"'“”‘’`.,;:!?()[\]{}<>#]+|[\s"'“”‘’`.,;:!?()[\]{}<>]+$/g;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const PHONE_CHARACTERS = /^[\d\s().+-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN =
  /^(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?:[/?#].*)?$/i;
/** "Invoice", "estimate", "inv" or "est" before a number, as people write one: "Invoice #1042", "est 388". */
const DOCUMENT_NOUN = /^(?:invoice|estimate|inv|est)\.?\s+(?=\S+$)/i;
/** Money: a dollar sign, cents, or a thousands comma. A bare whole number is never an amount. */
const READS_AS_MONEY = /^\$\s*[\d,]+(\.\d{1,2})?$|^\d{1,3}(,\d{3})+(\.\d{1,2})?$|^\d+\.\d{1,2}$/;

/** What a search looks for. `country` reads a phone typed without its country code. */
export function searchProbes(typed: string, opts: { country?: CountryCode } = {}): SearchProbes {
  const q = (typed ?? '').trim();
  const typedWords = [
    ...new Set(
      q
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(EDGES, ''))
        .filter((w) => HAS_LETTER_OR_DIGIT.test(w)),
    ),
  ];
  // One or two digits on their own ("+1", "15", "1 2") would match nearly every phone through the E.164 numbers the
  // records' search text holds, so they're no words at all; beside a word like "oak" they still narrow it.
  const words = typedWords.every(fewDigits) ? [] : typedWords;
  const folded = words.map(fold);
  const onlyPhoneCharacters = PHONE_CHARACTERS.test(q);
  const allDigits = q.replace(/\D/g, '');
  const phoneE164 =
    onlyPhoneCharacters && allDigits.length >= 7 ? normalizePhone(q, opts.country ?? 'US') : null;
  const email = EMAIL.test(q) ? q.toLowerCase() : null;
  const domain = !email && !/\s/.test(q) ? (DOMAIN.exec(q)?.[1]?.toLowerCase() ?? null) : null;
  const digits = onlyPhoneCharacters && allDigits.length >= SEARCH_MIN_DIGITS ? allDigits : null;
  const amount = READS_AS_MONEY.test(q) ? parseMoney(q) : null;
  // A number is one word, or one word after "invoice" or "estimate".
  const numberText = q.replace(DOCUMENT_NOUN, '');
  const number =
    !/\s/.test(numberText) && !phoneE164 && amount === null
      ? documentNumberProbe(numberText)
      : null;
  const card4 = /^\d{4}$/.test(q) ? q : null;
  const looksLike: SearchLooksLike = phoneE164
    ? 'phone'
    : email
      ? 'email'
      : domain
        ? 'domain'
        : amount !== null
          ? 'amount'
          : number
            ? 'number'
            : 'words';
  const tooShort =
    q.length < SEARCH_MIN_CHARS ||
    (words.length === 0 && !phoneE164 && !email && !number && !digits);
  return {
    q,
    tooShort,
    looksLike,
    words,
    folded,
    likes: words.map((w) => `%${escapeLike(w)}%`),
    folds: folded.map((w) => `%${escapeLike(w)}%`),
    starts: folded.map((w) => `% ${escapeLike(w)}%`),
    phoneE164,
    email,
    domain,
    digits,
    number,
    amount,
    card4,
    firstWord: folded[0] ?? null,
  };
}

/** A word with no letter and fewer than 3 digits: "+1", "15", "#2". */
function fewDigits(word: string): boolean {
  return !/\p{L}/u.test(word) && word.replace(/\D/g, '').length < SEARCH_MIN_DIGITS;
}

/** The probes as `search.everything` answers them, for the screens' "Exact match" and "Also has 1042 in it". */
export function probesOut(p: SearchProbes): {
  looksLike: SearchLooksLike;
  phoneE164: string | null;
  email: string | null;
  number: string | null;
} {
  return {
    looksLike: p.looksLike,
    phoneE164: p.phoneE164,
    email: p.email,
    number: p.number?.text ?? null,
  };
}
