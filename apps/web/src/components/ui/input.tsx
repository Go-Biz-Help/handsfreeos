import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// 16 px on phones (max-md) whatever the size: iPhones zoom the page in on a field with smaller text.
const base =
  'w-full rounded-control border border-border-strong bg-card px-3 text-[15px] text-text placeholder:text-placeholder transition-[border-color,box-shadow] focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-ring disabled:bg-card-2 disabled:text-text-2 [&[readonly]]:bg-card-2 [&[readonly]]:text-text-2 max-md:text-base';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  inputSize?: 'sm' | 'md' | 'lg';
}

export function Input({ className, invalid, inputSize = 'md', ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        base,
        inputSize === 'sm'
          ? 'h-[34px] text-sm'
          : inputSize === 'lg'
            ? 'h-11 rounded-menu px-3.5'
            : 'h-10',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  selectSize?: 'sm' | 'md' | 'lg';
}

export function Select({ className, selectSize = 'md', children, ...props }: SelectProps) {
  return (
    <select
      className={cn(
        base,
        'appearance-none bg-[url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2716%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23777c86%27 stroke-width=%271.8%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27><path d=%27m6 9 6 6 6-6%27/></svg>")] bg-[length:16px_16px] bg-[position:right_10px_center] bg-no-repeat pr-9',
        selectSize === 'sm'
          ? 'h-[34px] text-sm'
          : selectSize === 'lg'
            ? 'h-11 rounded-menu px-3.5'
            : 'h-10',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
