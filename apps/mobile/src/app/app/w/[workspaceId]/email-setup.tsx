import { EMAIL_SETUP_WORDS as W, holds } from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { EmailGuidedFlow } from '@/components/email-setup/guided-flow';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { emailSetupCalls, type EmailGuidedDraft, type EmailSetupGot } from '@/email-setup/calls';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

/**
 * Home's "Set up your business email", full screen, as the web's /onboarding/<business>/email: the guided email
 * setup (the owner, 22 Nov 2026), one question a screen, then the website name's last step. It opens where the
 * person left off, with the answers they gave here or on the web; `?at=records` goes straight to a last step that
 * is still open (`&d=` says which website name's), and `?again=1` opens the questions even then. For someone who
 * can change the business's email, and it needs signal.
 */
export default function EmailSetup() {
  const { business } = useBusiness();
  const params = useLocalSearchParams<{ at?: string; d?: string; again?: string }>();
  const { online } = useNetwork();
  const allowed = holds(useGrants(), 'channels.manage');
  const calls = React.useMemo(() => emailSetupCalls(business.id), [business.id]);
  const colors = useColors();
  // As the screen was opened: what it shows after that is its own.
  const [opened] = React.useState({
    at: params.at ?? null,
    domainId: params.d ?? null,
    again: params.again === '1',
  });
  const [got, setGot] = React.useState<{ got: EmailSetupGot; draft: EmailGuidedDraft } | null>(
    null,
  );
  const [failed, setFailed] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState(0);

  React.useEffect(() => {
    if (!allowed || !online || got) return;
    let cancelled = false;
    setFailed(null);
    Promise.all([calls.get(), calls.draft()])
      .then(([g, draft]) => {
        if (!cancelled) setGot({ got: g, draft });
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
      <EmailGuidedFlow
        workspaceId={business.id}
        got={got.got}
        draft={got.draft}
        at={opened.at}
        domainId={opened.domainId}
        again={opened.again}
        calls={calls}
      />
    );

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
