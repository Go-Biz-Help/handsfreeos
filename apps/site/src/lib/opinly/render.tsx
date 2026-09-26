/**
 * A post body, from Opinly's Tiptap JSON to React elements.
 *
 * Written here rather than pulled in from `@opinly/react` because the few places we differ from it are the
 * places a marketing site cares about:
 *
 * - **One `<h1>` per page.** The post's title is the page's `<h1>`, so a body that starts its own headings at
 *   level 1 is shifted down a level. Every heading gets an id, so the contents list and shared links can jump
 *   to it.
 * - **Links we can follow.** Opinly marks every link `nofollow` unless told otherwise; a link to our own pages
 *   is internal linking, not a vote for a stranger, so it goes out as a plain `next/link`. Anything with a
 *   scheme that is not http(s), mailto or tel is dropped and its text kept.
 * - **Readable in both themes.** A text colour chosen on a white editor is unreadable on the dark page, so
 *   colour marks keep their text and lose the colour.
 * - **Valid HTML.** A picture inside a paragraph stays a plain `<img>`; only a picture that stands on its own
 *   gets a `<figure>` and caption. A `<figure>` inside a `<p>` is broken markup and a hydration error.
 *
 * Unknown nodes render their children, and unknown marks their text, so a new Opinly feature degrades to
 * plain words rather than a missing paragraph.
 */
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { urls } from '@/content/site';
import { imageUrl } from './paths';
import type { OpinlyMark, OpinlyNode } from './types';

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SITE_HOST = new URL(urls.site).host;

const text = (node: OpinlyNode): string => node.text ?? node.content?.map(text).join('') ?? '';

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const int = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 1 ? n : undefined;
};

/** Whether the body uses level-1 headings, in which case every heading moves down one. */
const headingShift = (doc: OpinlyNode): number => {
  const walk = (n: OpinlyNode): boolean =>
    (n.type === 'heading' && (n.attrs?.['level'] ?? 1) === 1) || (n.content ?? []).some(walk);
  return walk(doc) ? 1 : 0;
};

const levelOf = (node: OpinlyNode, shift: number): 2 | 3 | 4 | 5 | 6 => {
  const raw = Number(node.attrs?.['level'] ?? 2);
  const level = Math.min(6, Math.max(2, (Number.isFinite(raw) ? raw : 2) + shift));
  return level as 2 | 3 | 4 | 5 | 6;
};

export interface Heading {
  readonly id: string;
  readonly text: string;
  readonly level: 2 | 3 | 4 | 5 | 6;
}

/**
 * Every heading in reading order, with the id `PostBody` gives it. Duplicates get `-2`, `-3`… in the same order
 * the body assigns them, so the contents list and the headings always agree.
 */
