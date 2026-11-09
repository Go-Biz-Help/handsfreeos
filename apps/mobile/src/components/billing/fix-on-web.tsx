import type { paths } from '@hfos/api-client';
import {
  BILLING_WORDS as W,
  paymentBlockOf,
  paymentSkipUntil,
  type PaymentBlock,
} from '@hfos/core';
import { usePathname } from 'expo-router';
import * as React from 'react';

import { StateScreen } from '@/components/copy/copy-screens';
import { Laptop } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { api, unwrap } from '@/lib/api';
import { deviceStore } from '@/lib/device-store';

type Status =
  paths['/v1/queries/billing.status']['post']['responses'][200]['content']['application/json'];

/** Asked again at most this often while moving between screens. */
const EVERY_MS = 60_000;
const skipKey = (workspaceId: string) => `paymentSkip.${workspaceId}`;

/**
 * Whether a business's HandsFreeOS account needs fixing on the web before it opens on the phone (20261027023600): a
 * plan payment that didn't go through, past this phone's Skip for now and with no more time given. Asked when the
 * business opens and again as screens change, at most once a minute. A failed ask leaves the business open.
 */
export function usePaymentBlock(workspaceId: string, enabled: boolean) {
  const pathname = usePathname();
  const [status, setStatus] = React.useState<Status | null>(null);
  const [round, setRound] = React.useState(0);
  const [skipped, setSkipped] = React.useState<string | null>(
    () => deviceStore.get<string>(skipKey(workspaceId)) ?? null,
  );
  const asked = React.useRef(0);
  const lastRound = React.useRef(-1);
  React.useEffect(() => {
    if (!enabled) return;
    // Check again (and the first look) always asks; moving between screens asks at most once a minute.
    if (round === lastRound.current && Date.now() - asked.current < EVERY_MS) return;
    lastRound.current = round;
    asked.current = Date.now();
    let gone = false;
    void api
      .POST('/v1/queries/billing.status', { body: { workspaceId } })
      .then(unwrap)
      .then((s) => {
        if (!gone) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [enabled, pathname, round, workspaceId]);

  const block: PaymentBlock | null =
    enabled && status ? paymentBlockOf(status.owed, new Date(), skipped) : null;
  return {
    block: block?.show ? block : null,
    status,
    skip: () => {
      if (!status?.owed) return;
      const until = paymentSkipUntil(status.owed, new Date());
      deviceStore.set(skipKey(workspaceId), until);
      setSkipped(until);
    },
    check: () => setRound((r) => r + 1),
  };
}

/**
 * The phone's side of the failed-payment page: no price, no payment and no link, as the stores ask of an app that
 * doesn't sell inside itself, only that it's fixed on the web. Skip for now while it may still be skipped.
 */
export function FixOnTheWeb({
  block,
  askWho,
  canManage,
  onSkip,
  onCheck,
}: {
  block: PaymentBlock;
  askWho: string | null;
  canManage: boolean;
  onSkip: () => void;
  onCheck: () => void;
}) {
  const { business, me, openSwitcher } = useBusiness();
  const others = me.businesses.some((b) => b.id !== business.id);
  const body = canManage ? W.phoneBlockBody(business.name) : W.phoneBlockAsk(business.name, askWho);
  return (
    <StateScreen
      icon={Laptop}
      tone="warning"
      title={W.phoneBlockTitle}
      body={`${body} ${block.canSkip ? W.phoneSkipHint(block.lockedAt) : W.phoneLocked}`}
      testID="fix-on-web"
      actions={
        <>
          {block.canSkip ? (
            <Button onPress={onSkip} testID="fix-on-web-skip">
              {W.skip}
            </Button>
          ) : null}
          <Button variant="secondary" onPress={onCheck} testID="fix-on-web-check">
            {W.phoneCheck}
          </Button>
          {others ? (
            <Button variant="ghost" onPress={openSwitcher} testID="fix-on-web-switch">
              {W.otherBusiness}
            </Button>
          ) : null}
        </>
      }
    />
  );
}
