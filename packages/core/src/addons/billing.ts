/**
 * What an add-on costs and where a business stands paying for it (20261027028500, the owner's picks of 2026-11-17).
 * Browser-safe: the web, the phone and the worker all decide and say it with these.
 *
 * - **A monthly price for the whole business** (`billing.monthlyCents`), charged to the plan's cards in turn (the
 *   default, then each backup), on the day of the month it was added, yearly plans too (pick 3a).
 * - **14 days free the first time** a business adds a paid add-on, once per business and add-on (pick 2a).
 * - **A failed payment** is tried again once a day for `PLAN_RETRY_DAYS` days, like the plan's; then only that add-on
 *   turns off, with nothing deleted (pick 4a).
 * - **Turning it off from the Add-ons page** lets it run to the end of the trial or the month already paid, then it
 *   turns off on its own; nothing is refunded for part of a month (pick 5a). Turned off at once (Turn off now, the
 *   Assistant, uninstalling) it stops charging, and turning it back on before the paid month is up charges nothing
 *   more until then.
 * - **HandsFreeOS can give one free** (`platform.addon_grants`), until staff take it back or until a date (pick 6a).
 *   When a gift ends, a paid add-on turns off, unless the business chose to keep it paying (Keep it after that).
 * - **On sale only when the owner says** (pick 7a): its catalogue status says so (`available`); until then only a gift
 *   reaches a business.
 */
import { formatUtcDate } from '../crm/format';
import { money } from '../money/format';
import { PLAN_RETRY_DAYS } from '../billing/rules';
import type { AddonBilling } from './manifest';

/** Days free the first time a business adds a paid add-on (the owner's pick 2a). */
export const ADDON_TRIAL_DAYS = 14;

/** How many days before a free trial or a gift ends its business is told: the plan's own reminder (3). */
export const ADDON_ENDING_DAYS = 3;

/** What a paid add-on costs. */
export interface AddonPrice {
  readonly monthlyCents: number;
  readonly trialDays: number;
}

/** A paid add-on's price, or null for a free one. */
export function addonPriceOf(
  m: { readonly billing: AddonBilling } | null | undefined,
): AddonPrice | null {
  if (!m || m.billing.model !== 'paid' || !m.billing.monthlyCents) return null;
  return { monthlyCents: m.billing.monthlyCents, trialDays: m.billing.trialDays ?? 0 };
}

/** Where a business stands paying for one add-on, as `addon.list` hands it to the screens. */
export type AddonStanding =
  /** It costs nothing: a free add-on. */
  | { readonly kind: 'free' }
  /** HandsFreeOS gave it to this business free, until staff take it back or until `until`. */
  | {
      readonly kind: 'gift';
      readonly until: string | null;
      /** The business chose to keep it after the gift: its first charge is on `until`. */
      readonly keepsAfter: boolean;
      readonly priceCents: number | null;
    }
  /** In its free trial. `stopAt`: turned off from the page, it runs until then and is never charged. */
  | {
      readonly kind: 'trial';
      readonly priceCents: number;
      readonly trialEndsAt: string;
      readonly stopAt: string | null;
    }
  /** Paid by the month. `stopAt`: turned off from the page, it runs to the end of the paid month. */
  | {
      readonly kind: 'paid';
      readonly priceCents: number;
      readonly nextChargeAt: string | null;
      readonly paidThrough: string | null;
      readonly stopAt: string | null;
    }
  /** Its last charge didn't go through: tried again daily until `offAt`, then it turns off. */
  | {
      readonly kind: 'past_due';
      readonly priceCents: number;
      readonly failedAt: string;
      readonly problem: string | null;
      readonly nextRetryAt: string | null;
      readonly offAt: string;
    }
  /**
   * Not paying for it now: never added, turned off, or turned off for not being paid. `paidThrough` is a month
   * already paid that hasn't run out (turning it back on before then charges nothing more until that day);
   * `trialLeft` is whether adding it starts the free trial.
   */
  | {
      readonly kind: 'unpaid';
      readonly priceCents: number;
      readonly paidThrough: string | null;
      readonly trialLeft: boolean;
    };

