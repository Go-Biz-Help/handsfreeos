/**
 * The business on top of the pages its customers see (its booking pages, estimates and invoices) and in the
 * previews of them: its logo, or its initials in its colour's square (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md
 * §4). A logo sits on white, so a dark one still shows on a dark page.
 */
import { logoBox } from '@hfos/core';
import { cn, initials } from '@/lib/utils';

export interface ShownLogo {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

export function BusinessMark({
  name,
  logo,
  size = 36,
  className,
}: {
  name: string;
  logo: ShownLogo | null | undefined;
  /** How high it is, in pixels. */
  size?: number;
  className?: string;
}) {
  if (!logo)
    return (
      <span
        aria-hidden
        className={cn(
          'inline-flex flex-none items-center justify-center rounded-[10px] bg-accent font-bold tracking-[0.02em] text-white',
          className,
        )}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
        data-testid="business-initials"
      >
        {initials(name)}
      </span>
    );
  const box = logoBox(logo, size);
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center rounded-[10px] bg-white',
        className,
      )}
      style={{ height: size, minWidth: size, width: box.width + 6 }}
    >
      {/* Storage's public address: plain <img>, nothing for an image optimizer to keep. */}
      <img
        src={logo.url}
        alt=""
        width={box.width}
        height={box.height}
        style={{ width: box.width, height: box.height }}
        data-testid="business-logo"
      />
    </span>
  );
}
