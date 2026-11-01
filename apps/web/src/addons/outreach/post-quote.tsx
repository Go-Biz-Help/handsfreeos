'use client';
/**
 * The post above a comment, on Today and in Waiting for you (decision 141): its first words, and when HandsFreeOS cut
 * them short, **More** right after them, which shows the whole post in place; **Less** folds it back. A server from
 * before it sends no whole post, and the start shows alone, as it did.
 */
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { useState } from 'react';

export function PostQuote({
  post,
  whole,
  posted,
  testId,
}: {
  /** The post's first words, as HandsFreeOS cut them. */
  post: string;
  /** The whole post, when `post` is cut short. */
  whole?: string | null;
  /** When the network said it was posted, after it. */
  posted?: string | null;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const more = !!whole && whole !== post;
  return (
    <blockquote
      className="mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] text-text-2"
      data-testid={testId}
    >
      <span data-testid={`${testId}-text`}>{open && more ? whole : post}</span>
      {posted ? <span className="text-text-3"> · {posted}</span> : null}
      {more ? (
        <>
          {' '}
          <button
            type="button"
            className="font-medium text-accent-text hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            data-testid={`${testId}-more`}
          >
            {open ? W.postLess : W.postMore}
          </button>
        </>
      ) : null}
    </blockquote>
  );
}
