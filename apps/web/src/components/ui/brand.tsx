import Image from 'next/image';
import icon from '@/assets/brand/handsfreeos-icon.png';
import { cn } from '@/lib/utils';

/**
 * The HandsFreeOS icon (design/brand/handsfreeos-icon.png is the master). Decorative unless it is given `alt`,
 * as it is beside the name in `Brand`.
 */
export function BrandMark({
  className,
  size = 28,
  alt = '',
}: {
  className?: string;
  size?: number;
  alt?: string;
}) {
  return (
    <Image
      src={icon}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      width={size}
      height={size}
      priority
      className={cn('shrink-0 select-none', className)}
    />
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
      {/* The picture carries the name; the word is hidden from screen readers so it is read once. */}
      <BrandMark size={size} alt="HandsFreeOS" />
      <span aria-hidden>
        HandsFree<span className="text-accent-text">OS</span>
      </span>
    </span>
  );
}
