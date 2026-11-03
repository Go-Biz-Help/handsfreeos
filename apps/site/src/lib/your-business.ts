/**
 * The visitor's own business, as they typed it into the home page's "Try it on your business": its name, and the
 * kind of business they picked, if they picked one.
 *
 * It lives in this browser's storage only, so the example remembers it on the next visit and nobody else ever sees
 * it. When they go for a sign-up link, `SignupLinkVisitor` adds it as `?business=` and `?industry=`, and the app's
 * first setup screen starts filled in with it. `/privacy` says so; change one and change the other.
 *
 * Storage can be missing or refuse (a private window, blocked site data), so every read and write is allowed to
 * fail: the example then simply forgets.
 */
import { tradeById, type TradeId } from '@/content/trades';

const KEY = 'hfos:your-business';

/** The app takes up to 120; a name this long already wraps the example's bubbles. */
export const NAME_MAX = 80;

export interface YourBusiness {
  /** As typed, so the field never fights the cursor. Empty until they type. */
  readonly name: string;
  /** Null until they pick one: the example's first trade is nobody's answer. */
  readonly trade: TradeId | null;
}

export const NOBODY: YourBusiness = { name: '', trade: null };

/** The name as it should read in a sentence: one space between words, none at either end. */
export const nameOf = (business: YourBusiness): string => business.name.replace(/\s+/g, ' ').trim();

export function readYourBusiness(): YourBusiness {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return NOBODY;
    const saved = JSON.parse(raw) as { name?: unknown; trade?: unknown };
    return {
      name: typeof saved.name === 'string' ? saved.name.slice(0, NAME_MAX) : '',
      trade: tradeById(typeof saved.trade === 'string' ? saved.trade : null)?.id ?? null,
    };
  } catch {
    return NOBODY;
  }
}

export function saveYourBusiness(business: YourBusiness): void {
  try {
    if (!nameOf(business) && !business.trade) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(business));
  } catch {
    // Remembering it is a convenience; the example works the same without.
  }
}

/** What a sign-up link carries: the name once there is one, and the kind of business once one was picked. */
export function signUpParams(business: YourBusiness): Record<string, string> {
  const params: Record<string, string> = {};
  const name = nameOf(business);
  if (name) params.business = name;
  const industry = tradeById(business.trade)?.industry;
  if (industry) params.industry = industry;
  return params;
}
