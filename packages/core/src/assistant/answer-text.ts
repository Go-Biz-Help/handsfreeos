/**
 * An Assistant answer's words, as the web and the phone show them and copy them, from this one copy: paragraphs,
 * "- " and "1. " lists, **bold**, and links to press.
 *
 * - **Links:** each web address and email address in an answer is one to press, by the same rules as a call's chat
 *   (`meetings/chat-links.ts`), and opens outside HandsFreeOS. `[words](/app/w/…)` opens that page in the app.
 *   `[words](https://…)` shows its words, then the site's name when the words don't say where it goes, so a link
 *   can't pass for another. Any other `[words](…)` shows its words only.
 * - **Copying:** `answerCopyText` is what Copy takes: the words without the marks, each list item on its own line,
 *   and each outside link's address.
 */
import { chatLinkHref, chatLinkParts } from '../meetings/chat-links';

/** A paragraph's lines, or a list's items. */
export type AnswerBlock =
  | { readonly kind: 'p'; readonly lines: readonly string[] }
  | { readonly kind: 'ul' | 'ol'; readonly items: readonly string[] };

/** A run of a line: plain or bold, and maybe a link. Joined, the parts' text is what shows. */
export interface AnswerPart {
  readonly text: string;
  readonly bold?: boolean;
  /** Where it goes: a page in HandsFreeOS, an http(s) page, or a `mailto:`. */
  readonly href?: string;
  /** A page in HandsFreeOS (`/app/w/…`), opened in place. */
  readonly inApp?: boolean;
  /** Shown after the link's words when they don't say where it goes: the site, like "handsfreeos.com". */
  readonly site?: string;
}

/** The only in-app pages an answer may link to: one business's pages (the same rule as the cards' links). */
const APP_PATH = /^\/app\/w\/[0-9a-f-]{36}(\/[A-Za-z0-9_\-/?=&.]*)?$/;

/** Paragraphs, and runs of "- " or "1. " lines as lists. */
export function answerBlocks(text: string): AnswerBlock[] {
  const out: { kind: 'p' | 'ul' | 'ol'; rows: string[] }[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push({ kind: 'p', rows: paragraph });
    paragraph = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    const numbered = bullet ? null : /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!bullet && !numbered) {
      paragraph.push(line);
      continue;
    }
    flush();
    const kind = bullet ? 'ul' : 'ol';
    const item = (bullet ?? numbered)![1]!;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.rows.push(item);
    else out.push({ kind, rows: [item] });
  }
  flush();
  return out.map((b) =>
    b.kind === 'p' ? { kind: 'p', lines: b.rows } : { kind: b.kind, items: b.rows },
  );
}

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** The address as people write it: no `https://`, `www.` or `mailto:`, no slash at the end, in lower case. */
function bare(address: string): string {
  return address
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/|mailto:)/, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

/** A `[words](href)` link: its words, and where it goes when that's somewhere an answer may send them. */
function wordsLink(words: string, raw: string): AnswerPart[] {
  if (APP_PATH.test(raw)) return [{ text: words, href: raw, inApp: true }];
  const href = chatLinkHref(raw);
  if (!href) return [{ text: words }];
  const where = bare(href);
  const site = href.startsWith('mailto:') ? where : where.split(/[/?#]/)[0]!;
  return [{ text: words, href, ...(bare(words).includes(site) ? {} : { site }) }];
}

/** Plain words, with each web and email address in them a link. */
function plain(text: string, bold: boolean): AnswerPart[] {
  return chatLinkParts(text).map((p) => ({
    text: p.text,
    ...(bold ? { bold } : {}),
    ...(p.href ? { href: p.href } : {}),
  }));
}

/** One line (or list item) of an answer as its parts: plain, **bold** and links. */
export function answerParts(line: string): AnswerPart[] {
  const out: AnswerPart[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index > last) out.push(...plain(line.slice(last, m.index), false));
    if (m[1] !== undefined) out.push(...plain(m[1], true));
    else out.push(...wordsLink(m[2]!, m[3]!));
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(...plain(line.slice(last), false));
  return out;
}

/** A line as copied: its words without the marks, and an outside link's address after words that don't say it. */
function copyLine(line: string): string {
  return answerParts(line)
    .map((p) => (p.site && p.href ? `${p.text} (${p.href.replace(/^mailto:/, '')})` : p.text))
    .join('');
}

/** What Copy takes from an answer: plain text, with the addresses its links go to. */
export function answerCopyText(text: string): string {
  return answerBlocks(text)
    .map((b) =>
      b.kind === 'p'
        ? b.lines.map(copyLine).join('\n')
        : b.items
            .map((item, i) => `${b.kind === 'ul' ? '•' : `${i + 1}.`} ${copyLine(item)}`)
            .join('\n'),
    )
    .join('\n\n');
}