export function extractHeadings(doc: OpinlyNode): Heading[] {
  const shift = headingShift(doc);
  const seen = new Map<string, number>();
  const out: Heading[] = [];
  const walk = (node: OpinlyNode) => {
    if (node.type === 'heading') {
      const label = text(node).trim();
      out.push({ id: uniqueId(label, seen), text: label, level: levelOf(node, shift) });
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

function uniqueId(label: string, seen: Map<string, number>): string {
  const base = slugify(label) || 'section';
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}

export function wordCount(doc: OpinlyNode): number {
  let words = 0;
  const walk = (node: OpinlyNode) => {
    if (node.text) words += node.text.trim().split(/\s+/).filter(Boolean).length;
    node.content?.forEach(walk);
  };
  walk(doc);
  return words;
}

/** Minutes to read, at 200 words a minute, never less than one. */
export const readingMinutes = (doc: OpinlyNode): number =>
  Math.max(1, Math.ceil(wordCount(doc) / 200));

interface Ctx {
  readonly shift: number;
  readonly seen: Map<string, number>;
}

/** A link that points back at this site, by path or by our own host. */
function internalPath(href: string): string | null {
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  if (href.startsWith('#')) return href;
  try {
    const u = new URL(href);
    if (u.host === SITE_HOST || u.host === `www.${SITE_HOST}`)
      return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    // Not an absolute address; handled below as relative.
  }
  return null;
}

function renderLink(mark: OpinlyMark, child: ReactNode, key: string): ReactNode {
  const href = str(mark.attrs?.['href'])?.trim();
  if (!href) return child;
  if (ANY_SCHEME.test(href) && !SAFE_SCHEME.test(href)) return child;

  const local = internalPath(href);
  if (local) {
    return (
      <Link key={key} href={local}>
        {child}
      </Link>
    );
  }
  const target = str(mark.attrs?.['target']);
  const rel = new Set((str(mark.attrs?.['rel']) ?? 'nofollow').split(/\s+/).filter(Boolean));
  if (target === '_blank') rel.add('noopener');
  return (
    <a key={key} href={href} target={target} rel={[...rel].join(' ')}>
      {child}
    </a>
  );
}

function renderMark(mark: OpinlyMark, child: ReactNode, key: string): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong key={key}>{child}</strong>;
    case 'italic':
      return <em key={key}>{child}</em>;
    case 'strike':
      return <s key={key}>{child}</s>;
    case 'underline':
      return <u key={key}>{child}</u>;
    case 'code':
      return <code key={key}>{child}</code>;
    case 'highlight':
      return <mark key={key}>{child}</mark>;
    case 'subscript':
      return <sub key={key}>{child}</sub>;
    case 'superscript':
      return <sup key={key}>{child}</sup>;
    case 'link':
      return renderLink(mark, child, key);
    default:
      // textStyle (colour) and anything newer: the words, without the styling.
      return child;
  }
}

function renderImage(node: OpinlyNode, key: string, inline: boolean): ReactNode {
  const src = imageUrl(str(node.attrs?.['fileKey']) ?? str(node.attrs?.['src']));
  if (!src) return null;
  const alt = str(node.attrs?.['alt']) ?? '';
  const title = str(node.attrs?.['title']);
  const caption = str(node.attrs?.['caption']);
  // A plain <img>: the body's pictures come in any size, and Opinly's CDN already serves them sized for the web.
  const img = <img src={src} alt={alt} title={title} loading="lazy" decoding="async" />;
  if (inline) return <span key={key}>{img}</span>;
  return (
    <figure key={key}>
      {img}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function renderChildren(node: OpinlyNode, ctx: Ctx, key: string, inline: boolean): ReactNode[] {
  return (node.content ?? []).map((child, i) => renderNode(child, ctx, `${key}.${i}`, inline));
}

function renderNode(node: OpinlyNode, ctx: Ctx, key: string, inline: boolean): ReactNode {
  if (node.type === 'text' || node.text !== undefined) {
    let el: ReactNode = node.text ?? '';
    (node.marks ?? []).forEach((mark, i) => {
      el = renderMark(mark, el, `${key}.m${i}`);
    });
    return <Fragment key={key}>{el}</Fragment>;
  }

  const kids = (asInline = inline) => renderChildren(node, ctx, key, asInline);

  switch (node.type) {
    case 'doc':
      return kids();
    case 'paragraph':
      return <p key={key}>{kids(true)}</p>;
    case 'heading': {
      const Tag = `h${levelOf(node, ctx.shift)}` as const;
      return (
        <Tag key={key} id={uniqueId(text(node).trim(), ctx.seen)}>
          {kids(true)}
        </Tag>
      );
    }
    case 'bulletList':
      return <ul key={key}>{kids(false)}</ul>;
    case 'orderedList': {
      const start = int(node.attrs?.['start']);
      return (
        <ol key={key} start={start}>
          {kids(false)}
        </ol>
      );
    }
    case 'listItem':
      return <li key={key}>{kids(false)}</li>;
    case 'blockquote':
      return <blockquote key={key}>{kids(false)}</blockquote>;
    case 'codeBlock': {
      const language = str(node.attrs?.['language']);
      return (
        <pre key={key}>
          <code className={language ? `language-${language}` : undefined}>{text(node)}</code>
        </pre>
      );
    }
    case 'horizontalRule':
      return <hr key={key} />;
    case 'hardBreak':
      return <br key={key} />;
    case 'image':
      return renderImage(node, key, inline);
    case 'table':
      // Wide tables scroll on their own rather than pushing the whole page sideways on a phone.
      return (
        <div key={key} className="post-table">
          <table>
            <tbody>{kids(false)}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr key={key}>{kids(false)}</tr>;
    case 'tableHeader':
      return (
        <th
          key={key}
          scope="col"
          colSpan={int(node.attrs?.['colspan'])}
          rowSpan={int(node.attrs?.['rowspan'])}
        >
          {kids(false)}
        </th>
      );
    case 'tableCell':
      return (
        <td key={key} colSpan={int(node.attrs?.['colspan'])} rowSpan={int(node.attrs?.['rowspan'])}>
          {kids(false)}
        </td>
      );
    default:
      return <Fragment key={key}>{kids()}</Fragment>;
  }
}

/** The post body. Styled by `.post-body` in globals.css. */
export function PostBody({ content }: { content: OpinlyNode }) {
  const ctx: Ctx = { shift: headingShift(content), seen: new Map() };
  const top = content.type === 'doc' || !content.type ? (content.content ?? []) : [content];
  return (
    <div className="post-body">{top.map((node, i) => renderNode(node, ctx, `${i}`, false))}</div>
  );
}
