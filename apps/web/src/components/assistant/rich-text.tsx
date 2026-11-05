import { answerBlocks, answerParts, type AnswerPart } from '@hfos/core';
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const LINK = 'font-medium text-accent-text underline underline-offset-2 hover:no-underline';

/**
 * A line's **bold** and links (core's `answerParts`): a page in the app opens in place; a web or email address
 * opens outside, a page in a new tab with no referrer, with the site after words that don't say where it goes.
 */
function inline(text: string, onNavigate?: (href: string) => void): ReactNode[] {
  return answerParts(text).map((p: AnswerPart, i) => {
    const words = p.bold ? <strong className="font-semibold">{p.text}</strong> : p.text;
    if (!p.href) return <Fragment key={i}>{words}</Fragment>;
    if (p.inApp)
      return (
        <Link
          key={i}
          href={p.href}
          onClick={() => onNavigate?.(p.href!)}
          className="font-medium text-accent-text hover:underline"
        >
          {words}
        </Link>
      );
    return (
      <Fragment key={i}>
        <a
          href={p.href}
          {...(p.href.startsWith('mailto:')
            ? {}
            : { target: '_blank', rel: 'noopener noreferrer nofollow' })}
          className={LINK}
          data-testid="assistant-link"
        >
          {words}
        </a>
        {p.site ? <span className="text-text-3"> ({p.site})</span> : null}
      </Fragment>
    );
  });
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
  const list = answerBlocks(text);
  const caretMark = caret ? <span className="assistant-caret" aria-hidden /> : null;
  return (
    <div
      className="flex select-text flex-col gap-2 [overflow-wrap:anywhere]"
      data-testid="assistant-text"
    >
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
