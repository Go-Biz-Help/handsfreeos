import type { ReactNode } from 'react';

/** A portal card's small heading, the boards' way ("COMING UP"), with what can be done beside it. */
export function PortalCardHead({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-3">{children}</h2>
      {action}
    </div>
  );
}
