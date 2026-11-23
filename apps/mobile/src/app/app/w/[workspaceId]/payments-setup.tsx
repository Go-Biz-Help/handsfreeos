import {
  addressLines,
  businessAddressOf,
  holds,
  paymentsSetupContextFrom,
  PAYMENTS_SETUP_WORDS as W,
  type PaymentsSetupContext,
} from '@hfos/core';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { PaymentsGuidedFlow } from '@/components/payments-setup/guided-flow';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { errorMessage } from '@/lib/api';
import { config } from '@/lib/config';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { paymentsSetupCalls, type PaymentsGuidedDraft } from '@/payments-setup/calls';
import { useColors } from '@/theme';

/**
 * Getting started's "Connect payments", full screen, as the web's /onboarding/<business>/payments: the guided payments
 * setup (the owner, 23 Nov 2026, P4 a), one question a screen, Save, then the Stripe or Square sign-in. It opens where
 * the person left off, with the answers they gave here or on the web. For someone who can change the business's
 * payments, and it needs signal.
 */
export default function PaymentsSetup() {
  const { business, me } = useBusiness();
  const { online } = useNetwork();
  const allowed = holds(useGrants(), 'money.manage');
  const calls = React.useMemo(() => paymentsSetupCalls(business.id), [business.id]);
  const colors = useColors();
  const [got, setGot] = React.useState<{
    ctx: PaymentsSetupContext;
    industry: string | null;
    draft: PaymentsGuidedDraft;
  } | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState(0);

  React.useEffect(() => {
    if (!allowed || !online || got) return;
    let cancelled = false;
    setFailed(null);
    Promise.all([calls.business(), calls.money(), calls.connections(), calls.draft()])
      .then(([biz, money, connections, draft]) => {
        if (cancelled) return;
        const address = businessAddressOf(biz.settings);
        setGot({
          ctx: paymentsSetupContextFrom({
            connections,
            payPalOpen: config.payPalEnabled,
            money,
            setupAddress: address ? addressLines(address) : null,
          }),
          industry: biz.industry,
          draft,
        });
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
      <PaymentsGuidedFlow
        workspaceId={business.id}
        businessName={business.name}
        firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
        industry={got.industry}
        ctx={got.ctx}
        draft={got.draft}
        calls={calls}
      />
    );

  return (
    <Screen title={W.pageTitle} leading="close" ask={false} testID="payments-setup">
      <View className="gap-3 p-1">
        {!allowed ? (
          <>
            <Text
              className="text-[15px] font-semibold leading-[21px]"
              testID="payments-setup-not-allowed"
            >
              {W.notAllowed}
            </Text>
            <Text className="text-[14px] text-text-2">{W.notAllowedHint}</Text>
          </>
        ) : !online ? (
          <Text
            className="text-[15px] font-semibold leading-[21px]"
            testID="payments-setup-offline"
          >
            {P.needsSignal}
          </Text>
        ) : failed ? (
          <>
            <Text
              className="text-[15px] font-semibold leading-[21px]"
              testID="payments-setup-failed"
            >
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
          <View className="items-center py-16" testID="payments-setup-loading">
            <ActivityIndicator color={colors.text3} />
          </View>
        )}
      </View>
    </Screen>
  );
}
