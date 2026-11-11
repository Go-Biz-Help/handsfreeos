import { EMAIL_SETUP_WORDS as W, holds } from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { EmailSetupFlow } from '@/components/email-setup/email-setup-flow';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { emailSetupCalls, type EmailSetupGot } from '@/email-setup/calls';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

/**
 * Home's "Set up your business email" (the owner's 7a), full screen, as the web's /onboarding/<business>/email: the
 * guided setup's email screens on their own, for a business that finished setting up before the step existed, or
 * whose domain's records are still on their way (`?at=records`). For someone who can change the business's email,
 * and it needs signal.
 */
export default function EmailSetup() {
  const { business } = useBusiness();
  const { at } = useLocalSearchParams<{ at?: string }>();
  const { online } = useNetwork();
  const allowed = holds(useGrants(), 'channels.manage');
  const calls = React.useMemo(() => emailSetupCalls(business.id), [business.id]);
  const colors = useColors();
  const [openAt] = React.useState(at ?? null);
  const [got, setGot] = React.useState<EmailSetupGot | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState(0);

  React.useEffect(() => {
    if (!allowed || !online || got) return;
    let cancelled = false;
    setFailed(null);
    calls
      .get()
      .then((g) => {
        if (!cancelled) setGot(g);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, online, got, calls, asked]);

  if (allowed && got)
    return <EmailSetupFlow workspaceId={business.id} got={got} at={openAt} calls={calls} />;

  return (
    <Screen title={W.homeStartTitle} leading="close" ask={false} testID="email-setup">
      <View className="gap-3 p-1">
        {!allowed ? (
          <Text
            className="text-[15px] font-semibold leading-[21px]"
            testID="email-setup-not-allowed"
          >
            {W.notAllowed}
          </Text>
        ) : !online ? (
          <Text className="text-[15px] font-semibold leading-[21px]" testID="email-setup-offline">
            {P.needsSignal}
          </Text>
        ) : failed ? (
          <>
            <Text className="text-[15px] font-semibold leading-[21px]" testID="email-setup-failed">
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
          <View className="items-center py-16" testID="email-setup-loading">
            <ActivityIndicator color={colors.text3} />
          </View>
        )}
      </View>
    </Screen>
  );
}
