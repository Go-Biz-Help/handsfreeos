import Image from 'next/image';
import icon from '@/assets/brand/handsfreeos-icon.png';
import { cn } from '@/lib/utils';

/** The HandsFreeOS mark the Assistant speaks with. Not preloaded: it repeats down a chat. */
export function AssistantMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <Image
      src={icon}
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={cn('block flex-none select-none', className)}
    />
  );
}
