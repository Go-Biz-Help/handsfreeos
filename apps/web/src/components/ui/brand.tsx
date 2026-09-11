import Image from 'next/image';
import icon from '@/assets/brand/handsfreeos-icon.png';
import { cn } from '@/lib/utils';

/** The HandsFreeOS icon (design/brand/handsfreeos-icon.png is the master). */
export function BrandMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <Image
      src={icon}
      alt=""
      aria-hidden
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
      <BrandMark size={size} />
      <span>
        HandsFree<span className="text-accent-text">OS</span>
      </span>
    </span>
  );
}
