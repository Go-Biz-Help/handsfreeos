'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/** The header cell of every hand-rolled money table: quiet, small, and on the card's second surface. */
export function Th({
  children,
  align,
  className,
}: {
  children?: ReactNode;
  align?: 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        'bg-card-2 px-4 py-2.5 text-left text-xs font-medium tracking-[0.02em] text-text-3',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align,
  className,
}: {
  children?: ReactNode;
  align?: 'right';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'border-t border-border px-4 py-3 align-middle',
        align === 'right' && 'whitespace-nowrap text-right tabular-nums',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** A customer, the way every money list shows one. */
export function CustomerCell({
  person,
  className,
}: {
  person: { id: string; fullName: string };
  className?: string;
}) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Avatar name={person.fullName} seed={person.id} size="sm" />
      <span className="truncate font-medium">{person.fullName}</span>
    </span>
  );
}

/** The whole row is a link on phones, so a card is one tap. */
export function RowLink({
  href,
  children,
  className,
  testId,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Link href={href} data-testid={testId} className={cn('block', className)}>
      {children}
    </Link>
  );
}

/**
 * "Show more" for a cursor-paged list. Pages arrive in the browser and stack on what the server rendered, the
 * way Customers does it.
 */
export function useMore<T>(key: string, initialCursor: string | null) {
  const [extra, setExtra] = useState<{ key: string; items: T[]; cursor: string | null }>({
    key,
    items: [],
    cursor: initialCursor,
  });
  const current = extra.key === key ? extra : { key, items: [] as T[], cursor: initialCursor };
  const [busy, setBusy] = useState(false);
  return {
    items: current.items,
    cursor: current.cursor,
    busy,
    async load(fetcher: (cursor: string) => Promise<{ items: T[]; nextCursor: string | null }>) {
      if (!current.cursor || busy) return;
      setBusy(true);
      try {
        const out = await fetcher(current.cursor);
        setExtra({ key, items: [...current.items, ...out.items], cursor: out.nextCursor });
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
  };
}

export function ShowMore({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <div className="border-t border-border p-3 text-center">
      <Button variant="secondary" size="sm" loading={busy} onClick={onClick}>
        Show more
      </Button>
    </div>
  );
}

/** The grey sentence under a list, straight from the canvas. */
export function ListNote({ children }: { children: ReactNode }) {
  return <p className="mt-2.5 text-xs leading-[1.45] text-text-3">{children}</p>;
}

/**
 * The Status column answers "where is this document", so an opened one still reads Sent — the canvas keeps
 * "opened" in the sentence beside it. The document's own page shows the fuller state. Core's, so the phone's
 * Money list says the same (`money/lists.ts`).
 */
export { listState } from '@hfos/core';
