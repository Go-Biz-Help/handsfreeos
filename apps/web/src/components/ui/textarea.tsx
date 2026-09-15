import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Textarea({
  className,
  invalid,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        // 16 px on phones: iPhones zoom the page in on a field with smaller text.
        'min-h-[88px] w-full resize-y rounded-control border border-border-strong bg-card px-3 py-2.5 text-[15px] leading-[1.45] text-text placeholder:text-placeholder transition-[border-color,box-shadow] focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-ring disabled:bg-card-2 disabled:text-text-2 max-md:text-base',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    />
  );
}
