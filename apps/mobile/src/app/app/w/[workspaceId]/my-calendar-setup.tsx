import {
  MY_CALENDAR_SETUP_WORDS as W,
  holds,
  myCalendarIsSetUp,
  type MyCalendarSetupContext,
} from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import {
  MyCalendarGuidedFlow,
  MyCalendarPhoneDone,
} from '@/components/my-calendar-setup/guided-flow';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { myCalendarSetupCalls, type MyCalendarGuidedDraft } from '@/my-calendar-setup/calls';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

/**
 * My calendar on the phone, full screen, as the web's /onboarding/<business>/my-calendar (the owner, 24 Nov 2026,
 * M4 a): until it's set up (or with answers half given), the guided setup, one question a screen, then Check it over,
 * whose save opens Google's or Microsoft's sign-in in the phone's browser and comes back here to Done. Once it's set
 * up, what's set now with Go through the questions again. Opened from Getting started and Settings → My calendar.
 * Always your own calendar; it opens where you left off, with the answers you gave here or on the web. For someone
 * who takes appointments, and it needs signal.
 */
export default function MyCalendarSetup() {
  const { business, me } = useBusiness();
  const { online } = useNetwork();
  const allowed = holds(useGrants(), 'appointments.write');
  const calls = React.useMemo(() => myCalendarSetupCalls(business.id), [business.id]);
  const colors = useColors();
  const [got, setGot] = React.useState<{
    ctx: MyCalendarSetupContext;
    draft: MyCalendarGuidedDraft;
  } | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState(0);
  const [view, setView] = React.useState<
    { at: 'questions' } | { at: 'overview' } | { at: 'done'; zoom: boolean } | null
  >(null);

  React.useEffect(() => {
    if (!allowed || !online || got) return;
    let cancelled = false;
    setFailed(null);
    Promise.all([calls.load(), calls.draft()])
      .then(([ctx, draft]) => {
        if (cancelled) return;
        setGot({ ctx, draft });
        setView(
          myCalendarIsSetUp(ctx) && !draft.answers ? { at: 'overview' } : { at: 'questions' },
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, online, got, calls, asked]);

  /** What's set now: after saving, and back from a sign-in. */
  const reload = React.useCallback(async () => {
    try {
      const ctx = await calls.load();
      setGot((now) => (now ? { ...now, ctx } : now));
    } catch {
      // No signal for a moment: Done shows what it had.
    }
  }, [calls]);

  const saved = React.useCallback(
    async (zoom: boolean) => {
      await reload();
      setGot((now) => (now ? { ...now, draft: { answers: null, savedAt: null } } : now));
      setView({ at: 'done', zoom });
    },
    [reload],
  );

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(business.id));
  };

  if (allowed && got && (view?.at === 'done' || view?.at === 'overview'))
    return (
      <MyCalendarPhoneDone
        workspaceId={business.id}
        ctx={got.ctx}
        zoom={view.at === 'done' && view.zoom}
        calls={calls}
        onBack={reload}
        onAgain={view.at === 'overview' ? () => setView({ at: 'questions' }) : undefined}
        onClose={close}
      />
    );
  if (allowed && got && view?.at === 'questions')
    return (
      <MyCalendarGuidedFlow
        workspaceId={business.id}
        businessName={business.name}
        firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
        ctx={got.ctx}
        draft={got.draft}
        calls={calls}
        onSaved={saved}
        onClose={close}
      />
    );

  return (
    <Screen title={W.pageTitle} leading="close" ask={false} testID="my-calendar-setup">
      <View className="gap-3 p-1">
        {!allowed ? (
          <>
            <Text
              className="text-[15px] font-semibold leading-[21px]"
              testID="my-calendar-setup-not-allowed"
            >
              {W.notAllowed}
            </Text>
            <Text className="text-[14px] text-text-2">{W.notAllowedHint}</Text>
          </>
        ) : !online ? (
          <Text
            className="text-[15px] font-semibold leading-[21px]"
            testID="my-calendar-setup-offline"
          >
            {P.needsSignal}
          </Text>
        ) : failed ? (
          <>
            <Text
              className="text-[15px] font-semibold leading-[21px]"
              testID="my-calendar-setup-failed"
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
          <View className="items-center py-16" testID="my-calendar-setup-loading">
            <ActivityIndicator color={colors.text3} />
          </View>
        )}
      </View>
    </Screen>
  );
}
