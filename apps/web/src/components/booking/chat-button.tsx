'use client';
/**
 * The simple page's Chat button. The business's chat loader, on the page beside it, opens the chat when the address
 * ends in #hfos-chat; the hash is cleared first, so a second press after closing the chat opens it again.
 */
import type { ReactNode } from 'react';

export function ChatButton({ className, children }: { className: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (window.location.hash === '#hfos-chat')
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        window.location.hash = 'hfos-chat';
      }}
      data-testid="business-page-chat"
    >
      {children}
    </button>
  );
}
