import {
  IDEA_STATUS_MEANING,
  IDEAS_WORDS,
  ideaDay,
  ideaUpdateLine,
  relativeTimeAgo,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BellRing, EyeOff, GitMerge, PackageCheck, Pencil, Send } from '@/components/icons';
import { IdeasLoading, IdeasNeedSignal, PlainText, StatusPill } from '@/components/ideas/idea-bits';
import { VoteButton } from '@/components/ideas/vote-button';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import {
  areaName,
  ideaCommands,
  useIdea,
  useIdeaAreas,
  type IdeaComment,
  type IdeaFull,
  type IdeaUpdate,
} from '@/ideas/use-ideas';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

/**
 * One idea, as everybody who takes part sees it (the web's idea page at phone size): the vote, where it stands and
 * what that means, what the team has said about it, and the conversation under it, with the comment box at the foot
 * above the keyboard. Its author can still fix their words until the team has answered; anybody can stop the emails
 * about it. Live, as the board is.
 */
export default function IdeaScreen() {
  const { business } = useBusiness();
  const { ideaId } = useLocalSearchParams<{ ideaId: string }>();
  const view = useIdea(String(ideaId));
  const areas = useIdeaAreas();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [comment, setComment] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const back = businessHref(business.id, 'ideas');
  const open = (id: string) => router.push(businessHref(business.id, `ideas/${id}`) as Href);

  const data = view.data;
  if (!data)
    return (
      <Screen title={IDEAS_WORDS.title} leading="back" back={back} testID="idea">
        {view.loading ? (
          <IdeasLoading />
        ) : (
          <IdeasNeedSignal error={view.error} onRetry={view.reload} />
        )}
      </Screen>
    );

  const { idea, comments, updates, shipped } = data;
  const patchIdea = (patch: Partial<IdeaFull['idea']>) =>
    view.update((was) => ({ ...was, idea: { ...was.idea, ...patch } }));

  const follow = async (next: boolean) => {
    patchIdea({ following: next });
    setBusy('follow');
    try {
      await ideaCommands.follow(idea.id, next);
      toast.show(next ? IDEAS_WORDS.followOn : IDEAS_WORDS.followOff);
    } catch (e) {
      patchIdea({ following: !next });
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await ideaCommands.comment(idea.id, text);
      setComment('');
      view.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const takeDown = async (commentId: string) => {
    setBusy(`hide-${commentId}`);
    try {
      await ideaCommands.takeDown(commentId);
      toast.show(IDEAS_WORDS.commentDeleted);
      view.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title={`#${idea.number}`} leading="back" back={back} scroll={false} testID="idea">
      <View
        className="flex-1"
        style={
          keyboard
            ? { paddingBottom: keyboard + (Platform.OS === 'android' ? insets.bottom : 0) }
            : undefined
        }
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-3 p-3 pb-6"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          refreshControl={
            <RefreshControl
              refreshing={view.refreshing}
              onRefresh={view.reload}
              tintColor={colors.accent}
            />
          }
        >
          {idea.mergedInto ? (
            <Pressable
              role="link"
              onPress={() =>
                router.replace(businessHref(business.id, `ideas/${idea.mergedInto!.id}`) as Href)
              }
              className="flex-row gap-2.5 rounded-card border border-border bg-card-2 px-3.5 py-3 active:opacity-80"
              testID="idea-merged"
            >
              <Icon as={GitMerge} className="mt-0.5 size-4 text-text-3" />
              <Text className="flex-1 text-[13.5px] leading-5">
                {`${IDEAS_WORDS.mergedBefore} `}
                <Text className="font-medium underline">
                  {`#${idea.mergedInto.number} ${idea.mergedInto.title}`}
                </Text>
                {`. ${IDEAS_WORDS.mergedAfter}`}
              </Text>
            </Pressable>
          ) : null}
          {idea.hidden ? (
            <View className="flex-row gap-2.5 rounded-card bg-warning-soft px-3.5 py-3">
              <Icon as={EyeOff} className="mt-0.5 size-4 text-warning-text" />
              <Text className="flex-1 text-[13.5px] leading-5 text-warning-text">
                {IDEAS_WORDS.hidden}
              </Text>
            </View>
          ) : null}

          <Card className="gap-3 px-3.5 py-4">
            <View className="flex-row gap-3.5">
              <VoteButton
                ideaId={idea.id}
                voted={idea.voted}
                count={idea.voteCount}
                open={idea.votingOpen}
                size="lg"
                onVoted={(answer) => patchIdea(answer)}
              />
              <View className="min-w-0 flex-1 gap-1.5">
                <Text
                  className="text-[18px] font-semibold leading-6 tracking-[-0.18px]"
                  testID="idea-title-shown"
                >
                  {idea.title}
                </Text>
                <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusPill status={idea.status} />
                  <Text className="text-[12.5px] text-text-3">{areaName(areas, idea.areaId)}</Text>
                </View>
                <Text className="text-[12.5px] text-text-3">
                  {`${IDEAS_WORDS.sharedBy(idea.author.name, idea.author.you)} · ${relativeTimeAgo(idea.createdAt)}`}
                </Text>
              </View>
            </View>
            {idea.body ? <PlainText text={idea.body} /> : null}
            {idea.canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                icon={Pencil}
                className="self-start"
                onPress={() => setEditing(true)}
                testID="idea-edit"
              >
                {IDEAS_WORDS.edit}
              </Button>
            ) : null}
          </Card>

          <Card className="gap-1.5 px-3.5 py-3.5">
            <Text variant="group">{IDEAS_WORDS.whereItStands}</Text>
            <Text className="text-[13.5px] leading-5 text-text-2">
              {IDEA_STATUS_MEANING[idea.status]}
            </Text>
            <Text className="text-[13.5px] text-text-2" testID="idea-votes-line">
              {IDEAS_WORDS.votesLine(idea.voteCount, idea.voted)}
            </Text>
          </Card>

          <Card className="flex-row items-center gap-3 px-3.5 py-3.5">
            <Icon as={BellRing} className="size-5 text-text-2" />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-[15px] font-medium">{IDEAS_WORDS.followTitle}</Text>
              <Text className="text-[12.5px] leading-[18px] text-text-3">
                {IDEAS_WORDS.followDetail}
              </Text>
            </View>
            <Switch
              label={IDEAS_WORDS.followLabel}
              checked={idea.following}
              onCheckedChange={(next) => void follow(next)}
              disabled={busy === 'follow'}
              testID="idea-follow"
            />
          </Card>

          {shipped.map((s) => (
            <Pressable
              key={s.id}
              role="link"
              onPress={() => router.push(businessHref(business.id, 'ideas/whats-new') as Href)}
              className="flex-row items-center gap-2.5 rounded-card bg-success-soft px-3.5 py-3 active:opacity-80"
              testID="idea-shipped"
            >
              <Icon as={PackageCheck} className="size-4 text-success-text" />
              <Text className="flex-1 text-[13.5px] text-success-text">
                {IDEAS_WORDS.inWhatsNew(s.title, ideaDay(s.publishedAt))}
              </Text>
            </Pressable>
          ))}

          {updates.length ? (
            <View className="gap-2" testID="idea-updates">
              <Text variant="group" className="px-1 pt-2">
                {IDEAS_WORDS.whatHappened}
              </Text>
              {updates.map((u) => (
                <UpdateRow key={u.id} update={u} onOpen={open} />
              ))}
            </View>
          ) : null}

          <View className="gap-2" testID="idea-comments">
            <Text variant="group" className="px-1 pt-2">
              {IDEAS_WORDS.comments(comments.length)}
            </Text>
            {comments.length ? (
              comments.map((c) => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  busy={busy === `hide-${c.id}`}
                  onTakeDown={() => void takeDown(c.id)}
                />
              ))
            ) : (
              <Text className="px-1 text-[13.5px] leading-5 text-text-3">
                {IDEAS_WORDS.noComments}
              </Text>
            )}
          </View>
        </ScrollView>

        {idea.mergedInto ? null : (
          <View
            className="flex-row items-end gap-2 border-t border-border bg-card px-3 pt-2.5"
            style={{ paddingBottom: (keyboard ? 0 : insets.bottom) + 10 }}
          >
            <TextInput
              value={comment}
              onChangeText={setComment}
              multiline
              maxLength={5000}
              placeholder={IDEAS_WORDS.commentPlaceholder}
              accessibilityLabel={IDEAS_WORDS.commentLabel}
              placeholderTextColor={colors.placeholder}
              className="max-h-[120px] min-h-11 flex-1 rounded-menu border border-border-strong bg-card px-3 py-2.5 font-sans text-[15px] text-text"
              testID="idea-comment-body"
            />
            <Button
              size="lg"
              icon={Send}
              disabled={!comment.trim()}
              loading={sending}
              onPress={() => void send()}
              accessibilityLabel={IDEAS_WORDS.commentButton}
              testID="idea-comment-send"
            />
          </View>
        )}
      </View>

      <EditSheet
        open={editing}
        onClose={() => setEditing(false)}
        idea={idea}
        onSaved={() => {
          setEditing(false);
          toast.show(IDEAS_WORDS.saved);
          view.reload();
        }}
      />
    </Screen>
  );
}

