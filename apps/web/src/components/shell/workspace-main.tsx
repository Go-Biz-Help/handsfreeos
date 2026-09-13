'use client';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The page area: padded for ordinary pages, edge to edge for the inbox's panes, and nearly edge to edge for
 * the calendar (its grid scrolls inside itself).
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
  return (
    <main
      className={cn(
        'min-w-0 flex-1',
        fullBleed
          ? 'flex min-h-0 flex-col'
          : calendar
            ? 'flex min-h-0 flex-col pb-24 md:px-6 md:pb-4 md:pt-5'
            : 'px-4 pb-24 pt-4 md:px-10 md:py-8',
      )}
    >
      {children}
    </main>
  );
}
