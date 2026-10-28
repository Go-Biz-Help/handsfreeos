import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

export function Container({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

export function Section({
  children,
  className = '',
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    // scroll-mt keeps an anchored section clear of the sticky header.
    <section id={id} className={`scroll-mt-16 py-20 sm:py-28 ${className}`}>
      <Container>{children}</Container>
    </section>
  );
}

/** The small label over a section: a quiet dot and words in sentence case, not a shouted capital line. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-text-2 mb-5 flex items-center gap-2 text-sm font-medium ${className}`}>
      <span aria-hidden="true" className="bg-accent h-1.5 w-1.5 rounded-full" />
      {children}
    </p>
  );
}

export function SectionHeading({
  children,
  sub,
  className = '',
  as = 'h2',
}: {
  children: ReactNode;
  sub?: ReactNode;
  className?: string;
  /** The page's own opening heading is an h1; every heading below it is an h2. */
  as?: 'h1' | 'h2';
}) {
  const Heading = as;
  return (
    <div className={`max-w-3xl ${className}`}>
      <Heading className="text-[2.125rem] leading-[1.04] font-bold tracking-[-0.035em] sm:text-5xl md:text-[3.25rem]">
        {children}
      </Heading>
      {sub ? <p className="text-text-2 mt-6 max-w-2xl text-lg sm:text-xl">{sub}</p> : null}
    </div>
  );
}

type ButtonProps = ComponentProps<typeof Link> & {
  variant?: 'primary' | 'secondary' | 'night';
  size?: 'md' | 'lg';
  /** A small arrow that leans forward on hover: for the button that moves somebody on, not for every one. */
  arrow?: boolean;
};

/**
 * Every button answers a press at once: it gives a little under the finger (scale 0.97, 160ms), so the page
 * feels like it heard. Colour changes are plain `ease`; the press uses the site's strong ease-out.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  arrow = false,
  className = '',
  children,
  ...props
}: ButtonProps) {
  const base =
    'group/button inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-[transform,background-color,border-color,box-shadow] duration-[160ms,150ms,150ms,150ms] ease-[var(--curve-out),ease,ease,ease] motion-safe:active:scale-[0.97]';
  const sizes = {
    md: 'px-4 py-2.5 text-[0.9375rem]',
    lg: 'px-6 py-3.5 text-[1.0625rem]',
  } as const;
  const variants = {
    primary:
      'bg-accent text-white hover:bg-accent-hover shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_1px_2px_rgb(16_24_40/0.12),0_6px_16px_-6px_color-mix(in_oklab,var(--accent)_55%,transparent)]',
    secondary:
      'bg-card text-text border border-border-strong hover:bg-card-2 shadow-[0_1px_2px_rgb(16_24_40/0.05)]',
    night:
      'bg-white/[0.06] text-on-night border border-night-border hover:bg-white/[0.11] hover:border-white/20',
  } as const;
  return (
    <Link className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props}>
      {children}
      {arrow ? (
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="-mr-0.5 h-4 w-4 transition-transform duration-200 ease-out group-hover/button:translate-x-0.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8h9.5M8.5 4l4 4-4 4" />
        </svg>
      ) : null}
    </Link>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-card border-border rounded-[var(--radius-card)] border p-6 ${className}`}>
      {children}
    </div>
  );
}

/** A tick used through the plan tables and feature lists. */
export function Check({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={`h-5 w-5 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m4 10.5 4 4 8-9" />
    </svg>
  );
}

export function Prose({ children }: { children: ReactNode }) {
  return (
    <div
      className={[
        'text-text-2 max-w-3xl text-[1.0625rem] leading-relaxed',
        '[&_h2]:text-text [&_h2]:mt-12 [&_h2]:mb-4 [&_h2]:text-2xl [&_h2]:font-bold',
        '[&_h3]:text-text [&_h3]:mt-8 [&_h3]:mb-3 [&_h3]:text-lg [&_h3]:font-semibold',
        '[&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:mb-2',
        '[&_a]:text-accent-text [&_a]:underline [&_a]:underline-offset-2',
        '[&_strong]:text-text [&_strong]:font-semibold',
        '[&_table]:mb-6 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-base',
        '[&_th]:border-border [&_th]:text-text [&_th]:border-b [&_th]:py-2 [&_th]:pr-4 [&_th]:align-top [&_th]:font-semibold',
        '[&_td]:border-border [&_td]:border-b [&_td]:py-2 [&_td]:pr-4 [&_td]:align-top',
      ].join(' ')}
    >
      {children}
    </div>
  );
}
