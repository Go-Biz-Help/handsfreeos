import { holds, type LifecycleAction, type SuggestionChoice } from '@hfos/core';
import * as React from 'react';

import { api, errorMessage, unwrap } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';

import { anyBusy, type AddonGrants } from './rules';
import type { AddonImpact, AddonList, AddonMoved, AddonSettings, AddonSuggestion } from './types';
import { ADDON_PHONE_WORDS } from './words';

/**
 * Add-ons on the phone: what `addon.list`, `addon.impact`, `addon.settings` and `addon.suggestion` answer, and the
 * moves a person makes.
 *
 * **None of it is in the phone's copy, and none of it goes into the queue of changes.** Installing an add-on or
 * turning one off changes what everybody in the business sees, and the worker finishes it within seconds; a move
 * made with no signal and sent hours later would be a surprise to all of them. So every screen here is live or says
 * it needs signal, and every move goes straight out and says so when it can't, as the balance's do.
 */

/** What this person may do with add-ons in the business open now. */
export function useAddonGrants(): AddonGrants {
  const grants = useGrants();
  return React.useMemo(
    () => ({ manage: holds(grants, 'addons.manage'), purge: holds(grants, 'addons.purge') }),
    [grants],
  );
}

export interface Live<T> {
  readonly data: T | null;
  /** Nothing to show yet, and an answer on its way. */
  readonly loading: boolean;
  /** Words for what went wrong, or that it needs signal. Null while it's fine. */
  readonly error: string | null;
  /** How many times it has been asked and answered (or failed): each one is a moment to decide what's next. */
  readonly settled: number;
  reload(): void;
}

/**
 * One answer from HandsFreeOS, asked again when `key` changes, on `reload`, and when the phone comes back into
 * signal on the screen. `load` null asks nothing (someone who may not see it).
 */
