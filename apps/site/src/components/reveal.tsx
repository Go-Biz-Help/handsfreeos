'use client';

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Marks a group as arrived the first time the reader scrolls to it, and never again.
 *
 * Only a group that starts below the fold is held back (`data-reveal="waiting"`): one already on screen when the
 * page opens is simply there, so nothing a visitor is looking at blinks out, and a page whose JavaScript never
 * runs shows everything. What each group does on arrival is written in globals.css beside the reason for it.
 */
export function Reveal({
  children,
  className = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.getBoundingClientRect().top > window.innerHeight) el.dataset.reveal = 'waiting';
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        el.dataset.reveal = 'in';
        observer.disconnect();
      },
      // Most of the way in, not the first pixel: an arrival nobody sees has been wasted.
      { rootMargin: '0px 0px -15% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
