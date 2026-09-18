import { ASSISTANT_WORDS, assistantChatWhen } from '@hfos/core';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Archive, Check, Ellipsis, Pencil } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { archiveThread, renameThread, useThreads, type ThreadSummary } from '@/assistant/threads';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Your chats with the Assistant, newest first: open one, rename it or archive it. Chats are private to their
 * person, and they live on HandsFreeOS rather than on the phone, so the list needs signal.
 */
export function ThreadList({
  workspaceId,
  openThreadId,
  onOpen,
  onForget,
}: {
  workspaceId: string;
  openThreadId: string | null;
  onOpen: (threadId: string) => void;
  onForget: (threadId: string) => void;
}) {
  const threads = useThreads(workspaceId, true);
  const [acting, setActing] = React.useState<ThreadSummary | null>(null);
  const [renaming, setRenaming] = React.useState<ThreadSummary | null>(null);
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const archive = async (thread: ThreadSummary) => {
    setActing(null);
    try {
      await archiveThread(workspaceId, thread.id);
      threads.forget(thread.id);
      onForget(thread.id);
      toast.show(ASSISTANT_WORDS.history.archived);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const save = async () => {
    const next = title.trim();
    if (!renaming || !next) return;
    setBusy(true);
    try {
      await renameThread(workspaceId, renaming.id, next);
      threads.rename(renaming.id, next);
      setRenaming(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="flex-1" testID="assistant-history">
      <ScrollView className="flex-1" contentContainerClassName="gap-2 p-3 pb-8">
        {threads.items === null ? (
          <Text role="status" className="px-1 py-2 text-[13px] text-text-3">
            {ASSISTANT_WORDS.history.loading}
          </Text>
        ) : threads.items.length === 0 ? (
          <Text className="px-1 py-2 text-[13px] text-text-2" testID="assistant-history-empty">
            {threads.error ?? ASSISTANT_WORDS.history.empty}
          </Text>
        ) : (
          <View className="overflow-hidden rounded-card border border-border bg-card">
            {threads.items.map((thread, i) => (
              <View
                key={thread.id}
                className={cn(
                  'flex-row items-center',
                  i > 0 && 'border-t border-border',
                  thread.id === openThreadId && 'bg-accent-soft',
                )}
              >
                <Pressable
                  role="button"
                  testID="assistant-thread"
                  onPress={() => onOpen(thread.id)}
                  className="min-h-14 min-w-0 flex-1 justify-center gap-0.5 px-4 py-2 active:bg-card-2"
                >
                  <Text numberOfLines={1} className="text-[15px] font-medium">
                    {thread.title}
                  </Text>
                  <Text className="text-xs text-text-3">
                    {assistantChatWhen(thread.lastMessageAt)}
                  </Text>
                </Pressable>
                <Pressable
                  role="button"
                  accessibilityLabel={`More for ${thread.title}`}
                  testID="assistant-thread-more"
                  onPress={() => setActing(thread)}
                  className="size-11 items-center justify-center rounded-full active:bg-card-2"
                >
                  <Icon as={Ellipsis} className="size-5 text-text-3" />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <Text className="px-1 pt-2 text-xs leading-[17px] text-text-3">
          {ASSISTANT_WORDS.history.privacy}
        </Text>
      </ScrollView>

      <Sheet open={!!acting} onClose={() => setActing(null)} testID="assistant-thread-sheet">
        <Pressable
          role="button"
          testID="assistant-thread-rename"
          onPress={() => {
            setTitle(acting?.title ?? '');
            setRenaming(acting);
            setActing(null);
          }}
          className="min-h-14 flex-row items-center gap-3 px-1"
        >
          <Icon as={Pencil} className="size-5 text-text-2" />
          <Text className="text-base">{ASSISTANT_WORDS.history.rename}</Text>
        </Pressable>
        <Pressable
          role="button"
          testID="assistant-thread-archive"
          onPress={() => acting && void archive(acting)}
          className="min-h-14 flex-row items-center gap-3 border-t border-border px-1"
        >
          <Icon as={Archive} className="size-5 text-text-2" />
          <Text className="text-base">{ASSISTANT_WORDS.history.archive}</Text>
        </Pressable>
      </Sheet>

      <Sheet
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title={ASSISTANT_WORDS.history.renameTitle}
        testID="assistant-rename-sheet"
      >
        <Input
          value={title}
          onChangeText={setTitle}
          maxLength={200}
          autoFocus
          aria-label="Name"
          testID="assistant-rename-input"
        />
        <Button
          className="mt-3"
          icon={Check}
          loading={busy}
          disabled={!title.trim()}
          onPress={() => void save()}
          testID="assistant-rename-save"
        >
          Save
        </Button>
      </Sheet>
    </View>
  );
}
