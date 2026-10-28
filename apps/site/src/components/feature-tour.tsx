'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type TourFeature = {
  readonly id: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: string;
  /** The picture of it, from visuals.tsx. */
  readonly visual: ReactNode;
};

/**
 * "Six apps and a notepad, replaced by one": each of the six beside a picture of it.
 *
 * On a wide screen it is a list beside one stage: pick a line and the stage shows that part of the product,
 * while a highlight glides to the line you picked. On a phone the lines become cards you swipe, and the stage
 * follows whichever card is in front. Every line's words are always on the page; only the picture changes.
 */
export function FeatureTour({ features }: { features: readonly TourFeature[] }) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [clip, setClip] = useState<string | null>(null);
  const [glide, setGlide] = useState(false);

  // The highlight is one layer clipped to the chosen line, so moving it is a clip-path change: it slides
  // without the list reflowing, and a change of mind halfway simply retargets it.
  const place = useCallback(() => {
    const list = listRef.current;
    const item = itemRefs.current[active];
    if (!list || !item) return;
    const bottom = list.offsetHeight - item.offsetTop - item.offsetHeight;
    setClip(`inset(${item.offsetTop}px 0 ${bottom}px 0 round 16px)`);
  }, [active]);

  useLayoutEffect(place, [place]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(place);
    observer.observe(list);
    return () => observer.disconnect();
  }, [place]);

  // Glide only once it has been placed, or the first placement would sweep down from the top on load.
  useEffect(() => {
    if (!clip || glide) return;
    const frame = requestAnimationFrame(() => setGlide(true));
    return () => cancelAnimationFrame(frame);
  }, [clip, glide]);

  // On a phone the list is a row of cards, and the one in front picks the picture.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (list.scrollWidth <= list.clientWidth) return;
        const start = list.scrollLeft + parseFloat(getComputedStyle(list).paddingLeft);
        let nearest = 0;
        itemRefs.current.forEach((item, index) => {
          const best = itemRefs.current[nearest];
          if (item && best && Math.abs(item.offsetLeft - start) < Math.abs(best.offsetLeft - start))
            nearest = index;
        });
        setActive(nearest);
      });
    };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      list.removeEventListener('scroll', onScroll);
    };
  }, []);

  const pick = (index: number) => {
    setActive(index);
    const list = listRef.current;
    const item = itemRefs.current[index];
    if (!list || !item || list.scrollWidth <= list.clientWidth) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({
      left: item.offsetLeft - parseFloat(getComputedStyle(list).paddingLeft),
      behavior: still ? 'auto' : 'smooth',
    });
  };

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:items-start lg:gap-14">
      <div
        ref={listRef}
        className="relative -mx-5 flex snap-x snap-mandatory scroll-px-5 gap-3 overflow-x-auto overscroll-x-contain px-5 pb-1 [scrollbar-width:none] sm:-mx-8 sm:scroll-px-8 sm:px-8 lg:mx-0 lg:block lg:space-y-1 lg:overflow-visible lg:px-0 lg:pb-0 [&::-webkit-scrollbar]:hidden"
      >
        <div
          aria-hidden="true"
          className="bg-accent-soft pointer-events-none absolute inset-0 hidden lg:block"
          style={{
            clipPath: clip ?? 'inset(0 0 100% 0)',
            opacity: clip ? 1 : 0,
            transition: glide ? 'clip-path 340ms var(--curve-drawer)' : 'none',
          }}
        />
        {features.map((feature, index) => {
          const on = index === active;
          return (
            <div
              key={feature.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              className={`relative w-[84%] shrink-0 snap-start rounded-[16px] border p-5 transition-[border-color,background-color] duration-200 ease-[ease] sm:w-[58%] lg:w-auto lg:border-transparent lg:bg-transparent ${
                on
                  ? 'border-accent/50 bg-card'
                  : 'border-border bg-card lg:hover:bg-[color-mix(in_oklab,var(--card-2)_75%,transparent)]'
              }`}
            >
              <button
                type="button"
                aria-pressed={on}
                aria-controls="feature-stage"
                onClick={() => pick(index)}
                className="flex w-full items-center gap-3 text-left outline-none after:absolute after:inset-0 after:rounded-[16px] after:content-[''] focus-visible:shadow-none focus-visible:after:shadow-[0_0_0_3px_var(--ring)]"
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] transition-colors duration-200 ${
                    on ? 'bg-accent text-white' : 'bg-card-2 text-text-2'
                  }`}
                >
                  {feature.icon}
                </span>
                <span className="text-[1.0625rem] leading-snug font-semibold">{feature.title}</span>
              </button>
              <p className="text-text-2 mt-2.5 text-[0.9375rem] leading-relaxed lg:pl-12">
                {feature.body}
              </p>
            </div>
          );
        })}
      </div>

      <div className="order-first lg:sticky lg:top-28 lg:order-none">
        <div
          id="feature-stage"
          className="border-border bg-card-2 relative overflow-hidden rounded-[24px] border px-5 py-8 sm:p-10"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_0%,color-mix(in_oklab,var(--accent)_12%,transparent),transparent_70%)]"
          />
          <div className="relative grid min-h-[19rem] place-items-center [grid-template-areas:'stage'] *:[grid-area:stage] sm:min-h-[22rem]">
            {features.map((feature, index) => {
              const on = index === active;
              return (
                <div
                  key={feature.id}
                  inert={!on}
                  // The new picture eases in while the old one leaves faster, softened with a little blur so the
                  // two read as one stage changing.
                  className={`w-full max-w-[25rem] ease-out ${
                    on
                      ? 'visible opacity-100 transition-[opacity,transform,filter] duration-[360ms]'
                      : 'invisible opacity-0 transition-[opacity,transform,filter,visibility] duration-[180ms] motion-safe:translate-y-2 motion-safe:scale-[0.98] motion-safe:blur-[3px]'
                  }`}
                >
                  {feature.visual}
                </div>
              );
            })}
          </div>
        </div>
        <div aria-hidden="true" className="mt-4 flex justify-center gap-1.5 lg:hidden">
          {features.map((feature, index) => (
            <span
              key={feature.id}
              className={`h-1.5 w-1.5 rounded-full transition-colors duration-200 ${
                index === active ? 'bg-accent' : 'bg-border-strong'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
