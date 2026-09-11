'use client';
import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { cn } from '@/lib/utils';

/** The shell search: opens the customers list with the query. */
export function SearchField({
  workspaceId,
  className,
  size = 'sm',
  autoFocus,
  onSubmitted,
}: {
  workspaceId: string;
  className?: string;
  size?: 'sm' | 'lg';
  autoFocus?: boolean;
  onSubmitted?: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const query = q.trim();
    router.push(`/app/w/${workspaceId}/customers${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    onSubmitted?.();
  }
  return (
    <form onSubmit={submit} role="search" className={cn('relative', className)}>
      <Search
        className={cn(
          'pointer-events-none absolute left-2.5 text-text-3',
          size === 'sm' ? 'top-[9px] h-4 w-4' : 'top-[13px] h-[18px] w-[18px]',
        )}
        strokeWidth={1.5}
      />
      <input
        type="search"
        aria-label="Search customers"
        placeholder="Search customers"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        data-testid="shell-search"
        className={cn(
          'w-full rounded-control border border-border bg-card-2 pr-3 text-text placeholder:text-placeholder focus:border-accent focus:bg-card focus:outline-none focus:ring-[3px] focus:ring-ring',
          size === 'sm' ? 'h-[34px] pl-8 text-[13px]' : 'h-11 pl-10 text-[15px]',
        )}
      />
    </form>
  );
}
