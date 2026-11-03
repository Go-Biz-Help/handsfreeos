import type { ReactNode } from 'react';
import { Container } from './ui';

/** The after-hours band: night in both themes, with a little light from the top corner. */
export function NightBand({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    // The faint edge matters in dark mode, where the page itself is nearly night already.
    <section
      className={`bg-night text-on-night border-night-border relative overflow-hidden border-y ${className}`}
    >
      <div className="night-glow pointer-events-none absolute inset-0" aria-hidden="true" />
      <Container className="relative py-24 sm:py-32">{children}</Container>
    </section>
  );
}
