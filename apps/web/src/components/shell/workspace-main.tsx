'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The page area: padded for ordinary pages, edge to edge for the inbox's panes, and nearly edge to edge for
 * the calendar (its grid scrolls inside itself). Customers keeps the ordinary padding but, on a desktop,
 * fills the viewport so its table scrolls inside itself and the column names stay put.
 */
export function WorkspaceMain({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const fullBleed = pathname.startsWith(`/app/w/${workspaceId}/inbox`);
  const calendar = pathname === `/app/w/${workspaceId}/calendar`;
  const customers = pathname === `/app/w/${workspaceId}/customers`;
  return (
    <main
      className={cn(
        'min-w-0 flex-1',
        fullBleed
          ? 'flex min-h-0 flex-col'
          : calendar
            ? 'flex min-h-0 flex-col pb-24 md:px-6 md:pb-4 md:pt-5'
            : customers
              ? 'px-4 pb-24 pt-4 md:flex md:h-dvh md:min-h-0 md:flex-col md:overflow-y-auto md:px-10 md:py-8'
              : 'px-4 pb-24 pt-4 md:px-10 md:py-8',
      )}
    >
      {children}
    </main>
  );
}
