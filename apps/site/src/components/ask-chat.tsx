'use client';

import type { ReactNode } from 'react';

/**
 * A button that opens the chat in the corner (components/support-chat.tsx), which HandsFreeOS's own team answers.
 *
 * The chat's loader opens its window when the address changes to #hfos-chat (apps/web/src/lib/chat/loader.ts listens
 * for hashchange). A Next.js <Link> changes the address without that event, so this is a plain link, and a second
 * press clears the hash first so the event fires again. The page always shows the email beside it, for when the
 * chat isn't loaded.
 */
export function AskChat({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <a
      href="#hfos-chat"
      onClick={(event) => {
        event.preventDefault();
        history.replaceState(null, '', `${location.pathname}${location.search}`);
        location.hash = 'hfos-chat';
      }}
      className={`group/button bg-accent hover:bg-accent-hover inline-flex items-center justify-center gap-2 rounded-[10px] px-6 py-3.5 text-[1.0625rem] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(16_24_40/0.12),0_6px_16px_-6px_color-mix(in_oklab,var(--accent)_55%,transparent)] transition-[transform,background-color] duration-[160ms,150ms] ease-[var(--curve-out),ease] motion-safe:active:scale-[0.97] ${className}`}
    >
      {children}
    </a>
  );
}
