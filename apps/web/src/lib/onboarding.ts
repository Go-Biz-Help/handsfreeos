import type { ApiClient } from '@hfos/api-client';
import { publicEnv } from './env';
import { supabaseServer } from './supabase/server';
import type { OnboardingStatus } from './api/types';

/**
 * Whether the person signs in faster than with a password: a passkey, or Google. Only the auth server knows, so
 * it's asked only while the guide shows that step as still to do. Anything that goes wrong reads as "not yet".
 */
async function signsInFaster(): Promise<boolean> {
  try {
    const supabase = await supabaseServer();
    const { data } = await supabase.auth.getUser();
    if ((data.user?.identities ?? []).some((i) => i.provider === 'google')) return true;
    if (!publicEnv.passkeysEnabled) return false;
    const list = await supabase.auth.passkey.list();
    return (list.data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Where this person's Getting started guide stands in a business, for Home. A nicety: if the API can't answer (a
 * deploy in flight, a hiccup), Home carries on without the guide.
 */
export async function loadOnboarding(
  api: ApiClient,
  workspaceId: string,
): Promise<OnboardingStatus | null> {
  const ask = (signIn?: boolean) =>
    api
      .POST('/v1/queries/onboarding.status', {
        body: { workspaceId, ...(signIn ? { device: { signIn } } : {}) },
      })
      .then((r) => r.data ?? null)
      .catch(() => null);
  const status = await ask();
  const signIn = status?.steps.find((s) => s.key === 'sign_in');
  if (!status || status.view.finishedAt || !signIn || signIn.state === 'done') return status;
  return (await signsInFaster()) ? ((await ask(true)) ?? status) : status;
}