/** One line of the idea's story, and what the team said with it. */
function UpdateRow({ update, onOpen }: { update: IdeaUpdate; onOpen: (id: string) => void }) {
  return (
    <Card className="gap-1.5 px-3.5 py-3">
      <Text className="text-[13.5px] leading-5">
        <Text className="font-medium">{ideaUpdateLine(update)}</Text>
        {update.other && update.kind !== 'status' ? (
          <Text className="underline" onPress={() => onOpen(update.other!.id)}>
            {` ${update.other.title}`}
          </Text>
        ) : null}
        {update.whatsNew ? <Text>{` in ${update.whatsNew.title}`}</Text> : null}
        <Text className="text-text-3">{` · ${update.by} · ${ideaDay(update.createdAt)}`}</Text>
      </Text>
      {update.note ? (
        <View className="rounded-control bg-accent-soft px-3 py-2">
          <Text className="text-[13.5px] leading-5 text-accent-text">{update.note}</Text>
        </View>
      ) : null}
    </Card>
  );
}

/** A comment: who wrote it (the team's with their badge), when, and Delete on the person's own. */
function CommentRow({
  comment,
  busy,
  onTakeDown,
}: {
  comment: IdeaComment;
  busy: boolean;
  onTakeDown: () => void;
}) {
  const team = comment.author.team;
  return (
    <View
      className={cn(
        'gap-1 rounded-card border px-3.5 py-3',
        team ? 'border-accent-soft-2 bg-accent-soft' : 'border-border bg-card',
        comment.hidden && 'opacity-60',
      )}
      testID="idea-comment"
    >
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-[13px] font-medium">
          {comment.author.you ? IDEAS_WORDS.you : comment.author.name || IDEAS_WORDS.someone}
        </Text>
        {team ? (
          <Badge variant="accent">
            <Text className="font-semibold">{IDEAS_WORDS.team}</Text>
          </Badge>
        ) : null}
        <Text className="text-[12px] text-text-3">{relativeTimeAgo(comment.createdAt)}</Text>
        {comment.author.you && !comment.hidden ? (
          <Pressable
            role="button"
            onPress={onTakeDown}
            disabled={busy}
            hitSlop={8}
            className="ml-auto"
            testID="idea-comment-delete"
          >
            <Text className="text-[12px] text-text-3">{IDEAS_WORDS.deleteComment}</Text>
          </Pressable>
        ) : null}
      </View>
      <Text className="text-[14.5px] leading-[21px]">{comment.body}</Text>
    </View>
  );
}

