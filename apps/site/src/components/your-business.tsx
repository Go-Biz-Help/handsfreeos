'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { MissedLeadVisual } from '@/components/visuals';
import { firstTrade, tradeById, trades, type Trade, type TradeId } from '@/content/trades';
import { track } from '@/lib/opinly/pixel';
import {
  NAME_MAX,
  NOBODY,
  nameOf,
  readYourBusiness,
  saveYourBusiness,
  type YourBusiness,
} from '@/lib/your-business';

/**
 * "Try it on your business": the home page asks for the visitor's business name and what it does, and its examples
 * are then about them. The hero's conversation is their customer texting their business, with Ava answering in
 * their name; the night band's missed lead is a job in their trade; the last band asks who answers when the next
 * lead texts them, by name.
 *
 * A page about somebody else's AC repair asks a cleaner to imagine; a page with their own name on the messages
 * doesn't. Typing it is also the first small yes: the sign-up links carry it on, so the app's first setup screen
 * starts with what they already typed (`lib/your-business.ts`).
 *
 * The page renders the same on the server and on the first frame (the example's first trade, and "you"), then
 * picks up what this browser remembers.
 */

interface Ctx {
  readonly business: YourBusiness;
  /** The trade the examples tell: the one picked, or the example's first. */
  readonly trade: Trade;
  /** The name the examples show: theirs once typed, the trade's made-up one until then. */
  readonly shown: string;
  /** Whether the name is theirs. */
  readonly own: boolean;
  readonly setName: (name: string) => void;
  readonly setTrade: (trade: TradeId) => void;
}

const YourBusinessContext = createContext<Ctx | null>(null);

export function YourBusinessProvider({ children }: { children: ReactNode }) {
  const [business, setBusiness] = useState<YourBusiness>(NOBODY);
  const counted = useRef(false);

  // After the first frame, so the server's page and the browser's agree before it changes.
  useEffect(() => {
    const saved = readYourBusiness();
    if (saved !== NOBODY) setBusiness(saved);
  }, []);

  const change = (next: YourBusiness) => {
    setBusiness(next);
    saveYourBusiness(next);
    // Once a visit, and never the name: whether people try it, and on which trade, is what's worth knowing.
    if (!counted.current) {
      counted.current = true;
      track('try_on_your_business', { trade: next.trade ?? firstTrade.id });
    }
  };

  const trade = tradeById(business.trade) ?? firstTrade;
  const name = nameOf(business);
  const value: Ctx = {
    business,
    trade,
    shown: name || trade.sample,
    own: name !== '',
    setName: (typed) => change({ ...business, name: typed.slice(0, NAME_MAX) }),
    setTrade: (id) => change({ ...business, trade: id }),
  };
  return <YourBusinessContext value={value}>{children}</YourBusinessContext>;
}

/** Outside the provider (any page but home), the examples are the first trade's, with its made-up name. */
export function useYourBusiness(): Ctx {
  return (
    useContext(YourBusinessContext) ?? {
      business: NOBODY,
      trade: firstTrade,
      shown: firstTrade.sample,
      own: false,
      setName: () => {},
      setTrade: () => {},
    }
  );
}

/**
 * The two questions, on top of the conversation they change: small enough to sit above it without pushing the
 * hero's buttons down, and live, so the answer shows up in the messages as it is typed.
 */
export function TryItOnYourBusiness() {
  const { business, trade, own, setName, setTrade } = useYourBusiness();
  const field =
    'bg-card-2 border-border-strong hover:border-accent/60 focus:border-accent h-10 rounded-[10px] border text-base font-semibold transition-[border-color] duration-150 ease-out';
  return (
    <div className="bg-card/85 border-border mb-3 rounded-[16px] border p-3 shadow-[var(--shadow-1)] backdrop-blur-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-1 pb-2.5">
        <label
          htmlFor="your-business"
          className="text-accent-text flex items-center gap-1.5 text-sm font-semibold"
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="h-3.5 w-3.5 self-center"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2 2M10.6 10.6l2 2M3.4 12.6l2-2M10.6 5.4l2-2" />
          </svg>
          Try it on your business
        </label>
        <p className="text-text-3 text-xs" aria-live="polite">
          {own ? 'We’ll fill it in when you sign up' : ''}
        </p>
      </div>
      {/* Side by side where there's room; on a phone the name gets the whole width. */}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          id="your-business"
          type="text"
          value={business.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your business’s name"
          autoComplete="organization"
          maxLength={NAME_MAX}
          spellCheck={false}
          className={`${field} placeholder:text-text-3 w-full min-w-0 px-3 placeholder:font-normal`}
        />
        <span className="relative flex">
          <select
            value={trade.id}
            onChange={(e) => setTrade(e.target.value as TradeId)}
            aria-label="What your business does"
            className={`${field} w-full cursor-pointer appearance-none pr-8 pl-3`}
          >
            {trades.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="text-text-2 pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        </span>
      </div>
    </div>
  );
}

/** Their business's name in a sentence, or the words that stand in for it until they type one. */
export function YourBusinessName({ fallback }: { fallback: string }) {
  const { shown, own } = useYourBusiness();
  return <>{own ? shown : fallback}</>;
}

/** The night band's lead nobody answered, in the visitor's trade. */
export function MissedLeadForYou() {
  const { trade } = useYourBusiness();
  return <MissedLeadVisual lead={trade.lost} />;
}
