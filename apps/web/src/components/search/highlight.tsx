'use client';
import { marksIn, type SearchProbes } from '@hfos/core';
import type { ReactNode } from 'react';

/**
 * A stretch of text with the places a search matched, as Search everything's boards draw them: the text as text, and
 * each match inside `<mark>`. Never `dangerouslySetInnerHTML`, so a message holding "<" or a script shows as typed.
 * The marks are `[start, end)` ranges into the text, from the server's snippet or from core's `marksIn`.
 */
export function Highlight({
  text,
  marks,
}: {
  text: string;
  marks: readonly (readonly [number, number])[];
}) {
  if (!marks.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  marks.forEach(([start, end], i) => {
    // A range that doesn't fit the text (an older answer for a longer text) marks nothing rather than breaking it.
    if (start < at || end > text.length || end <= start) return;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={i} className="rounded-[3px] bg-accent-soft-2 px-px font-semibold text-text">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A title or a grey line marked where the typed words, digits or email sit in it (core's `marksIn`, folded). */
export function Marked({ text, probes }: { text: string; probes: SearchProbes }) {
  return <Highlight text={text} marks={marksIn(text, probes)} />;
}