function useLive<T>(load: (() => Promise<T>) | null, key: string): Live<T> {
  const { online } = useNetwork();
  const [data, setData] = React.useState<{ key: string; value: T } | null>(null);
  const [loading, setLoading] = React.useState(load !== null);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);
  const [settled, setSettled] = React.useState(0);
  const latest = React.useRef(load);
  latest.current = load;
  const asks = load !== null;

  React.useEffect(() => {
    const ask = latest.current;
    if (!ask) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    ask()
      .then((value) => {
        if (!cancelled) setData({ key, value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(online ? errorMessage(e) : ADDON_PHONE_WORDS.needsSignal);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setSettled((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [asks, key, online, round]);

  // An answer for another add-on or another business is not an answer for this one.
  const value = asks && data && data.key === key ? data.value : null;
  return {
    data: value,
    loading: loading && value === null,
    error,
    settled,
    reload: React.useCallback(() => setRound((r) => r + 1), []),
  };
}

/** How often the list is asked again while an add-on is on its way somewhere, and how many times at most. */
export const BUSY_POLL_MS = 3_000;
export const BUSY_POLLS = 40;

/**
 * What the business has and could have (`addon.list`), for someone who manages add-ons. While any add-on is on its
 * way somewhere (setting up, uninstalling, deleting its data) it is asked again every few seconds for a couple of
 * minutes, since the worker moves it on by itself; `reload` after a move starts that again.
 */
export function useAddonList(workspaceId: string, manages: boolean): Live<AddonList> {
  const { online } = useNetwork();
  const live = useLive(
    manages
      ? () => api.POST('/v1/queries/addon.list', { body: { workspaceId } }).then(unwrap)
      : null,
    `list:${workspaceId}`,
  );
  const polls = React.useRef(BUSY_POLLS);
  const { data, settled, reload: again } = live;
  const busy = data !== null && anyBusy(data);

  React.useEffect(() => {
    // Each ask that settles sets up the next while something is still on its way (a failed one too: the last answer
    // still says it's busy).
    if (!busy || !online || polls.current <= 0) return;
    const timer = setTimeout(() => {
      polls.current -= 1;
      again();
    }, BUSY_POLL_MS);
    return () => clearTimeout(timer);
  }, [busy, settled, online, again]);

  const reload = React.useCallback(() => {
    polls.current = BUSY_POLLS;
    again();
  }, [again]);
  return { ...live, reload };
}

/** An add-on's switches and settings here (`addon.settings`): only asked while it's on, when it has switches. */
export function useAddonSettings(
  workspaceId: string,
  addonId: string,
  ask: boolean,
): Live<AddonSettings> {
  return useLive(
    ask
      ? () =>
          api.POST('/v1/queries/addon.settings', { body: { workspaceId, addonId } }).then(unwrap)
      : null,
    `settings:${workspaceId}:${addonId}`,
  );
}

/**
 * What a move would do (`addon.impact`), asked each time a question about one opens (`round`), so what it shows is
 * what is true now.
 */
export function useAddonImpact(
  workspaceId: string,
  ask: { addonId: string; action: LifecycleAction; round: number } | null,
): Live<AddonImpact> {
  return useLive(
    ask
      ? () =>
          api
            .POST('/v1/queries/addon.impact', {
              body: { workspaceId, addonId: ask.addonId, action: ask.action },
            })
            .then(unwrap)
      : null,
    ask ? `impact:${workspaceId}:${ask.addonId}:${ask.action}:${ask.round}` : 'impact:none',
  );
}

type Move = Exclude<LifecycleAction, 'purge'>;

/** The moves, straight out. Each answers with every add-on that moved, in the order it moved. */
export const addonCommands = {
  async move(
    workspaceId: string,
    addonId: string,
    action: Move,
    include: readonly string[],
  ): Promise<readonly AddonMoved[]> {
    const body = { workspaceId, addonId, include: [...include] };
    switch (action) {
      case 'install':
        return unwrap(await api.POST('/v1/commands/addon.install', { body })).moved;
      case 'enable':
        return unwrap(await api.POST('/v1/commands/addon.enable', { body })).moved;
      case 'disable':
        return unwrap(await api.POST('/v1/commands/addon.disable', { body })).moved;
      case 'uninstall':
        return unwrap(await api.POST('/v1/commands/addon.uninstall', { body })).moved;
    }
  },
  /** Deleting an add-on's data for good: owners only, with its name typed out. */
  async purge(
    workspaceId: string,
    addonId: string,
    confirmName: string,
  ): Promise<readonly AddonMoved[]> {
    return unwrap(
      await api.POST('/v1/commands/addon.purge', { body: { workspaceId, addonId, confirmName } }),
    ).moved;
  },
  async saveFlags(
    workspaceId: string,
    addonId: string,
    flags: Readonly<Record<string, boolean>>,
  ): Promise<void> {
    unwrap(
      await api.POST('/v1/commands/addon.save_settings', {
        body: { workspaceId, addonId, flags: { ...flags } },
      }),
    );
  },
  async dismissSuggestion(
    workspaceId: string,
    addonId: string,
    choice: SuggestionChoice,
  ): Promise<void> {
    unwrap(
      await api.POST('/v1/commands/addon.dismiss_suggestion', {
        body: { workspaceId, addonId, choice },
      }),
    );
  },
};

/**
 * How long Home keeps the answer to "is there an add-on to suggest?". HandsFreeOS decides when one shows (rarely, and
 * never soon after one was set aside); this only saves asking every time Home opens.
 */
export const SUGGESTION_EVERY_MS = 30 * 60_000;

/** Each person's answer in each business: a suggestion, and setting one aside, are a person's own. */
const suggestionKept = new Map<string, { at: number; suggestion: AddonSuggestion | null }>();

/** Forget what Home was told (for tests). */
export function forgetAddonSuggestions(): void {
  suggestionKept.clear();
}

export interface SuggestionView {
  readonly suggestion: AddonSuggestion | null;
  /** Sets the card aside at once, and tells HandsFreeOS; it comes back if HandsFreeOS can't be told. */
  dismiss(choice: SuggestionChoice): Promise<void>;
}

/**
 * The one add-on Home may suggest (`addon.suggestion`). Asked only for someone who manages add-ons (nobody else
 * ever hears of one) and only with signal; the answer is kept a while.
 */
export function useAddonSuggestion(
  workspaceId: string,
  userId: string,
  manages: boolean,
): SuggestionView {
  const { online } = useNetwork();
  const key = `${userId}:${workspaceId}`;
  const [kept, setKept] = React.useState(() => suggestionKept.get(key) ?? null);
  const fresh = kept !== null && Date.now() - kept.at < SUGGESTION_EVERY_MS;

  React.useEffect(() => {
    setKept(suggestionKept.get(key) ?? null);
  }, [key]);

  React.useEffect(() => {
    if (!manages || !online || fresh) return;
    let cancelled = false;
    api
      .POST('/v1/queries/addon.suggestion', { body: { workspaceId } })
      .then(unwrap)
      .then((answer) => {
        const next = { at: Date.now(), suggestion: answer.suggestion };
        suggestionKept.set(key, next);
        if (!cancelled) setKept(next);
      })
      // No card is the right answer to anything going wrong here.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fresh, key, manages, online, workspaceId]);

  const suggestion = manages ? (kept?.suggestion ?? null) : null;
  const dismiss = React.useCallback(
    async (choice: SuggestionChoice) => {
      const was = suggestionKept.get(key) ?? null;
      if (!was?.suggestion) return;
      const cleared = { at: Date.now(), suggestion: null };
      suggestionKept.set(key, cleared);
      setKept(cleared);
      try {
        await addonCommands.dismissSuggestion(workspaceId, was.suggestion.addonId, choice);
      } catch (e) {
        suggestionKept.set(key, was);
        setKept(was);
        throw e;
      }
    },
    [key, workspaceId],
  );
  return { suggestion, dismiss };
}
