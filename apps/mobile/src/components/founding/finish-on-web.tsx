import { FOUNDING_PICK_WORDS as W } from '@hfos/core';
import * as React from 'react';

import { StateScreen } from '@/components/copy/copy-screens';
import { Laptop } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { SignOutSheet } from '@/components/shell/sign-out-sheet';
import { Button } from '@/components/ui/button';
import { loadMe } from '@/lib/businesses';

/**
 * A business made while founding spots are on sale picks one and pays on the web before it opens (20261027012700).
 * The phone never sells: it says to finish on a computer, with no price and no link, as the stores ask of an app that
 * doesn't sell inside itself. Check again asks `account.me` once more, for when it was paid a moment ago.
 */
export function FinishOnTheWeb() {
  const { business, me, userId, openSwitcher } = useBusiness();
  const [checking, setChecking] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const others = me.businesses.some((b) => b.id !== business.id);
  return (
    <StateScreen
      icon={Laptop}
      title={W.phoneTitle}
      body={W.phoneBody(business.name)}
      testID="finish-on-web"
      actions={
        <>
          <Button
            loading={checking}
            onPress={() => {
              setChecking(true);
              void loadMe(userId)
                .catch(() => undefined)
                .finally(() => setChecking(false));
            }}
            testID="finish-on-web-check"
          >
            {W.phoneCheck}
          </Button>
          {others ? (
            <Button variant="secondary" onPress={openSwitcher} testID="finish-on-web-switch">
              {W.phoneOther}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            onPress={() => setSigningOut(true)}
            testID="finish-on-web-sign-out"
          >
            {W.signOut}
          </Button>
          <SignOutSheet open={signingOut} onClose={() => setSigningOut(false)} />
        </>
      }
    />
  );
}
