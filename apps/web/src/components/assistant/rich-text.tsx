import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The only links an answer may carry: pages in this app (the same rule as the cards' hrefs). */
const APP_PATH = /^\/app\/w\/[0-9a-f-]{36}(\/[A-Za-z0-9_\-/?=&.]*)?$/;

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] };

/** Paragraphs, and runs of "- " or "1. " lines as lists. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push({ kind: 'p', lines: paragraph });
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
    if (last && last.kind === kind) last.items.push(item);
    else out.push({ kind, items: [item] });
  }
  flush();
  return out;
}

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** **bold** and [links](/app/w/…); a link anywhere else shows as its words only. */
function inline(text: string, onNavigate?: (href: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined)
      out.push(
        <strong key={key++} className="font-semibold">
          {m[1]}
        </strong>,
      );
    else if (APP_PATH.test(m[3]!))
      out.push(
        <Link
          key={key++}
          href={m[3]!}
          onClick={() => onNavigate?.(m[3]!)}
          className="font-medium text-accent-text hover:underline"
        >
          {m[2]}
        </Link>,
      );
    else out.push(m[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** An answer's words with light formatting, and the typing caret while it streams in. */
export function RichText({
  text,
  caret,
  onNavigate,
}: {
  text: string;
  caret?: boolean;
  onNavigate?: (href: string) => void;
}) {
  const list = blocks(text);
  const caretMark = caret ? <span className="assistant-caret" aria-hidden /> : null;
  return (
    <div className="flex flex-col gap-2 [overflow-wrap:anywhere]" data-testid="assistant-text">
      {list.map((b, i) => {
        const tail = i === list.length - 1 ? caretMark : null;
        if (b.kind === 'p')
          return (
            <p key={i}>
              {b.lines.map((line, j) => (
                <Fragment key={j}>
                  {j ? <br /> : null}
                  {inline(line, onNavigate)}
                </Fragment>
              ))}
              {tail}
            </p>
          );
        const List = b.kind;
        return (
          <List
            key={i}
            className={cn(
              'm-0 flex flex-col gap-1 pl-5',
              b.kind === 'ul' ? 'list-disc' : 'list-decimal',
            )}
          >
            {b.items.map((item, j) => (
              <li key={j}>
                {inline(item, onNavigate)}
                {j === b.items.length - 1 ? tail : null}
              </li>
            ))}
          </List>
        );
      })}
      {list.length === 0 ? caretMark : null}
    </div>
  );
}
