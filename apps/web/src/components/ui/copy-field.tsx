'use client';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/** Copies a value and says so (or says the browser refused). */
export async function copyText(value: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(done);
  } catch {
    toast.error('Your browser didn’t allow copying.');
  }
}

/** A value to paste somewhere else (a DNS record, an address): truncated on screen, copied whole. */
export function CopyField({
  value,
  label,
  copied,
  className,
}: {
  value: string;
  /** The button's name, like "Copy host". */
  label: string;
  /** The toast, like "Copied the host". */
  copied: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-[34px] min-w-0 items-center gap-2 rounded-control border border-border bg-card-2 py-[3px] pl-2.5 pr-[3px]',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={value}>
        {value}
      </span>
      <button
        type="button"
        onClick={() => void copyText(value, copied)}
        title={label}
        aria-label={label}
        className="flex h-7 w-7 flex-none items-center justify-center rounded-control text-text-2 hover:bg-card-3 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
    </div>
  );
}
