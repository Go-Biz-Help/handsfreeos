'use client';
/**
 * Cancel all (docs/outreach.md, decision 121): every sent request still waiting on a network, however new, cancelled by
 * the person's computer on its own, the oldest first, at the day's limit, leaving out the ones the extension sent
 * unless they untick that. On the Friends tab's Tidy up, and under Today's note when no new requests go for now. The
 * oldest go at once, when their computer can be asked; the rest once a day with its once-a-day jobs.
 */
import { cantAskWhy } from '@hfos/core/addons/outreach/asks';
import { tidyWordsOn } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { Asks, Tidy } from './types';
import { useAct } from './use-act';

/** Starting and stopping it on a network: the command, then an ask for the oldest when the computer can take one. */
export function useCancelAll(workspaceId: string, platform: Platform, asks: Asks) {
  const words = tidyWordsOn(platform).all;
  const { busy, act } = useAct();
  const start = (leaveOutOwn: boolean) =>
    void act('cancel-all', async () => {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.friends.cancel_all', {
          body: { workspaceId, platform, on: true, leaveOutOwn },
        }),
      );
      // Nothing lost when it can't be asked now: the once-a-day job takes them.
      if (out.first.length && cantAskWhy(asks, 'cancel', platform) === null)
        await apiBrowser()
          .POST('/v1/commands/outreach.ask.make', {
            body: { workspaceId, platform, ask: { kind: 'cancel', profileIds: out.first } },
          })
          .catch(() => undefined);
      if (words) toast.success(words.started(out.marked));
    });
  const stop = () =>
    void act(
      'cancel-all',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.friends.cancel_all', {
            body: { workspaceId, platform, on: false },
          }),
        ),
      words?.stopped,
    );
  return { words, busy: busy === 'cancel-all', start, stop };
}

/** Under Old friend requests: what it does, the box to leave out the extension's, and the button; or how it's going. */
export function CancelAllBox({
  workspaceId,
  platform,
  tidy,
  asks,
  warned,
}: {
  workspaceId: string;
  platform: Platform;
  tidy: Tidy;
  asks: Asks;
  warned: boolean;
}) {
  const { words, busy, start, stop } = useCancelAll(workspaceId, platform, asks);
  const [leaveOut, setLeaveOut] = useState(true);
  if (!words) return null;
  const most = tidy.limits.cancel_request.most;
  if (tidy.all)
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="tidy-cancel-all">
        <p className="text-[12.5px] text-text-2" data-testid="tidy-cancel-all-going">
          {words.going(tidy.all.left, most)}
        </p>
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          onClick={stop}
          data-testid="tidy-cancel-all-stop"
        >
          {words.stop}
        </Button>
      </div>
    );
  if (!tidy.waiting) return null;
  const onlyOwn = leaveOut && tidy.extension >= tidy.waiting;
  return (
    <div className="mt-2 grid gap-1.5" data-testid="tidy-cancel-all">
      <p className="text-[12.5px] text-text-3">{words.about(tidy.waiting, most)}</p>
      <label className="flex items-center gap-2 text-[12.5px] text-text-2">
        <input
          type="checkbox"
          checked={leaveOut}
          onChange={(e) => setLeaveOut(e.target.checked)}
          data-testid="tidy-cancel-all-leave-out"
        />
        {words.leaveOut(tidy.extension)}
      </label>
      <div>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={warned || onlyOwn}
          onClick={() => start(leaveOut)}
          data-testid="tidy-cancel-all-start"
        >
          {words.button}
        </Button>
      </div>
    </div>
  );
}

/** Under Today's note: the two ways to start it, the extension's left out first, while it isn't going. */
export function CancelAllButtons({
  workspaceId,
  platform,
  asks,
  waiting,
  extension,
}: {
  workspaceId: string;
  platform: Platform;
  asks: Asks;
  waiting: number;
  extension: number;
}) {
  const { words, busy, start } = useCancelAll(workspaceId, platform, asks);
  if (!words) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="today-cancel-all">
      {extension > 0 && extension < waiting ? (
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          onClick={() => start(true)}
          data-testid="today-cancel-all-leaving-out"
        >
          {words.leavingOut(extension)}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        onClick={() => start(false)}
        data-testid="today-cancel-all-every"
      >
        {words.every(waiting)}
      </Button>
    </div>
  );
}
