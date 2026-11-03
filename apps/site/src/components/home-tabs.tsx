'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface HomeTab {
  /** The panel's id, so a link to `/#<id>` opens that tab. */
  readonly id: string;
  readonly label: string;
  readonly panel: ReactNode;
}

/**
 * The home page's middle, folded into tabs: a day with it, what changes, why the AI can be trusted, how the first
 * week goes, and the phone app. They were five full sections, and a visitor deciding scrolled past most of them;
 * now the page's decision points (the bill, the promise, the spots) sit screens closer to the top.
 *
 * Every panel is rendered on the server and only hidden, so search engines and assistants read all five, and a
 * link to one (`/#tuesday` from the hero, `/#how` from the footer) opens it.
 */
export function HomeTabs({ tabs }: { tabs: readonly HomeTab[] }) {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // On a phone the row scrolls sideways: keep the picked tab in it, without moving the page.
  useEffect(() => {
    const list = listRef.current;
    const tab = tabRefs.current[active];
    if (!list || !tab) return;
    const left = tab.offsetLeft;
    if (left < list.scrollLeft || left + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: left - 8, behavior: 'smooth' });
    }
  }, [active]);

  useEffect(() => {
    const openFromHash = () => {
      const index = tabs.findIndex((t) => `#${t.id}` === window.location.hash);
      if (index < 0) return;
      setActive(index);
      // The panel was hidden, so the browser could not scroll to it: once it shows, go there.
      requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'start' }));
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [tabs]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    const jump = { Home: 0, End: tabs.length - 1 }[event.key];
    if (step === undefined && jump === undefined) return;
    event.preventDefault();
    const next = jump ?? (active + step! + tabs.length) % tabs.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div ref={rootRef} className="scroll-mt-20">
      <div
        ref={listRef}
        role="tablist"
        aria-label="More about HandsFreeOS"
        onKeyDown={onKeyDown}
        className="bg-card-2 border-border relative -mx-1 flex gap-1 overflow-x-auto rounded-full border p-1 [scrollbar-width:none] sm:mx-0 sm:inline-flex"
      >
        {tabs.map((tab, index) => {
          const on = index === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={on}
              aria-controls={tab.id}
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(index)}
              className={`shrink-0 cursor-pointer rounded-full px-4 py-2 text-sm font-semibold whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:shadow-[0_0_0_3px_var(--ring)] focus-visible:outline-none sm:px-5 sm:text-base ${
                on ? 'bg-card text-text shadow-[var(--shadow-1)]' : 'text-text-2 hover:text-text'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          id={tab.id}
          role="tabpanel"
          aria-labelledby={`tab-${tab.id}`}
          hidden={index !== active}
          tabIndex={0}
          className="tab-panel mt-12 focus-visible:outline-none"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
