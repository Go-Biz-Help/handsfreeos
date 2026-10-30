'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { foundingSpots, moneyBack, urls } from '@/content/site';

const monthly = foundingSpots.find((s) => s.plan === 'monthly');

/**
 * The home page's sign-up button, kept within a thumb's reach on a phone. The page is long, and on a phone the
 * header's button is behind the menu, so between the hero's buttons and the last band's somebody ready to buy
 * had to scroll back up to do it.
 *
 * It shows only while neither of those is on screen (each is marked `data-cta`), and only once the hero's has been
 * scrolled past, so it never sits on top of the button it repeats. Wider screens keep "Sign up" in the header, so
 * it is phones and small tablets only.
 */
export function StickyCta({ open }: { open: boolean }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const marks = [...document.querySelectorAll<HTMLElement>('[data-cta]')];
    if (marks.length === 0) return;
    const onScreen = new Map<Element, boolean>();
    const sync = () => {
      const hero = marks.find((m) => m.dataset.cta === 'hero');
      const passed = hero ? hero.getBoundingClientRect().bottom < 0 : true;
      setShown(passed && ![...onScreen.values()].some(Boolean));
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) onScreen.set(entry.target, entry.isIntersecting);
      sync();
    });
    for (const mark of marks) observer.observe(mark);
    window.addEventListener('scroll', sync, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', sync);
    };
  }, []);

  return (
    <div
      inert={!shown}
      aria-hidden={!shown}
      className={`bg-card/90 border-border fixed inset-x-0 bottom-0 z-40 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgb(16_24_40/0.12)] backdrop-blur-md transition-[transform,opacity] duration-300 ease-[var(--curve-out)] lg:hidden ${
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-full opacity-0'
      }`}
    >
      <div className="mx-auto flex max-w-xl items-center gap-3">
        <p className="text-text-2 min-w-0 flex-1 text-xs leading-snug">
          <span className="text-text block font-semibold">
            {monthly ? `${monthly.priceLabel} ${monthly.per}, no contract` : 'No contract'}
          </span>
          {moneyBack.short}
        </p>
        <Button href={urls.signUp} arrow className="shrink-0">
          {open ? 'Claim my spot' : 'Sign up'}
        </Button>
      </div>
    </div>
  );
}
