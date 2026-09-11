import type { LabelHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('mb-1.5 block text-[13px] font-medium text-text', className)} {...props} />
  );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('mt-1.5 text-[12.5px] text-text-3', className)}>{children}</p>;
}

export function FieldError({ children, id }: { children?: ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
      {children}
    </p>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <FieldError id={`${htmlFor}-error`}>{error}</FieldError>
      ) : hint ? (
        <Hint>{hint}</Hint>
      ) : null}
    </div>
  );
}
