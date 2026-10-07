'use client';
/**
 * "Your business" before there is one (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7): straight after
 * signing up, the setup's first screen makes the business (`organization.create`), then saves the rest of its answers
 * to it (`onboarding_setup.save`), so Ava starts reading the website while the next screens are answered on the
 * business's own setup page. Someone who runs an agency names it here too.
 */
import {
  NEW_ONBOARDING_SETUP_BUSINESS,
  ONBOARDING_SETUP_STOP_NAMES,
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
  type IndustryId,
  type OnboardingSetupBusinessDraft,
} from '@hfos/core';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { publicEnv } from '@/lib/env';
import { onboardingSetupActions } from '@/lib/onboarding-setup/actions';
import { onboardingSetupHref } from '@/lib/onboarding-setup/data';
import { BusinessScreen } from './business';
import { SetupCard } from './frame';

/** Today's picks: what the first screen keeps besides the business itself. */
const STARTING = OnboardingSetupAnswers.parse({});
/** Where the first screen sits before anything decides which screens follow. */
const PROGRESS = onboardingSetupProgress('business', STARTING, {
  website: false,
  page: false,
  chat: false,
});

export function CreateBusiness() {
  const router = useRouter();
  const [business, setBusiness] = useState<OnboardingSetupBusinessDraft>(
    NEW_ONBOARDING_SETUP_BUSINESS,
  );
  const [agency, setAgency] = useState(false);
  const [agencyName, setAgencyName] = useState('');
  const [problems, setProblems] = useState<AiSetupProblems>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The business once it's made, so trying again after a refusal never makes a second one. */
  const made = useRef<string | null>(null);

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
    setBusy(true);
    setError(null);
    try {
      const saved = onboardingSetupBusinessOf(business);
      const workspaceId =
        made.current ??
        unwrap(
          await apiBrowser().POST('/v1/commands/organization.create', {
            body: {
              businessName: saved.name,
              organizationName: agency && agencyName.trim() ? agencyName.trim() : undefined,
              timezone: saved.timezone,
              industry: saved.industry as IndustryId,
            },
          }),
        ).workspaceId;
      made.current = workspaceId;
      await onboardingSetupActions(workspaceId).save({
        screen: 'business',
        answers: STARTING,
        business: saved,
      });
      // On to the next screen, named in the address, so it doesn't say "Carry on where you left off".
      router.replace(onboardingSetupHref(workspaceId, 'goal'));
      router.refresh();
    } catch (e) {
      setProblems(e instanceof ApiError ? onboardingSetupProblemsOf(e.details) : {});
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <SetupCard
      screen="business"
      counter={`${W.position(PROGRESS.at, PROGRESS.of)} · ${ONBOARDING_SETUP_STOP_NAMES.business}`}
      title={onboardingSetupTitle('business', 'Ava')}
      hint={onboardingSetupHint('business', 'Ava')}
      summary={[onboardingSetupDraftLine(business)]}
      footer={
        <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
          {error ? <FieldError>{error}</FieldError> : null}
          <div className="flex justify-end">
            <Button
              size="lg"
              onClick={() => void next()}
              loading={busy}
              data-testid="onboarding-setup-next"
            >
              {W.next}
              <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        </div>
      }
    >
      <BusinessScreen business={business} onChange={change} problems={problems} name="Ava" />
      {publicEnv.agencySignupEnabled ? (
        <div className="flex flex-col gap-3">
          <label className="flex cursor-pointer items-start gap-3 rounded-menu border border-border bg-card-2 p-3.5">
            <Switch
              checked={agency}
              onChange={setAgency}
              label={W.agency}
              className="mt-0.5"
              testId="setup-agency"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{W.agency}</span>
              <span className="text-[13px] text-text-3">{W.agencyHint}</span>
            </span>
          </label>
          {agency ? (
            <Field
              label={W.agencyName}
              htmlFor="setup-agency-name"
              hint={W.agencyNameHint(business.name.trim() || W.unnamed.toLowerCase())}
            >
              <Input
                id="setup-agency-name"
                inputSize="lg"
                placeholder="Go Biz Help"
                value={agencyName}
                maxLength={120}
                onChange={(e) => setAgencyName(e.target.value)}
                data-testid="setup-agency-name"
              />
            </Field>
          ) : null}
        </div>
      ) : null}
    </SetupCard>
  );
}