/** Fixing one's own words, before the team has answered. The area stays as it was; the web changes that too. */
function EditSheet({
  open,
  onClose,
  idea,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  idea: IdeaFull['idea'];
  onSaved: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const [title, setTitle] = React.useState(idea.title);
  const [body, setBody] = React.useState(idea.body);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setTitle(idea.title);
    setBody(idea.body);
    setProblem(null);
  }, [open, idea.title, idea.body]);

  const save = async () => {
    if (title.trim().length < 3) return setProblem(IDEAS_WORDS.needsTitle);
    setBusy(true);
    try {
      await ideaCommands.edit({
        ideaId: idea.id,
        title: title.trim(),
        body: body.trim(),
        areaId: idea.areaId,
      });
      onSaved();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={IDEAS_WORDS.edit} testID="idea-edit-sheet">
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-3">
        <View className="gap-1.5">
          <Label>{IDEAS_WORDS.titleLabel}</Label>
          <Input value={title} onChangeText={setTitle} maxLength={140} testID="idea-edit-title" />
        </View>
        <View className="gap-1.5">
          <Label>{IDEAS_WORDS.bodyLabel}</Label>
          <Input
            value={body}
            onChangeText={setBody}
            multiline
            maxLength={5000}
            className="h-32 py-3"
            testID="idea-edit-body"
          />
        </View>
        {problem ? <FieldError>{problem}</FieldError> : null}
        <Button onPress={() => void save()} loading={busy} testID="idea-edit-save">
          {IDEAS_WORDS.save}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {IDEAS_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}
