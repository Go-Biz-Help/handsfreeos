import { Sparkles } from 'lucide-react';
import { AI_SOFT, AI_TEXT } from '@/components/workflows/chips';
import { cn } from '@/lib/utils';

export { AI_SOFT, AI_TEXT };

/** Milestone 6's AI violet as a solid fill (the training-wheels bar); it follows light and dark. */
export const AI_FILL = 'bg-[color-mix(in_oklab,#7c3aed_85%,var(--text))]';

const SIZES = {
  xs: ['h-5 w-5', 'h-[11px] w-[11px]'],
  sm: ['h-6 w-6', 'h-3 w-3'],
  md: ['h-8 w-8', 'h-[15px] w-[15px]'],
  lg: ['h-10 w-10', 'h-[19px] w-[19px]'],
} as const;

/** The AI teammate's mark: a sparkle on violet, never initials or a face, because it isn't a person. */
export function TeammateMark({
  size = 'md',
  label,
  className,
}: {
  size?: keyof typeof SIZES;
  /** "Ava (AI)": names it for screen readers and on hover; without it the mark is decoration. */
  label?: string;
  className?: string;
}) {
  const [box, icon] = SIZES[size];
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      className={cn(
        'inline-flex flex-none items-center justify-center rounded-full shadow-[inset_0_0_0_1px_color-mix(in_oklab,#7c3aed_24%,transparent)]',
        AI_SOFT,
        AI_TEXT,
        box,
        className,
      )}
    >
      <Sparkles className={icon} strokeWidth={1.75} />
    </span>
  );
}

/** An icon on the AI tint (the test console's heading). */
export function AiTile({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-[38px] w-[38px] flex-none items-center justify-center rounded-[10px]',
        AI_SOFT,
        AI_TEXT,
        className,
      )}
    >
      <Sparkles className="h-[18px] w-[18px]" strokeWidth={1.75} />
    </span>
  );
}