/** A business's row in `app.addon_subscriptions`, as the queries read it. */
export interface AddonSubscriptionFacts {
  readonly status: 'trial' | 'active' | 'past_due' | 'ended';
  readonly priceCents: number;
  readonly trialStartedAt: string | null;
  readonly trialEndsAt: string | null;
  readonly paidThrough: string | null;
  readonly nextChargeAt: string | null;
  readonly stopAt: string | null;
  readonly failedAt: string | null;
  readonly problem: string | null;
  readonly nextRetryAt: string | null;
}

/** A gift from HandsFreeOS, as `platform.addon_grants` keeps it. */
export interface AddonGiftFacts {
  readonly until: string | null;
}

const DAY_MS = 24 * 3_600_000;

/** When a failed payment that first failed at `failedAt` turns the add-on off: after its last daily retry. */
export const addonOffAfterFailure = (failedAt: string): string =>
  new Date(new Date(failedAt).getTime() + (PLAN_RETRY_DAYS + 1) * DAY_MS).toISOString();

/**
 * Where a business stands with one add-on, from its manifest's price, the gift HandsFreeOS gave it (if any, and not
 * ended), and its subscription row (if any).
 */
export function addonStandingOf(
  price: AddonPrice | null,
  gift: AddonGiftFacts | null,
  sub: AddonSubscriptionFacts | null,
  now: Date = new Date(),
): AddonStanding {
  const live = (iso: string | null) => !!iso && new Date(iso).getTime() > now.getTime();
  if (gift)
    return {
      kind: 'gift',
      until: gift.until,
      keepsAfter:
        !!gift.until && !!sub && sub.status !== 'ended' && sub.nextChargeAt !== null && !sub.stopAt,
      priceCents: price?.monthlyCents ?? null,
    };
  if (!price) return { kind: 'free' };
  const priceCents = sub && sub.status !== 'ended' ? sub.priceCents : price.monthlyCents;
  if (sub?.status === 'trial' && sub.trialEndsAt)
    return { kind: 'trial', priceCents, trialEndsAt: sub.trialEndsAt, stopAt: sub.stopAt };
  if (sub?.status === 'active')
    return {
      kind: 'paid',
      priceCents,
      nextChargeAt: sub.nextChargeAt,
      paidThrough: sub.paidThrough,
      stopAt: sub.stopAt,
    };
  if (sub?.status === 'past_due' && sub.failedAt)
    return {
      kind: 'past_due',
      priceCents,
      failedAt: sub.failedAt,
      problem: sub.problem,
      nextRetryAt: sub.nextRetryAt,
      offAt: addonOffAfterFailure(sub.failedAt),
    };
  return {
    kind: 'unpaid',
    priceCents: price.monthlyCents,
    paidThrough: sub && live(sub.paidThrough) ? sub.paidThrough : null,
    trialLeft: price.trialDays > 0 && !sub?.trialStartedAt,
  };
}

/** When an add-on turned off from the page stops, if it's paid up or in its trial: null when it would stop at once. */
export function addonStopsAt(standing: AddonStanding): string | null {
  if (standing.kind === 'trial') return standing.stopAt ?? standing.trialEndsAt;
  if (standing.kind === 'paid') return standing.stopAt ?? standing.paidThrough;
  return null;
}

/** Whether a business pays for this add-on now (in its trial, paid up, or owing), and so has something to stop. */
export const addonRenews = (standing: AddonStanding): boolean =>
  (standing.kind === 'trial' || standing.kind === 'paid') && !standing.stopAt;

const day = (iso: string): string => formatUtcDate(new Date(iso));

