import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Checkbox({
  label,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-2.5 text-sm text-text', className)}>
      <input
        type="checkbox"
        className="h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent"
        {...props}
      />
      <span>{label}</span>
    </label>
  );
}
