import type { AiSetupFinding } from '@hfos/core';
import * as React from 'react';

import { ApiError, errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';

import type { AiSetupCalls, AiSetupGot } from './calls';

/** Where quick setup stands as it opens. */
export type AiSetupStart =
  | { readonly state: 'loading' }
  /** No signal, or it went before HandsFreeOS answered: it asks again once the phone is back online. */
  | { readonly state: 'offline' }
  | { readonly state: 'failed'; readonly message: string; readonly rule: string | null }
  | {
      readonly state: 'ready';
      readonly got: AiSetupGot;
      readonly findings: readonly AiSetupFinding[];
    };

/**
 * What quick setup opens on (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): where it stands
 * (`ai_setup.get`) and what the website scan found, asked of HandsFreeOS each time it opens, since what someone
 * answered on the computer is kept there. It needs signal: without, it says so and asks again once it's back.
 * `enabled` is false for someone who can't run it, who isn't asked at all.
 */
export function useAiSetupStart(
  calls: AiSetupCalls,
  enabled = true,
): { readonly start: AiSetupStart; readonly retry: () => void } {
  const { online } = useNetwork();
  const [start, setStart] = React.useState<AiSetupStart>(
    online ? { state: 'loading' } : { state: 'offline' },
  );
  const [asked, setAsked] = React.useState(0);
  const ready = start.state === 'ready';

  React.useEffect(() => {
    if (!enabled || ready) return;
    if (!online) {
      setStart({ state: 'offline' });
      return;
    }
    let cancelled = false;
    setStart({ state: 'loading' });
    Promise.all([calls.get(), calls.findings()])
      .then(([got, findings]) => {
        if (!cancelled) setStart({ state: 'ready', got, findings });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A request that never reached HandsFreeOS is no signal; anything else is what it said.
        setStart(
          e instanceof TypeError
            ? { state: 'offline' }
            : {
                state: 'failed',
                message: errorMessage(e),
                rule: e instanceof ApiError ? e.rule : null,
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [calls, enabled, online, asked, ready]);

  const retry = React.useCallback(() => setAsked((n) => n + 1), []);
  return { start, retry };
}
