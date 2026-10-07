import {
  NEW_ONBOARDING_SETUP_BUSINESS,
  ONBOARDING_SETUP_WORDS as W,
  OnboardingSetupAnswers,
  onboardingSetupBusinessOf,
  onboardingSetupBusinessProblemsOf,
  onboardingSetupDraftLine,
  onboardingSetupHint,
  onboardingSetupProblemsOf,
  onboardingSetupProgress,
  onboardingSetupTitle,
  type AiSetupProblems,
  type OnboardingSetupBusinessDraft,
} from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';

import { businessHref } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { ApiError, errorMessage } from '@/lib/api';
import { loadMe } from '@/lib/businesses';
import { useNetwork } from '@/lib/network';
import { createBusiness, onboardingSetupCalls } from '@/onboarding-setup/calls';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';

import { BusinessScreen } from './business';
import { SetupFrame } from './frame';

/** Today's picks: what the first screen keeps besides the business itself. */
const STARTING = OnboardingSetupAnswers.parse({});
/** Where the first screen sits before anything decides which screens follow. */
const PROGRESS = onboardingSetupProgress('business', STARTING, { website: false, chat: false });

/**
 * "Your business" before there is one, on the phone (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8):
 * straight after signing up, the setup's first screen makes the business (`organization.create`), then saves the rest
 * of its answers to it (`onboarding_setup.save`), so Ava starts reading the website while the next screens are
 * answered on the business's own setup screen. An agency is named on the web, where agencies sign up.
 */
export function CreateBusiness({
  userId,
  trailing,
  onMaking,
}: {
  userId: string;
  /** At the top right: Sign out. */
  trailing?: React.ReactNode;
  /** While the business is being made, so the screen underneath doesn't open another meanwhile. */
  onMaking?: (making: boolean) => void;
}) {
  const { online } = useNetwork();
  const [business, setBusiness] = React.useState<OnboardingSetupBusinessDraft>(
    NEW_ONBOARDING_SETUP_BUSINESS,
  );
  const [problems, setProblems] = React.useState<AiSetupProblems>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** The business once it's made, so trying again after a refusal never makes a second one. */
  const made = React.useRef<string | null>(null);

  function change(next: OnboardingSetupBusinessDraft) {
    setBusiness(next);
    setProblems((p) => (Object.keys(p).length ? {} : p));
  }

  async function next() {
    const found = onboardingSetupBusinessProblemsOf(business);
    if (Object.keys(found).length) {
      setProblems(found);
      return;
    }
    if (!online) {
      setError(P.needsSignal);
      return;
    }
    setBusy(true);
    setError(null);
    onMaking?.(true);
    try {
      const saved = onboardingSetupBusinessOf(business);
      const workspaceId = made.current ?? (await createBusiness({ business: saved }));
      made.current = workspaceId;
      await onboardingSetupCalls(workspaceId).save({
        screen: 'business',
        answers: STARTING,
        business: saved,
      });
      // The business joins the person's list, which its screens open from. A list already on its way when the
      // business was made may not have it yet, so it's asked for again then.
      const me = await loadMe(userId);
      if (!me.businesses.some((b) => b.id === workspaceId)) await loadMe(userId);
      // On to the next screen, named in the address, so it doesn't say "Carry on where you left off".
      router.replace(businessHref(workspaceId, 'setup?at=goal'));
    } catch (e) {
      setProblems(e instanceof ApiError ? onboardingSetupProblemsOf(e.details) : {});
      setError(errorMessage(e));
      setBusy(false);
      onMaking?.(false);
    }
  }

  return (
    <SetupFrame
      screen="business"
      progress={PROGRESS}
      title={onboardingSetupTitle('business', 'Ava')}
      hint={onboardingSetupHint('business', 'Ava')}
      summary={[onboardingSetupDraftLine(business)]}
      leading="none"
      trailing={trailing}
      footer={
        <>
          {error ? <FieldError testID="onboarding-setup-error">{error}</FieldError> : null}
          <Button onPress={() => void next()} loading={busy} testID="onboarding-setup-next">
            {W.next}
          </Button>
        </>
      }
    >
      <BusinessScreen business={business} onChange={change} problems={problems} name="Ava" />
      <Text className="text-[13px] leading-[18px] text-text-3" testID="setup-invited">
        {P.invited}
      </Text>
    </SetupFrame>
  );
}
