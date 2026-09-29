import type { paths } from '@hfos/api-client';
import * as React from 'react';

import { api, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { useNetwork } from '@/lib/network';
import { supabase } from '@/lib/supabase';
import { usePushRegistration } from '@/push/hooks';

export type OnboardingStatus =
  paths['/v1/queries/onboarding.status']['post']['responses']['200']['content']['application/json'];
export type OnboardingStep = OnboardingStatus['steps'][number];

/** How long Home keeps what it was told before asking again (it asks again after anything done here). */
const EVERY_MS = 2 * 60_000;

/** Each person's guide in each business, kept between visits to Home. */
const kept = new Map<string, { at: number; status: OnboardingStatus | null }>();

/** Forget what Home was told (for tests). */
export function forgetGettingStarted(): void {
  kept.clear();
}

/**
 * Whether the person signs in faster than with a password: Google, or a passkey. The phone knows it from the
 * sign-in it holds; anything that goes wrong reads as "not yet".
 */
async function signsInFaster(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    const identities = data.session?.user.identities ?? [];
    if (identities.some((i) => i.provider === 'google')) return true;
    if (!config.passkeysEnabled) return false;
    const list = await supabase.auth.passkey.list();
    return (list.data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export interface GettingStartedView {
  /** Null until HandsFreeOS has answered, and whenever it can't (no signal, a hiccup): Home carries on without. */
  readonly status: OnboardingStatus | null;
  /** What only the phone knows, as `onboarding.status` and `onboarding.finish` take it. */
  readonly device: { app: true; notifications?: boolean; signIn?: boolean };
  /** Asks again now: after a step is done, skipped or sent. */
  reload(): void;
}

/**
 * Getting started on the phone's Home (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, boards 9 and 10): the same
 * `onboarding.status` the web reads, asked of HandsFreeOS rather than the phone's copy, only with signal. The
 * phone tells it what only the phone knows: that this is the app, and whether its notifications are allowed.
 */
export function useGettingStarted(workspaceId: string, userId: string): GettingStartedView {
  const { online } = useNetwork();
  const { permission } = usePushRegistration();
  const key = `${userId}:${workspaceId}`;
  const [shown, setShown] = React.useState(() => kept.get(key) ?? null);
  const [asked, setAsked] = React.useState(0);
  const notifications =
    permission === 'granted' ? true : permission === 'denied' ? false : undefined;
  const fresh = shown !== null && Date.now() - shown.at < EVERY_MS;

  React.useEffect(() => {
    setShown(kept.get(key) ?? null);
  }, [key]);

  const [signIn, setSignIn] = React.useState<boolean | undefined>(undefined);
  React.useEffect(() => {
    let cancelled = false;
    void signsInFaster().then((yes) => {
      if (!cancelled) setSignIn(yes || undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const device = React.useMemo(
    () => ({
      app: true as const,
      ...(notifications === undefined ? {} : { notifications }),
      ...(signIn ? { signIn } : {}),
    }),
    [notifications, signIn],
  );

  // Asked again after anything done here, and when notifications are turned on or off in the phone's settings.
  React.useEffect(() => {
    if (!online || (fresh && asked === 0)) return;
    let cancelled = false;
    api
      .POST('/v1/queries/onboarding.status', { body: { workspaceId, device } })
      .then(unwrap)
      .then((status) => {
        const next = { at: Date.now(), status };
        kept.set(key, next);
        if (!cancelled) setShown(next);
      })
      // No guide is the right answer to anything going wrong here.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Not on `fresh`, which flips as the answer arrives: asking again is what `asked` and the device facts are for.
  }, [online, key, workspaceId, device, asked]);

  const reload = React.useCallback(() => setAsked((n) => n + 1), []);
  return { status: shown?.status ?? null, device, reload };
}
