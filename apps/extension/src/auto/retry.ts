/**
 * Steps tried again (docs/outreach.md, decision 143). The person presses Retry or Retry all on Steps it needs you for,
 * and a step goes back on Today's list (`retry` on its item): every runner tries it once more for each time it's put
 * back, though it tried it today (./plan.ts `itemKey`).
 *
 * - **Done**, it's noted as any step is, and that clears it.
 * - **Found done already** (connected already, asked already: `skip`), it's cleared: nothing's left to do.
 * - **Anything else**, it's handed back to the person, as a step that didn't go: never left off their list.
 *
 * And once after each update, on its own, everything handed over before it is tried again (`retryAfterUpdate`): the
 * owner, 1 Nov 2026, "we should be fixing those issues after updates". All but a message or comment that didn't go,
 * which could go twice if it went after all: those wait for the person's Retry.
 */
import type { TodayListItem } from '../hfos/messages';
import { api, call } from '../hfos/session';

/** How a runner's step went, as every network's runner says it. */
type Went =
  | { readonly done: boolean; readonly line: string; readonly need?: true; readonly skip?: true }
  | { readonly stop: string };

/**
 * Whether a step that didn't go is handed to the person: one it says they can do themselves, and any tried again that
 * didn't go and wasn't found done already.
 */
export function handsOver(item: Pick<TodayListItem, 'retry'>, outcome: Went): boolean {
  if ('stop' in outcome || outcome.done) return false;
  return outcome.need === true || (item.retry !== undefined && outcome.skip !== true);
}

/** A step tried again found done already (`skip`): it's cleared, as nothing's left to do. Never stops the runner. */
export async function clearRetried(
  item: Pick<TodayListItem, 'retry'>,
  outcome: Went,
  businessId: string,
): Promise<void> {
  if (!item.retry || 'stop' in outcome || outcome.done || outcome.skip !== true) return;
  try {
    await call(
      api().POST('/v1/commands/outreach.need.clear', {
        body: { workspaceId: businessId, needId: item.retry.needId, how: 'done' },
      }),
      businessId,
    );
  } catch (error) {
    // Off the list on its own after a few days, as one never tried again.
    console.warn('HandsFreeOS Social couldn’t clear a step tried again', error);
  }
}

/** Where it keeps, for each business, the version it last tried everything again for. */
export const RETRIED_FOR_KEY = 'hfos-retried-for';

let going: Promise<void> | null = null;

/**
 * Once after each update (a version this business hasn't had everything tried again for): Retry all, on its own, but
 * messages and comments that didn't go. A first start counts, so steps handed over before this build are tried again
 * too. Kept only once it went, so a try
 * that couldn't reach HandsFreeOS goes again next time. Never stops the runner.
 */
export function retryAfterUpdate(businessId: string): Promise<void> {
  going ??= (async () => {
    try {
      const version = chrome.runtime.getManifest().version;
      const kept = ((await chrome.storage.local.get(RETRIED_FOR_KEY))[RETRIED_FOR_KEY] ??
        {}) as Record<string, string>;
      if (kept[businessId] === version) return;
      await call(
        api().POST('/v1/commands/outreach.need.retry', {
          // Not a message or comment that didn't go: one that went after all would go twice, so those wait for a press.
          body: { workspaceId: businessId, needIds: null, sends: false },
        }),
        businessId,
      );
      const now = ((await chrome.storage.local.get(RETRIED_FOR_KEY))[RETRIED_FOR_KEY] ??
        {}) as Record<string, string>;
      await chrome.storage.local.set({ [RETRIED_FOR_KEY]: { ...now, [businessId]: version } });
    } catch (error) {
      console.warn('HandsFreeOS Social couldn’t try again what didn’t go before the update', error);
    } finally {
      going = null;
    }
  })();
  return going;
}
