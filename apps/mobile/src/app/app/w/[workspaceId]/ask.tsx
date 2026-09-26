import { ASSISTANT_WORDS } from '@hfos/core';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MessagesSquare, SquarePen } from '@/components/icons';
import { AssistantComposer } from '@/components/assistant/composer';
import { ConsentStep } from '@/components/assistant/consent-step';
import { EmptyChat, MessageRow } from '@/components/assistant/message-list';
import { NotSetUp } from '@/components/assistant/notices';
import { ThreadList } from '@/components/assistant/thread-list';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Icon } from '@/components/ui/icon';
import { setupIsOff, useAssistantChat, type ChatMessage } from '@/assistant/chat';
import { pageRecordOf } from '@/assistant/page-record';
import { useAssistantVoice } from '@/assistant/voice';
import { useNetwork } from '@/lib/network';

/**
 * Ask HandsFreeOS, full screen, from the mark at the top of every screen (design/m10/Assistant.dc.html). The same
 * chat and cards as the web's panel, the consent step the first time, and — because the Assistant is one of the few
 * things that needs signal — a plain card saying so when there's none, with the question kept and Ask again.
 * Nothing is queued: the outbox is for changes made on the phone, and a question isn't one.
 */
export default function Ask() {
  const { business, userId } = useBusiness();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const { online } = useNetwork();
  const params = useLocalSearchParams<{ type?: string; id?: string }>();
  const page = React.useMemo(() => pageRecordOf(params), [params.type, params.id]);
  const chat = useAssistantChat(business.id, userId, page);
  const voice = useAssistantVoice(chat, business.id);
  const [draft, setDraft] = React.useState('');
  const [view, setView] = React.useState<'chat' | 'history'>('chat');
  const listRef = React.useRef<FlatList<ChatMessage>>(null);

  /** Not now, and Close: back where the mark was pressed. */
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(business.id));
  };

  const send = () => {
    if (!draft.trim()) return;
    chat.ask(draft);
    setDraft('');
  };

  // A new answer scrolls into view, so what came back is what you see.
  React.useEffect(() => {
    if (chat.messages.length)
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
  }, [chat.messages.length]);

  const isOff = setupIsOff(chat.setup);
  const offWords =
    chat.setup === 'not-in-build' ? ASSISTANT_WORDS.notInThisBuild : ASSISTANT_WORDS.notAvailable;
  const off = isOff
    ? { text: offWords.title, hint: offWords.hint }
    : chat.paused
      ? { text: ASSISTANT_WORDS.paused.text, hint: ASSISTANT_WORDS.paused.hint }
      : null;

  const showConsent = chat.consentNeeded === true && !isOff && online;

  return (
    <Screen
      title={view === 'history' ? ASSISTANT_WORDS.history.title : ASSISTANT_WORDS.title}
      leading="close"
      ask={false}
      scroll={false}
      testID="ask"
      contentClassName="flex-1"
      trailing={
        showConsent ? null : (
          <View className="flex-row items-center">
            <HeaderButton
              label={
                view === 'history' ? ASSISTANT_WORDS.history.back : ASSISTANT_WORDS.history.title
              }
              testID="assistant-history-toggle"
              onPress={() => setView(view === 'history' ? 'chat' : 'history')}
            >
              <Icon as={MessagesSquare} className="size-[21px] text-text-2" />
            </HeaderButton>
            {view === 'chat' ? (
              <HeaderButton
                label={ASSISTANT_WORDS.newChat}
                testID="assistant-new-chat"
                onPress={() => {
                  chat.newChat();
                  setDraft('');
                }}
              >
                <Icon as={SquarePen} className="size-[21px] text-text-2" />
              </HeaderButton>
            ) : null}
          </View>
        )
      }
    >
      <View
        className="flex-1"
        style={
          keyboard
            ? { paddingBottom: keyboard + (Platform.OS === 'android' ? insets.bottom : 0) }
            : undefined
        }
      >
        {showConsent ? (
          <ConsentStep onAccept={chat.giveConsent} onDecline={close} />
        ) : view === 'history' ? (
          <ThreadList
            workspaceId={business.id}
            openThreadId={chat.threadId}
            onOpen={(id) => {
              setView('chat');
              void chat.openThread(id);
            }}
            onForget={chat.forgetThread}
          />
        ) : isOff ? (
          <NotSetUp reason={chat.setup === 'not-in-build' ? 'not-in-build' : 'missing'} />
        ) : (
          <FlatList
            ref={listRef}
            data={chat.messages as ChatMessage[]}
            keyExtractor={(m) => m.key}
            renderItem={({ item }) => (
              <MessageRow
                message={item}
                businessName={business.name}
                workspaceId={business.id}
                calls={chat.calls}
                setCall={chat.setCall}
                onRetry={chat.retry}
                onReload={chat.threadId ? () => void chat.openThread(chat.threadId!) : undefined}
              />
            )}
            className="flex-1"
            contentContainerClassName="px-3.5 pb-3 pt-2"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            initialNumToRender={10}
            windowSize={9}
            testID="assistant-chat"
            ListEmptyComponent={chat.loading ? null : <EmptyChat />}
          />
        )}
        {showConsent || view === 'history' || isOff ? null : (
          <View style={{ paddingBottom: keyboard ? 0 : insets.bottom }} className="bg-card">
            <AssistantComposer
              value={draft}
              onChange={setDraft}
              onSend={send}
              onStop={chat.stop}
              running={chat.running}
              off={off}
              voice={voice}
            />
          </View>
        )}
      </View>
    </Screen>
  );
}

function HeaderButton({
  label,
  onPress,
  testID,
  children,
}: {
  label: string;
  onPress: () => void;
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      className="size-11 items-center justify-center rounded-full active:bg-card-2"
    >
      {children}
    </Pressable>
  );
}
