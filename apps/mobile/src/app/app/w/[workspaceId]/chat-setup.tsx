import {
  chatDoneChips,
  chatSetupAnswersFromWidget,
  CHAT_SETUP_WORDS as W,
  holds,
  type ChatSetupAnswers,
} from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { chatSetupCalls, type ChatGuidedDraft, type ChatSetupLoaded } from '@/chat-setup/calls';
import { ChatGuidedFlow, ChatPhoneInstall } from '@/components/chat-setup/guided-flow';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { errorMessage } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import { useColors } from '@/theme';

/**
 * Getting started's "Add chat", full screen, as the web's /onboarding/<business>/chat: the guided website chat setup
 * (the owner, 23 Nov 2026, W4 b), one question a screen, then Turn on website chat. Putting the code on the site opens
 * the web. A business whose chat is made but not on its site yet opens on that step, with the questions behind it.
 * It opens where the person left off, with the answers they gave here or on the web. For someone who can change the
 * business's channels, and it needs signal.
 */
export default function ChatSetup() {
  const { business, me } = useBusiness();
  const { online } = useNetwork();
  const allowed = holds(useGrants(), 'channels.manage');
  const calls = React.useMemo(() => chatSetupCalls(business.id), [business.id]);
  const colors = useColors();
  const [got, setGot] = React.useState<(ChatSetupLoaded & { draft: ChatGuidedDraft }) | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState(0);
  /** The questions, or Put it on your site (with the answers it was turned on with). */
  const [view, setView] = React.useState<
    { at: 'questions' } | { at: 'install'; fresh: boolean; answers: ChatSetupAnswers } | null
  >(null);

  React.useEffect(() => {
    if (!allowed || !online || got) return;
    let cancelled = false;
    setFailed(null);
    Promise.all([calls.load(), calls.draft()])
      .then(([loaded, draft]) => {
        if (cancelled) return;
        setGot({ ...loaded, draft });
        const w = loaded.ctx.widget;
        setView(
          w && !w.install.seen
            ? { at: 'install', fresh: false, answers: chatSetupAnswersFromWidget(w) }
            : { at: 'questions' },
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailed(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, online, got, calls, asked]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(business.id));
  };

  if (allowed && got && view?.at === 'install')
    return (
      <ChatPhoneInstall
        workspaceId={business.id}
        fresh={view.fresh}
        chips={chatDoneChips(view.answers, got.ctx)}
        onAgain={view.fresh ? null : () => setView({ at: 'questions' })}
        onClose={close}
      />
    );
  if (allowed && got && view?.at === 'questions')
    return (
      <ChatGuidedFlow
        workspaceId={business.id}
        businessName={business.name}
        firstName={me.user.fullName.trim().split(/\s+/)[0] || null}
        ctx={got.ctx}
        logo={got.logo}
        draft={got.draft}
        calls={calls}
        onSaved={(answers) => setView({ at: 'install', fresh: true, answers })}
        onClose={close}
      />
    );

  return (
    <Screen title={W.pageTitle} leading="close" ask={false} testID="chat-setup">
      <View className="gap-3 p-1">
        {!allowed ? (
          <>
            <Text
              className="text-[15px] font-semibold leading-[21px]"
              testID="chat-setup-not-allowed"
            >
              {W.notAllowed}
            </Text>
            <Text className="text-[14px] text-text-2">{W.notAllowedHint}</Text>
          </>
        ) : !online ? (
          <Text className="text-[15px] font-semibold leading-[21px]" testID="chat-setup-offline">
            {P.needsSignal}
          </Text>
        ) : failed ? (
          <>
            <Text className="text-[15px] font-semibold leading-[21px]" testID="chat-setup-failed">
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
          <View className="items-center py-16" testID="chat-setup-loading">
            <ActivityIndicator color={colors.text3} />
          </View>
        )}
      </View>
    </Screen>
  );
}
