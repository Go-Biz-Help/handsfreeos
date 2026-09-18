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

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-accent-text mb-4 text-xs font-semibold tracking-[0.14em] uppercase">
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
      <Heading className="text-3xl leading-[1.12] font-bold sm:text-4xl md:text-[2.75rem]">
        {children}
      </Heading>
      {sub ? <p className="text-text-2 mt-5 text-lg sm:text-xl">{sub}</p> : null}
    </div>
  );
}

type ButtonProps = ComponentProps<typeof Link> & {
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'lg';
};

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-colors';
  const sizes = {
    md: 'px-5 py-2.5 text-base',
    lg: 'px-7 py-4 text-lg',
  } as const;
  const variants = {
    primary: 'bg-accent text-white hover:bg-accent-hover shadow-[var(--shadow-2)]',
    secondary: 'bg-card text-text border border-border-strong hover:bg-card-2',
  } as const;
  return <Link className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props} />;
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