/** The words the Add-ons page, Settings → Billing & Usage, Admin and the emails say about an add-on's price. */
export const ADDON_BILLING_WORDS = {
  /** "$47 a month, after 14 days free" / "$47 a month". */
  price: (cents: number, trialDays: number) =>
    trialDays > 0
      ? `${money(cents)} a month, after ${trialDays} days free`
      : `${money(cents)} a month`,
  /** Under the price, before it's added. */
  perBusiness: 'For your whole business. Texts, calls and AI it uses come out of your balance.',

  // Adding a paid one (web only: the phone never shows a price, App Store rule 3.1.3(f)).
  startTitle: (name: string) => `Add ${name}?`,
  startTrial: (name: string, cents: number, days: number, ends: string) =>
    `${name} is free for ${days} days, until ${day(ends)}. Then it’s ${money(cents)} a month on your default card. Turn it off before then and you won’t be charged.`,
  startPaid: (name: string, cents: number) =>
    `${name} is ${money(cents)} a month for your whole business, charged to your default card today and each month on this date. Turn it off any time; it runs to the end of the month you paid for.`,
  startPaidUp: (name: string, until: string, cents: number) =>
    `You’ve already paid for ${name} through ${day(until)}, so nothing is charged today. Then it’s ${money(cents)} a month on your default card.`,
  startTrialButton: 'Start free trial',
  startPaidButton: (cents: number) => `Add for ${money(cents)} a month`,
  startOnButton: 'Turn it on',
  needsCard: 'Add a card in Settings → Billing & Usage first. Your default card pays for add-ons.',
  addCardLink: 'Go to Billing & Usage',

  // Where it stands, under its name.
  gift: 'Free from HandsFreeOS.',
  giftUntil: (until: string) => `Free from HandsFreeOS until ${day(until)}.`,
  giftKeeps: (until: string, cents: number) =>
    `Free from HandsFreeOS until ${day(until)}. Then it’s ${money(cents)} a month on your default card.`,
  giftEnds: (until: string) =>
    `Free from HandsFreeOS until ${day(until)}. It turns off then, unless you keep it.`,
  trial: (ends: string, cents: number) =>
    `Free trial until ${day(ends)}. Then it’s ${money(cents)} a month.`,
  trialStopping: (ends: string) =>
    `Free trial until ${day(ends)}. It turns off then, and you won’t be charged.`,
  paid: (cents: number, next: string | null) =>
    next ? `${money(cents)} a month. Next payment ${day(next)}.` : `${money(cents)} a month.`,
  paidStopping: (until: string) =>
    `Paid through ${day(until)}. It turns off then, and you won’t be charged again.`,
  pastDue: (cents: number, problem: string | null, offAt: string) =>
    `Your ${money(cents)} payment for it didn’t go through${problem ? `: ${problem.replace(/\.$/, '')}` : ''}. We try your cards again once a day. If none goes through by ${day(offAt)}, it turns off. Add or change a card in Settings → Billing & Usage.`,
  paidUp: (until: string) =>
    `Paid through ${day(until)}. Turn it back on before then and nothing more is charged until that day.`,

  // Turning off a paid one, on the page.
  stopTitle: (name: string) => `Turn off ${name}?`,
  stopTrial: (ends: string) =>
    `Your free trial runs until ${day(ends)}, so it keeps working until then and turns off on its own. You won’t be charged.`,
  stopPaid: (until: string) =>
    `You’ve paid through ${day(until)}, so it keeps working until then and turns off on its own. You won’t be charged again.`,
  stopLater: (at: string) => `Turn off on ${day(at)}`,
  stopNow: 'Turn off now',
  stopNowNote: 'Turning it off now doesn’t refund the rest of the month.',
  stopped: (name: string, at: string) => `${name} turns off on ${day(at)}.`,
  keep: 'Keep it',
  keepAfterGift: (cents: number) => `Keep it after that (${money(cents)} a month)`,
  kept: (name: string) => `${name} stays on.`,
  keptAfterGift: (name: string, until: string) =>
    `${name} stays on after ${day(until)}, on your default card.`,
  /** On the phone, in place of a price or a way to pay (App Store rule 3.1.3(f)). */
  onTheWeb: 'Add it from HandsFreeOS on the web.',
  manageOnTheWeb: 'Manage it from HandsFreeOS on the web.',

  // Settings → Billing & Usage.
  billingTitle: 'Add-ons',
  billingBlurb:
    'Each add-on is charged to your default card on the day of the month you added it. If it’s declined, your backup cards are tried in order.',
  billingNone: 'You don’t pay for any add-ons.',
  billingManage: 'Turn add-ons on and off in Add-ons, at the bottom of the side menu.',
  charged: (cents: number, at: string) => `${money(cents)} on ${day(at)}`,
  recentCharges: 'Recent add-on payments',
} as const;

