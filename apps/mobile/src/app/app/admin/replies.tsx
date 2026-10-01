import { deskSectionLabel, SAVED_REPLY_WORDS } from '@hfos/core';
import * as React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { desk, useLive, type Ok } from '@/admin/live';
import { REPLIES_PHONE_WORDS } from '@/admin/team-words';
import { DeskWaiting, Empty } from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Pencil, Plus } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type SavedReply = Ok<'/v1/queries/support.canned_reply.list'>['replies'][number];

/**
 * Saved replies (the web's /admin/replies): the answers the desk gives often enough to write down once. They are also
 * what the AI reads before it drafts. Everyone answering support reads them here and uses them from a ticket's reply
 * sheet; a lead or an admin (`support.manage`) adds, changes and deletes them, and deleting asks first.
 */
export default function SavedReplies() {
  const colors = useColors();
  const canManage = useDeskCan('support.manage');
  const live = useLive(() => desk('/v1/queries/support.canned_reply.list', {}), 'saved-replies');
  const [editing, setEditing] = React.useState<SavedReply | 'new' | null>(null);

  return (
    <Screen
      title={deskSectionLabel('replies')}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-replies"
    >
      {live.data ? (
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-3 p-3 pb-8"
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={live.refreshing}
              onRefresh={live.reload}
              tintColor={colors.accent}
            />
          }
        >
          <Text className="px-1 text-[13.5px] leading-[19px] text-text-3">
            {SAVED_REPLY_WORDS.intro}
          </Text>
          {canManage ? (
            <Button icon={Plus} onPress={() => setEditing('new')} testID="reply-new">
              {SAVED_REPLY_WORDS.add}
            </Button>
          ) : (
            <Text
              className="px-1 text-[13px] leading-[18px] text-text-3"
              testID="replies-who-keeps"
            >
              {REPLIES_PHONE_WORDS.whoKeeps}
            </Text>
          )}
          {live.data.replies.length ? (
            <View
              className="overflow-hidden rounded-card border border-border bg-card"
              testID="reply-list"
            >
              {live.data.replies.map((r, i) => (
                <View
                  key={r.id}
                  className={cn('gap-1 px-4 py-3.5', i > 0 && 'border-t border-border')}
                  testID={`reply-row-${r.id}`}
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <Text className="min-w-0 flex-1 text-[15px] font-semibold">{r.title}</Text>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Pencil}
                        onPress={() => setEditing(r)}
                        accessibilityLabel={`${SAVED_REPLY_WORDS.edit} ${r.title}`}
                        testID={`reply-edit-${r.id}`}
                      >
                        {SAVED_REPLY_WORDS.edit}
                      </Button>
                    ) : null}
                  </View>
                  <Text selectable className="text-[13.5px] leading-[19px] text-text-2">
                    {r.bodyText}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Empty
              title={SAVED_REPLY_WORDS.emptyTitle}
              body={SAVED_REPLY_WORDS.emptyBody}
              testID="replies-empty"
            />
          )}
        </ScrollView>
      ) : (
        <DeskWaiting live={live} testID="replies" />
      )}

      {canManage ? (
        <ReplyEditor
          start={editing}
          onClose={() => setEditing(null)}
          onDone={(said) => {
            setEditing(null);
            toast.show(said);
            live.reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

/**
 * Writing a saved reply, or changing one. Delete is in here too, as on the web, and asks first in the same sheet:
 * everyone answering support loses it, and the AI stops reading it.
 */
function ReplyEditor({
  start,
  onClose,
  onDone,
}: {
  start: SavedReply | 'new' | null;
  onClose: () => void;
  onDone: (said: string) => void;
}) {
  const keyboard = useKeyboardHeight();
  // What the sheet is about, kept while it slides away so its title doesn't change on the way down.
  const [target, setTarget] = React.useState<SavedReply | 'new'>('new');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState<'save' | 'delete' | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!start) return;
    setTarget(start);
    setTitle(start === 'new' ? '' : start.title);
    setBody(start === 'new' ? '' : start.bodyText);
    setAsking(false);
    setProblem(null);
  }, [start]);
  const existing = target === 'new' ? null : target;

  const save = async () => {
    setBusy('save');
    setProblem(null);
    try {
      await desk('/v1/commands/support.canned_reply.save', {
        ...(existing ? { id: existing.id } : {}),
        title: title.trim(),
        bodyText: body.trim(),
      });
      onDone(REPLIES_PHONE_WORDS.saved);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!existing) return;
    setBusy('delete');
    setProblem(null);
    try {
      await desk('/v1/commands/support.canned_reply.delete', { id: existing.id });
      onDone(REPLIES_PHONE_WORDS.deleted);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (asking && existing)
    return (
      <Sheet
        open={start !== null}
        onClose={onClose}
        title={REPLIES_PHONE_WORDS.deleteTitle}
        description={REPLIES_PHONE_WORDS.deleteAsk(existing.title)}
        testID="reply-delete-sheet"
      >
        <View className="mt-4 gap-2">
          {problem ? <FieldError>{problem}</FieldError> : null}
          <Button
            variant="danger"
            loading={busy === 'delete'}
            onPress={() => void remove()}
            testID="reply-delete-confirm"
          >
            {REPLIES_PHONE_WORDS.deleteConfirm}
          </Button>
          <Button variant="ghost" onPress={() => setAsking(false)} testID="reply-delete-keep">
            {REPLIES_PHONE_WORDS.keep}
          </Button>
        </View>
      </Sheet>
    );

  return (
    <Sheet
      open={start !== null}
      onClose={onClose}
      title={existing ? REPLIES_PHONE_WORDS.editTitle : SAVED_REPLY_WORDS.add}
      scroll
      testID="reply-sheet"
    >
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="mt-3 gap-3">
        <View className="gap-1.5">
          <Label nativeID="reply-title-label">{SAVED_REPLY_WORDS.titleLabel}</Label>
          <Input
            value={title}
            onChangeText={setTitle}
            placeholder={SAVED_REPLY_WORDS.titlePlaceholder}
            maxLength={200}
            aria-labelledby="reply-title-label"
            testID="reply-title"
          />
        </View>
        <View className="gap-1.5">
          <Label nativeID="reply-body-label">{SAVED_REPLY_WORDS.bodyLabel}</Label>
          <Input
            value={body}
            onChangeText={setBody}
            multiline
            textAlignVertical="top"
            maxLength={20000}
            className="h-40 py-3"
            aria-labelledby="reply-body-label"
            testID="reply-body"
          />
        </View>
        {problem ? <FieldError>{problem}</FieldError> : null}
        <Button
          onPress={() => void save()}
          loading={busy === 'save'}
          disabled={busy !== null || !title.trim() || !body.trim()}
          testID="reply-save"
        >
          {SAVED_REPLY_WORDS.save}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {SAVED_REPLY_WORDS.cancel}
        </Button>
        {existing ? (
          <Button
            variant="ghostDanger"
            disabled={busy !== null}
            onPress={() => {
              setProblem(null);
              setAsking(true);
            }}
            testID="reply-delete"
          >
            {SAVED_REPLY_WORDS.delete}
          </Button>
        ) : null}
      </View>
    </Sheet>
  );
}
