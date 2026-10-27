import * as AvatarPrimitive from '@rn-primitives/avatar';
import * as React from 'react';

import { Text } from '@/components/ui/text';
import { cn, initials } from '@/lib/utils';

/** The web's avatar palette: a person keeps the same colour everywhere (picked from their id). */
const PALETTE = [
  'bg-accent',
  'bg-[#008743]',
  'bg-[#996300]',
  'bg-[#5b616a]',
  'bg-[#1950b5]',
  'bg-[#862726]',
];

export function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

const SIZES = {
  sm: { box: 'size-6', text: 'text-[10px]' },
  md: { box: 'size-8', text: 'text-xs' },
  lg: { box: 'size-10', text: 'text-[13px]' },
  // Someone in a video call with their camera off.
  xl: { box: 'size-20', text: 'text-[26px]' },
} as const;

/** A person's initials in a circle, as on the web (`Avatar name="Dale Ramsey"` → DR). */
function Avatar({
  name,
  seed,
  size = 'md',
  className,
}: {
  name: string;
  seed?: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <AvatarPrimitive.Root
      alt={name}
      className={cn('shrink-0 overflow-hidden rounded-full', s.box, className)}
    >
      <AvatarPrimitive.Fallback
        className={cn('size-full items-center justify-center', avatarColor(seed ?? name))}
      >
        <Text className={cn('font-semibold tracking-[0.3px] text-white', s.text)}>
          {initials(name)}
        </Text>
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export { Avatar };
