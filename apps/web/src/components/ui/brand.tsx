import { cn } from '@/lib/utils';

export function BrandMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex items-center justify-center rounded-control bg-accent font-bold text-white',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.43),
        letterSpacing: '-0.02em',
      }}
    >
      hf
    </span>
  );
}

export function Brand({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-text',
        className,
      )}
    >
      <BrandMark size={size} />
      HandsFreeOS
    </span>
  );
}
