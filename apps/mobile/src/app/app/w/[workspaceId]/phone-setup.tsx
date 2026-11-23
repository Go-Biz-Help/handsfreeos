import { businessAddressOf, holds, PHONE_SETUP_WORDS as W } from '@hfos/core';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { PhoneGuidedFlow } from '@/components/phone-setup/guided-flow';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useWorkspaceRow } from '@/home/use-home';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { phoneSetupCalls, type PhoneGuidedDraft, type PhoneSetupStatus } from '@/phone-setup/calls';
import { PHONE_SETUP_PHONE_WORDS as PW } from '@/phone-setup/words';
import { useColors } from '@/theme';

/**
 * Getting started's "Get your business number", full screen, as the web's /onboarding/<business>/phone: the guided
 * phone number setup (the owner, 22 Nov 2026), one question a screen, with the number bought on the last one. It
 * opens where the person left off, with the answers they gave here or on the web. For someone who can change the
 * business's texting and calls, and it needs signal.
 */
export default function PhoneSetup() {
  const { business, me } = useBusiness();
  const { online } = useNetwork();
  const allowed = holds(useGrants(), 'channels.manage');
  const calls = React.useMemo(() => phoneSetupCalls(business.id), [business.id]);
  const colors = useColors();
  const { settings } = useWorkspaceRow();
  const near = React.useMemo(() => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = settings ? (JSON.parse(settings) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    const address = businessAddressOf(parsed);
    return address ? { city: address.city, state: address.state } : null;
  }, [settings]);
  const [got, setGot] = React.useState<{
    status: PhoneSetupStatus;
    draft: PhoneGuidedDraft;
  } | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState(0);

  React.useEffect(() => {
    if (!allowed || !online || got) return;
    let cancelled = false;
    setFailed(null);
    Promise.all([calls.status(), calls.draft()])
      .then(([status, draft]) => {
        if (!cancelled) setGot({ status, draft });
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, online, got, calls, asked]);

  if (allowed && got)
    return (
      <PhoneGuidedFlow
        workspaceId={business.id}
        businessName={business.name}
        firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
        near={near}
        status={got.status}
        draft={got.draft}
        calls={calls}
      />
    );

  return (
    <Screen title={W.startCard.title} leading="close" ask={false} testID="phone-setup">
      <View className="gap-3 p-1">
        {!allowed ? (
          <>
            <Text
              className="text-[15px] font-semibold leading-[21px]"
              testID="phone-setup-not-allowed"
            >
              {PW.notAllowed}
            </Text>
            <Text className="text-[14px] text-text-2">{PW.notAllowedHint}</Text>
          </>
        ) : !online ? (
          <Text className="text-[15px] font-semibold leading-[21px]" testID="phone-setup-offline">
            {P.needsSignal}
          </Text>
        ) : failed ? (
          <>
            <Text className="text-[15px] font-semibold leading-[21px]" testID="phone-setup-failed">
              {failed}
            </Text>
            <Button
              variant="secondary"
              className="self-start"
              onPress={() => setAsked((n) => n + 1)}
            >
              {P.tryAgain}
            </Button>
          </>
        ) : (
          <View className="items-center py-16" testID="phone-setup-loading">
            <ActivityIndicator color={colors.text3} />
          </View>
        )}
      </View>
    </Screen>
  );
}