/** One line on where a business stands with an add-on, or null when there's nothing to say (a free add-on). */
export function addonStandingLine(standing: AddonStanding, trialDaysIfAdded = 0): string | null {
  const W = ADDON_BILLING_WORDS;
  switch (standing.kind) {
    case 'free':
      return null;
    case 'gift':
      if (!standing.until) return W.gift;
      if (standing.priceCents === null) return W.giftUntil(standing.until);
      return standing.keepsAfter
        ? W.giftKeeps(standing.until, standing.priceCents)
        : W.giftEnds(standing.until);
    case 'trial':
      return standing.stopAt
        ? W.trialStopping(standing.stopAt)
        : W.trial(standing.trialEndsAt, standing.priceCents);
    case 'paid':
      return standing.stopAt
        ? W.paidStopping(standing.stopAt)
        : W.paid(standing.priceCents, standing.nextChargeAt);
    case 'past_due':
      return W.pastDue(standing.priceCents, standing.problem, standing.offAt);
    case 'unpaid':
      if (standing.paidThrough) return W.paidUp(standing.paidThrough);
      return W.price(standing.priceCents, standing.trialLeft ? trialDaysIfAdded : 0);
  }
}

/**
 * What adding (or turning back on) a paid add-on would do, for the question asked first: a trial, a charge today, or
 * nothing until a month already paid runs out. `now` is when it's asked.
 */
export function addonStartWords(
  name: string,
  standing: AddonStanding,
  trialDays: number,
  now: Date = new Date(),
): { readonly body: string; readonly button: string } | null {
  const W = ADDON_BILLING_WORDS;
  if (standing.kind !== 'unpaid') return null;
  if (standing.paidThrough)
    return {
      body: W.startPaidUp(name, standing.paidThrough, standing.priceCents),
      button: W.startOnButton,
    };
  if (standing.trialLeft && trialDays > 0)
    return {
      body: W.startTrial(
        name,
        standing.priceCents,
        trialDays,
        new Date(now.getTime() + trialDays * DAY_MS).toISOString(),
      ),
      button: W.startTrialButton,
    };
  return {
    body: W.startPaid(name, standing.priceCents),
    button: W.startPaidButton(standing.priceCents),
  };
}

// ---------- Admin → Businesses → a business: giving add-ons free ----------

/** A gift as `platform.business.get` lists it: `freeUntil` is the midnight (UTC) it ends, null until taken back. */
export interface AddonGiftRecord {
  readonly addonId: string;
  readonly note: string | null;
  readonly freeUntil: string | null;
}

/** A business's subscription to a paid add-on as `platform.business.get` lists it. */
export interface AddonSubscriptionRecord {
  readonly addonId: string;
  readonly status: 'trial' | 'active' | 'past_due' | 'ended';
  readonly priceCents: number;
  readonly trialEndsAt: string | null;
  readonly nextChargeAt: string | null;
  readonly stopAt: string | null;
}

