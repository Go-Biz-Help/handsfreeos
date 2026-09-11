import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({
  title,
  children,
  actions,
  className,
  dashed,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  dashed?: boolean;
}) {
  return (
    <div
      className={cn(
        'px-6 py-11 text-center text-text-2',
        dashed && 'rounded-card border border-dashed border-border-strong py-6',
        className,
      )}
    >
      <div className="text-[15px] font-semibold text-text">{title}</div>
      {children ? <div className="mt-1 text-[13px]">{children}</div> : null}
      {actions ? <div className="mt-3 flex justify-center gap-2">{actions}</div> : null}
    </div>
  );
}
