import { ASSISTANT_FILES_MAX, ASSISTANT_PICTURES_MAX, ASSISTANT_WORDS } from '@hfos/core';
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
import { toast } from '@/components/ui/toast';
import { setupIsOff, useAssistantChat, type ChatMessage } from '@/assistant/chat';
import { deviceChangesOf } from '@/assistant/device-changes';
import { answerWaiting } from '@/assistant/decide';
import { pageRecordOf, screenPathOf } from '@/assistant/page-record';
import { pickAssistantFiles, type DraftFile } from '@/assistant/files';
import { takeAssistantPictures, type DraftPicture } from '@/assistant/pictures';
import { useAssistantVoice } from '@/assistant/voice';
import { useChangeList } from '@/changes/hooks';
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
  const params = useLocalSearchParams<{ type?: string; id?: string; from?: string }>();
  const page = React.useMemo(() => pageRecordOf(params), [params.type, params.id]);
  // Changes on this phone go with each question: they never reached HandsFreeOS, so only the phone can say.
  const changeList = useChangeList();
  const deviceChanges = changeList.loading ? null : deviceChangesOf(changeList, business.id);
  const chat = useAssistantChat(
    business.id,
    userId,
    page,
    screenPathOf(params.from),
    deviceChanges,
  );
  const voice = useAssistantVoice(chat, business.id);
  const [draft, setDraft] = React.useState('');
  const [pictures, setPictures] = React.useState<readonly DraftPicture[]>([]);
  const [files, setFiles] = React.useState<readonly DraftFile[]>([]);
  const [view, setView] = React.useState<'chat' | 'history'>('chat');
  const listRef = React.useRef<FlatList<ChatMessage>>(null);

  /** Not now, and Close: back where the mark was pressed. */
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(business.id));
  };

  /** The picture button's sheet chose: taken or chosen, shrunk, and put in the box to go with the question. */
  const pickPictures = async (source: 'camera' | 'library') => {
    // An iPhone won't show the camera or the pictures over a sheet that is closing.
    await new Promise((done) => setTimeout(done, 450));
    const room = ASSISTANT_PICTURES_MAX - pictures.length;
    if (room <= 0) return void toast.show(ASSISTANT_WORDS.pictures.tooMany(ASSISTANT_PICTURES_MAX));
    const taken = await takeAssistantPictures(source, room);
    if (taken.kind === 'no-camera-permission')
      return void toast.error(
        'Let HandsFreeOS use the camera in your phone’s Settings, then try again.',
      );
    if (taken.kind !== 'taken') return;
    if (taken.unreadable) toast.error(ASSISTANT_WORDS.pictures.unreadable);
    setPictures((all) => [...all, ...taken.pictures].slice(0, ASSISTANT_PICTURES_MAX));
  };

  /** The sheet's Choose a file: chosen with the phone's own picker, read, and put in the box to go too. */
  const pickFiles = async () => {
    await new Promise((done) => setTimeout(done, 450));
    const room = ASSISTANT_FILES_MAX - files.length;
    if (room <= 0) return void toast.show(ASSISTANT_WORDS.files.tooMany(ASSISTANT_FILES_MAX));
    const picked = await pickAssistantFiles(
      room,
      files.reduce((n, f) => n + f.bytes, 0),
    ).catch(() => null);
    if (!picked) return void toast.error('The files couldn’t be opened. Try again.');
    if (picked.kind !== 'picked') return;
    if (picked.refused.length) toast.error(picked.refused[0]!);
    setFiles((all) => [...all, ...picked.files].slice(0, ASSISTANT_FILES_MAX));
  };

  const send = () => {
    if (!draft.trim() && !pictures.length && !files.length) return;
    const text = draft;
    setDraft('');
    // With pictures or files it's a question about them (a form to build from a screenshot), never a yes or no to
    // a card.
    if (pictures.length || files.length) {
      chat.ask(text, { pictures, files });
      setPictures([]);
      setFiles([]);
      return;
    }
    // A plain yes or no answers the cards waiting for an OK, as their buttons do; anything else is a question.
    void answerWaiting(chat, business.id, text).then((answered) => {
      if (answered === null) chat.ask(text);
    });
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
                  setPictures([]);
                  setFiles([]);
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
              pictures={pictures}
              onPickPictures={(source) => void pickPictures(source)}
              onRemovePicture={(id) => setPictures((all) => all.filter((p) => p.id !== id))}
              files={files}
              onPickFiles={() => void pickFiles()}
              onRemoveFile={(id) => setFiles((all) => all.filter((f) => f.id !== id))}
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