/** One add-on on the Admin page's Give add-ons free list, as staff (and the Assistant) see it. */
export interface AddonGiftRow {
  readonly addonId: string;
  readonly name: string;
  /** "$47 a month" or "free", and "not on sale yet" while only a gift reaches a business. */
  readonly price: string;
  /** Given free now (not taken back, and its last free day hasn't passed). */
  readonly given: boolean;
  /** "Free from HandsFreeOS · they can add it", "Free through Dec 1 · they can add it", "Gift ended …", "Not given". */
  readonly status: string;
  /** What the business pays for it now, if anything. */
  readonly paying: string | null;
  readonly note: string | null;
  /** A live gift's last free day, as a date ("2026-12-01"); null when it lasts until taken back. */
  readonly lastFreeDay: string | null;
}

/**
 * The add-ons staff can give a business free (the owner's pick 6a): one still being built, to try it, and a paid one
 * that's on sale. One switched off or on its way out can't be given (`addon_not_grantable`).
 */
export const addonsToGive = <
  M extends { readonly catalog: { readonly status: string }; readonly billing: AddonBilling },
>(
  catalog: readonly M[],
): M[] =>
  catalog.filter(
    (m) =>
      ['development', 'beta', 'built'].includes(m.catalog.status) ||
      (m.catalog.status === 'available' && addonPriceOf(m) !== null),
  );

const lastDayOf = (freeUntil: string): string =>
  new Date(Date.parse(freeUntil) - DAY_MS).toISOString().slice(0, 10);

/** What a business pays for one add-on now, in staff's words: nothing when it never started or has ended. */
function payingLine(s: AddonSubscriptionRecord | undefined): string | null {
  if (!s || s.status === 'ended') return null;
  if (s.status === 'trial')
    return s.stopAt
      ? `In its free trial, turning off ${day(s.stopAt)}`
      : `In its free trial${s.trialEndsAt ? ` until ${day(s.trialEndsAt)}` : ''}`;
  if (s.status === 'past_due') return 'Its last payment failed; trying their cards daily';
  return s.stopAt
    ? `Paid through ${day(s.stopAt)}, then turning off`
    : `Pays ${money(s.priceCents)} a month${s.nextChargeAt ? `, next ${day(s.nextChargeAt)}` : ''}`;
}

/** The Give add-ons free list for one business: each add-on staff can give, whether it's given, and what it pays. */
export function addonGiftRows(
  catalog: readonly {
    readonly id: string;
    readonly name: string;
    readonly catalog: { readonly status: string };
    readonly billing: AddonBilling;
  }[],
  grants: readonly AddonGiftRecord[],
  subscriptions: readonly AddonSubscriptionRecord[],
  now: Date = new Date(),
): AddonGiftRow[] {
  const live = (g: AddonGiftRecord) => !g.freeUntil || Date.parse(g.freeUntil) > now.getTime();
  return addonsToGive(catalog).map((m) => {
    const g = grants.find((x) => x.addonId === m.id && live(x));
    const gone = grants.find((x) => x.addonId === m.id && !live(x));
    const price = addonPriceOf(m);
    const lastFreeDay = g?.freeUntil ? lastDayOf(g.freeUntil) : null;
    return {
      addonId: m.id,
      name: m.name,
      price: `${price ? `${money(price.monthlyCents)} a month` : 'free'}${m.catalog.status !== 'available' ? ' · not on sale yet' : ''}`,
      given: !!g,
      status: g
        ? `${lastFreeDay ? `Free through ${formatUtcDate(new Date(`${lastFreeDay}T12:00:00Z`))}` : 'Free from HandsFreeOS'} · they can add it`
        : gone?.freeUntil
          ? `Gift ended ${formatUtcDate(new Date(`${lastDayOf(gone.freeUntil)}T12:00:00Z`))}`
          : 'Not given',
      paying: payingLine(subscriptions.find((s) => s.addonId === m.id)),
      note: g?.note ?? null,
      lastFreeDay,
    };
  });
}
