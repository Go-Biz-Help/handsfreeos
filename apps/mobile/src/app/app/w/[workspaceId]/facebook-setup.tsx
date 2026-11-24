import { FACEBOOK_SETUP_WORDS as W, holds, type FacebookSetupContext } from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import {
  FacebookGuidedFlow,
  FacebookPhoneOverview,
  FacebookPhoneTest,
} from '@/components/facebook-setup/guided-flow';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { facebookSetupCalls, type FacebookGuidedDraft } from '@/facebook-setup/calls';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

/**
 * Settings → Facebook & Instagram on the phone, full screen, as the web's /onboarding/<business>/facebook and its
 * Settings card (the owner, 24 Nov 2026, F4 a): with nothing connected, the guided setup, one question a screen, then
 * Connect with Facebook, whose sign-in opens in the phone's browser and comes back here to Send yourself a test
 * message; with a Page connected (and no answers half given), what's connected, Send a test message, Connect more, and
 * the answers with Go through the questions again. It opens where the person left off, with the answers they gave
 * here or on the web. For someone who can change the business's channels, and it needs signal.
 */
export default function FacebookSetup() {
  const { business, me } = useBusiness();
  const { online } = useNetwork();
  const allowed = holds(useGrants(), 'channels.manage');
  const calls = React.useMemo(() => facebookSetupCalls(business.id), [business.id]);
  const colors = useColors();
  const [got, setGot] = React.useState<{
    ctx: FacebookSetupContext;
    draft: FacebookGuidedDraft;
  } | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState(0);
  const [view, setView] = React.useState<
    { at: 'questions' } | { at: 'overview' } | { at: 'test'; instagram: boolean } | null
  >(null);

  React.useEffect(() => {
    if (!allowed || !online || got) return;
    let cancelled = false;
    setFailed(null);
    Promise.all([calls.load(), calls.draft()])
      .then(([ctx, draft]) => {
        if (cancelled) return;
        setGot({ ctx, draft });
        setView(ctx.mode === 'again' && !draft.answers ? { at: 'overview' } : { at: 'questions' });
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, online, got, calls, asked]);

  /** Back from Facebook's sign-in: what's connected now, on the test. */
  const connected = React.useCallback(
    async (instagram: boolean) => {
      try {
        const ctx = await calls.load();
        setGot((now) => (now ? { ...now, ctx } : now));
      } catch {
        // No signal for a moment: the test shows what it had.
      }
      setView({ at: 'test', instagram });
    },
    [calls],
  );

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(business.id));
  };

  if (allowed && got && view?.at === 'test')
    return (
      <FacebookPhoneTest
        workspaceId={business.id}
        accounts={got.ctx.accounts}
        instagramAsked={view.instagram}
        calls={calls}
        onConnected={() => connected(view.instagram)}
        onClose={close}
      />
    );
  if (allowed && got && view?.at === 'overview')
    return (
      <FacebookPhoneOverview
        workspaceId={business.id}
        ctx={got.ctx}
        calls={calls}
        onTest={() => setView({ at: 'test', instagram: false })}
        onAgain={() => setView({ at: 'questions' })}
        onConnected={() => connected(false)}
        onClose={close}
      />
    );
  if (allowed && got && view?.at === 'questions')
    return (
      <FacebookGuidedFlow
        workspaceId={business.id}
        businessName={business.name}
        firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
        ctx={got.ctx}
        draft={got.draft}
        calls={calls}
        onConnected={connected}
        onClose={close}
      />
    );

  return (
    <Screen title={W.pageTitle} leading="close" ask={false} testID="facebook-setup">
      <View className="gap-3 p-1">
        {!allowed ? (
          <>
            <Text
              className="text-[15px] font-semibold leading-[21px]"
              testID="facebook-setup-not-allowed"
            >
              {W.notAllowed}
            </Text>
            <Text className="text-[14px] text-text-2">{W.notAllowedHint}</Text>
          </>
        ) : !online ? (
          <Text
            className="text-[15px] font-semibold leading-[21px]"
            testID="facebook-setup-offline"
          >
            {P.needsSignal}
          </Text>
        ) : failed ? (
          <>
            <Text
              className="text-[15px] font-semibold leading-[21px]"
              testID="facebook-setup-failed"
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
          <View className="items-center py-16" testID="facebook-setup-loading">
            <ActivityIndicator color={colors.text3} />
          </View>
        )}
      </View>
    </Screen>
  );
}
