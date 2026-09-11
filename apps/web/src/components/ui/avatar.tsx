import { cn, initials } from '@/lib/utils';

const palette = [
  'bg-accent',
  'bg-[#008743]',
  'bg-[#996300]',
  'bg-[#5b616a]',
  'bg-[#1950b5]',
  'bg-[#862726]',
];

function pick(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

export function Avatar({
  name,
  seed,
  size = 'md',
  className,
  square,
}: {
  name: string;
  seed?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  square?: boolean;
}) {
  const dims =
    size === 'sm' ? 'h-6 w-6 text-[10px]' : size === 'lg' ? 'h-14 w-14 text-lg' : 'h-8 w-8 text-xs';
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center font-semibold tracking-wide text-white',
        square ? 'rounded-control' : 'rounded-full',
        dims,
        pick(seed ?? name),
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
