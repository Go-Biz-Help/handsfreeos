import { GUIDE_WORDS, holds } from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { OnboardingQuickSetup } from '@/components/onboarding-setup/quick-setup';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useGrants } from '@/lib/grants';
import { onboardingSetupCalls } from '@/onboarding-setup/calls';
import { useOnboardingSetupStart } from '@/onboarding-setup/use-onboarding-setup';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

/**
 * Setting up the business, full screen (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8), as the web's
 * /onboarding/<business>: where a new business goes once it's made, and where Home's Getting started card points
 * until it's finished. `?at=` is the screen it's on, and `?part=owner` walks only the owner's part of a business its
 * agency set up. It's for people who set the business up, and it needs signal: everything it asks and keeps is
 * HandsFreeOS's, so it carries on what was started on the computer.
 */
export default function OnboardingSetup() {
  const { business } = useBusiness();
  const { at, part } = useLocalSearchParams<{ at?: string; part?: string }>();
  const grants = useGrants();
  const allowed = holds(grants, 'workspace.update');
  const calls = React.useMemo(() => onboardingSetupCalls(business.id), [business.id]);
  const { start, retry } = useOnboardingSetupStart(calls, allowed);
  const colors = useColors();
  // Where it opened: later moves change `?at=` and `?part=` too, which mustn't open it somewhere else.
  const [openAt] = React.useState(at ?? null);
  const [openPart] = React.useState(part ?? null);

  if (allowed && start.state === 'ready')
    return (
      <OnboardingQuickSetup
        workspaceId={business.id}
        got={start.got}
        findings={start.findings}
        at={openAt}
        part={openPart}
        calls={calls}
      />
    );

  return (
    <Screen title={GUIDE_WORDS.setUp.title} leading="close" ask={false} testID="onboarding-setup">
      {!allowed ? (
        <Waiting
          title={P.notAllowed}
          body={P.notAllowedHint}
          testID="onboarding-setup-not-allowed"
        />
      ) : start.state === 'loading' ? (
        <View className="items-center py-16" testID="onboarding-setup-loading">
          <ActivityIndicator color={colors.text3} />
        </View>
      ) : start.state === 'offline' ? (
        <Waiting title={P.needsSignal} testID="onboarding-setup-offline" />
      ) : (
        <Waiting
          title={start.state === 'failed' ? start.message : ''}
          action={{ label: P.tryAgain, onPress: retry }}
          testID="onboarding-setup-failed"
        />
      )}
    </Screen>
  );
}

function Waiting({
  title,
  body,
  action,
  testID,
}: {
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  testID: string;
}) {
  return (
    <View className="gap-3 p-1" testID={testID}>
      <Text className="text-[15px] font-semibold leading-[21px]">{title}</Text>
      {body ? <Text className="text-[13px] leading-[18px] text-text-2">{body}</Text> : null}
      {action ? (
        <Button variant="secondary" className="self-start" onPress={action.onPress}>
          {action.label}
        </Button>
      ) : null}
    </View>
  );
}
