import {
  IDEA_STATUS_WORDS,
  IDEA_STATUSES,
  IDEAS_TEAM_WORDS,
  IDEAS_WORDS,
  ideaDay,
  ideaTeamUpdateLine,
  relativeTimeAgo,
  type IdeaStatus,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IDEAS_DESK_WORDS } from '@/admin/ideas-words';
import { desk, useLive, type Ok } from '@/admin/live';
import { DeskWaiting, FilterChips, Section } from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Check, ChevronUp, Eye, EyeOff, GitMerge, Pencil } from '@/components/icons';
import { PlainText, StatusPill } from '@/components/ideas/idea-bits';
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
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type IdeaFull = Ok<'/v1/queries/idea.get'>;
type Idea = IdeaFull['idea'];
type Comment = IdeaFull['comments'][number];
type TeamView = Ok<'/v1/queries/idea.team_view'>;
type Area = Ok<'/v1/queries/idea.areas'>['areas'][number];
type Similar = Ok<'/v1/queries/idea.similar'>['ideas'][number];

/**
 * One idea, as the team sees it (the web's /admin/ideas/<id>): everything a business sees, plus who is behind it and
 * every voter with their business, and what only the team does: move it along the roadmap with a note the followers
 * are emailed (leads and admins), answer it as the team, tidy its words, merge a duplicate into the idea it repeats,
 * take it off the board, and take a comment down or put it back. Writing opens a sheet, as a ticket's reply does.
 */
export default function DeskIdea() {
  const { ideaId } = useLocalSearchParams<{ ideaId: string }>();
  const id = String(ideaId);
  const idea = useLive(() => desk('/v1/queries/idea.get', { ideaId: id }), id);
  const team = useLive(() => desk('/v1/queries/idea.team_view', { ideaId: id }), id);
  const areas = useLive(() => desk('/v1/queries/idea.areas', {}), 'idea-areas');
  const { reload: reloadIdea } = idea;
  const { reload: reloadTeam } = team;
  const reload = React.useCallback(() => {
    reloadIdea();
    reloadTeam();
  }, [reloadIdea, reloadTeam]);

  if (!idea.data || !team.data)
    return (
      <Screen title="" leading="back" back={deskHref('ideas')} scroll={false} testID="desk-idea">
        <DeskWaiting
          live={{
            loading: (!idea.data && idea.loading) || (!team.data && team.loading),
            error: idea.error ?? team.error,
            reload,
          }}
          testID="idea"
        />
      </Screen>
    );

  return (
    <IdeaTeamScreen
      key={id}
      data={idea.data}
      team={team.data}
      areas={areas.data?.areas ?? []}
      refreshing={idea.refreshing || team.refreshing}
      reload={reload}
    />
  );
}

function IdeaTeamScreen({
  data,
  team,
  areas,
  refreshing,
  reload,
}: {
  data: IdeaFull;
  team: TeamView;
  areas: readonly Area[];
  refreshing: boolean;
  reload: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const canManage = useDeskCan('platform.ideas.manage');
  const canReadBusinesses = useDeskCan('platform.businesses.read');
  const { idea, comments, updates } = data;
  const names = new Map(areas.map((a) => [a.id, a.name]));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState<'edit' | 'status' | 'answer' | null>(null);
  const [mergeInto, setMergeInto] = React.useState<Similar | null>(null);
  const [dupSearch, setDupSearch] = React.useState(idea.title);
  const matches = useSimilar(idea.mergedInto ? '' : dupSearch, idea.id);

  /** One change, then the idea asked for again; the API's own words if it can't. */
  const run = async (what: string, fn: () => Promise<unknown>, said?: string) => {
    setBusy(what);
    try {
      await fn();
      if (said) toast.show(said);
      reload();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const open = (ideaId: string) => router.push(deskHref(`ideas/${ideaId}`) as Href);

  return (
    <Screen
      title={`#${idea.number}`}
      subtitle={IDEA_STATUS_WORDS[idea.status]}
      leading="back"
      back={deskHref('ideas')}
      scroll={false}
      testID="desk-idea"
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={colors.accent} />
        }
      >
        <Card className="gap-3 px-3.5 py-4">
          <View className="flex-row gap-3.5">
            <View className="h-16 w-14 items-center justify-center rounded-control border border-border">
              <Icon as={ChevronUp} className="size-4 text-text-3" />
              <Text className="text-base font-semibold tabular-nums">{String(idea.voteCount)}</Text>
            </View>
            <View className="min-w-0 flex-1 gap-1.5">
              <Text
                className="text-[18px] font-semibold leading-6 tracking-[-0.18px]"
                testID="idea-title"
              >
                {idea.title}
              </Text>
              <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                <StatusPill status={idea.status} />
                <Text className="text-[12.5px] text-text-3">
                  {`${names.get(idea.areaId) ?? idea.areaId} · #${idea.number} · ${relativeTimeAgo(idea.createdAt)}`}
                </Text>
                {idea.hidden ? (
                  <Badge variant="pending" testID="idea-taken-down">
                    <Text>{IDEAS_TEAM_WORDS.takenDown}</Text>
                  </Badge>
                ) : null}
              </View>
            </View>
          </View>
          {idea.mergedInto ? (
            <Pressable
              role="link"
              onPress={() => open(idea.mergedInto!.id)}
              className="flex-row gap-2.5 rounded-control bg-card-2 px-3 py-2.5 active:opacity-80"
              testID="idea-merged"
            >
              <Icon as={GitMerge} className="mt-0.5 size-4 text-text-3" />
              <Text className="flex-1 text-[13.5px] leading-5">
                {`${IDEAS_TEAM_WORDS.mergedInto} `}
                <Text className="font-medium underline">
                  {`#${idea.mergedInto.number} ${idea.mergedInto.title}`}
                </Text>
                .
              </Text>
            </Pressable>
          ) : null}
          {idea.body ? (
            <PlainText text={idea.body} />
          ) : (
            <Text className="text-[13px] text-text-3">{IDEAS_TEAM_WORDS.noDetails}</Text>
          )}
          <View className="flex-row flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={Pencil}
              onPress={() => setSheet('edit')}
              testID="idea-tidy"
            >
              {IDEAS_TEAM_WORDS.tidy}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={idea.hidden ? Eye : EyeOff}
              loading={busy === 'hide'}
              onPress={() =>
                void run(
                  'hide',
                  () =>
                    desk('/v1/commands/idea.set_hidden', { ideaId: idea.id, hidden: !idea.hidden }),
                  idea.hidden ? IDEAS_DESK_WORDS.unhidden : IDEAS_DESK_WORDS.hidden,
                )
              }
              testID="idea-hide"
            >
              {idea.hidden ? IDEAS_TEAM_WORDS.unhide : IDEAS_TEAM_WORDS.hide}
            </Button>
          </View>
        </Card>

        {canManage && !idea.mergedInto ? (
          <Section title={IDEAS_WORDS.whereItStands} testID="idea-status-form">
            <Pressable
              role="button"
              accessibilityLabel={`${IDEAS_WORDS.statusLabel}. ${IDEA_STATUS_WORDS[idea.status]}`}
              onPress={() => setSheet('status')}
              className="-mx-2 min-h-10 flex-row items-center justify-between gap-3 rounded-control px-2 active:bg-card-2"
              testID="idea-status-pick"
            >
              <Text className="text-[13.5px] text-text-3">{IDEAS_WORDS.statusLabel}</Text>
              <Text className="text-[13.5px] font-medium text-accent-text">
                {IDEA_STATUS_WORDS[idea.status]}
              </Text>
            </Pressable>
            <Button
              variant="secondary"
              size="md"
              onPress={() => setSheet('status')}
              testID="idea-post-update"
            >
              {IDEAS_TEAM_WORDS.postUpdate}
            </Button>
          </Section>
        ) : null}

        <Section title={IDEAS_TEAM_WORDS.whoIsBehind} testID="idea-behind">
          {team.author ? (
            <View className="gap-0.5">
              <Text className="text-[13.5px]">
                {`${IDEAS_TEAM_WORDS.sharedBy} `}
                <Text className="font-medium">{team.author.name || team.author.email}</Text>
              </Text>
              <Text selectable className="text-[13px] text-text-3">
                {team.author.email}
              </Text>
              {team.business ? (
                canReadBusinesses ? (
                  <Pressable
                    role="link"
                    onPress={() => router.push(deskHref(`businesses/${team.business!.id}`) as Href)}
                    className="min-h-9 justify-center active:opacity-70"
                    testID="idea-business"
                  >
                    <Text className="text-[13.5px] font-medium text-accent-text">
                      {team.business.name}
                    </Text>
                  </Pressable>
                ) : (
                  <Text className="text-[13.5px]">{team.business.name}</Text>
                )
              ) : null}
            </View>
          ) : (
            <Text className="text-[13px] text-text-3">{IDEAS_TEAM_WORDS.authorLeft}</Text>
          )}
          <Text className="text-[13px]" testID="idea-support">
            {IDEAS_TEAM_WORDS.support(team.voters.length, team.businessCount, team.followerCount)}
          </Text>
          {team.voters.length ? (
            <View className="overflow-hidden rounded-control border border-border">
              {team.voters.map((v, i) => (
                <View
                  key={v.userId}
                  className={cn('gap-px px-3 py-2', i > 0 && 'border-t border-border')}
                >
                  <Text className="text-[13px] font-medium">{v.name || v.email}</Text>
                  <Text className="text-xs text-text-3" numberOfLines={1}>
                    {`${v.business?.name ?? IDEAS_TEAM_WORDS.noBusiness} · ${ideaDay(v.votedAt)}`}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </Section>

        {updates.length ? (
          <Section title={IDEAS_WORDS.whatHappened} testID="idea-updates">
            {updates.map((u) => (
              <View key={u.id} className="gap-1 rounded-control border border-border px-3 py-2">
                <Text className="text-[13px]">
                  <Text className="font-medium">{ideaTeamUpdateLine(u)}</Text>
                  <Text className="text-text-3">{` · ${u.by} · ${ideaDay(u.createdAt)}`}</Text>
                </Text>
                {u.note ? <Text className="text-[13px] text-text-2">{u.note}</Text> : null}
              </View>
            ))}
          </Section>
        ) : null}

        <Section title={IDEAS_TEAM_WORDS.comments} testID="idea-comments">
          {comments.length ? (
            comments.map((c) => (
              <CommentView
                key={c.id}
                comment={c}
                busy={busy === `comment-${c.id}`}
                onToggle={() =>
                  void run(`comment-${c.id}`, () =>
                    desk('/v1/commands/idea.set_comment_hidden', {
                      commentId: c.id,
                      hidden: !c.hidden,
                    }),
                  )
                }
              />
            ))
          ) : (
            <Text className="text-[13px] text-text-3">{IDEAS_TEAM_WORDS.noComments}</Text>
          )}
        </Section>

        {idea.mergedInto ? null : (
          <Section
            title={IDEAS_TEAM_WORDS.duplicate}
            detail={IDEAS_TEAM_WORDS.duplicateDetail}
            testID="idea-duplicate"
          >
            <Input
              value={dupSearch}
              onChangeText={setDupSearch}
              placeholder={IDEAS_TEAM_WORDS.findDuplicate}
              accessibilityLabel={IDEAS_TEAM_WORDS.findDuplicate}
              autoCorrect={false}
              className="h-11"
              testID="idea-dup-search"
            />
            {matches.length ? (
              matches.map((m) => (
                <View key={m.id} className="flex-row items-center gap-2">
                  <Text className="min-w-0 flex-1 text-[13px]" numberOfLines={2}>
                    {`#${m.number} ${m.title} `}
                    <Text className="text-text-3">{`· ${m.voteCount}`}</Text>
                  </Text>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => setMergeInto(m)}
                    testID={`idea-merge-${m.number}`}
                  >
                    {IDEAS_TEAM_WORDS.mergeInto}
                  </Button>
                </View>
              ))
            ) : (
              <Text className="text-xs text-text-3">{IDEAS_TEAM_WORDS.noDuplicates}</Text>
            )}
          </Section>
        )}
      </ScrollView>

      {idea.mergedInto ? null : (
        <View
          className="border-t border-border bg-card px-3 pt-2.5"
          style={{ paddingBottom: Math.max(insets.bottom, 10) }}
        >
          <Button onPress={() => setSheet('answer')} testID="team-answer-open">
            {IDEAS_TEAM_WORDS.answer}
          </Button>
        </View>
      )}

      <EditSheet
        open={sheet === 'edit'}
        idea={idea}
        areas={areas}
        onClose={() => setSheet(null)}
        onSaved={() => {
          setSheet(null);
          toast.show(IDEAS_DESK_WORDS.saved);
          reload();
        }}
      />
      {canManage ? (
        <StatusSheet
          open={sheet === 'status'}
          idea={idea}
          followers={team.followerCount}
          onClose={() => setSheet(null)}
          onDone={(said) => {
            setSheet(null);
            toast.show(said);
            reload();
          }}
        />
      ) : null}
      <AnswerSheet
        open={sheet === 'answer'}
        ideaId={idea.id}
        onClose={() => setSheet(null)}
        onPosted={() => {
          setSheet(null);
          toast.show(IDEAS_DESK_WORDS.answerPosted);
          reload();
        }}
      />
      <MergeSheet
        idea={idea}
        into={mergeInto}
        onClose={() => setMergeInto(null)}
        onMerged={(n) => {
          setMergeInto(null);
          toast.show(IDEAS_DESK_WORDS.merged(n));
          reload();
        }}
      />
    </Screen>
  );
}

/** Other ideas that sound like this one, a moment after the typing stops; only the latest answer counts. */
function useSimilar(text: string, excludeIdeaId: string): readonly Similar[] {
  const [found, setFound] = React.useState<readonly Similar[]>([]);
  const asked = React.useRef(0);
  React.useEffect(() => {
    const typed = text.trim();
    const n = ++asked.current;
    if (typed.length < 3) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      desk('/v1/queries/idea.similar', { text: typed, excludeIdeaId })
        .then((out) => {
          if (n === asked.current) setFound(out.ideas);
        })
        // Not finding matches is no reason to shout.
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [text, excludeIdeaId]);
  return found;
}

/** A comment as the team sees it: taken-down ones too, faded, with Take down or Put back beside each. */
function CommentView({
  comment: c,
  busy,
  onToggle,
}: {
  comment: Comment;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <View
      className={cn(
        'gap-1 rounded-card border px-3.5 py-3',
        c.author.team ? 'border-accent-soft-2 bg-accent-soft' : 'border-border bg-card',
        c.hidden && 'opacity-60',
      )}
      testID={`idea-comment-${c.id}`}
    >
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-[13px] font-medium">{c.author.name || IDEAS_WORDS.someone}</Text>
        {c.author.team ? (
          <Badge variant="accent">
            <Text className="font-semibold">{IDEAS_TEAM_WORDS.team}</Text>
          </Badge>
        ) : null}
        {c.hidden ? (
          <Text className="text-[12px] text-warning-text">{IDEAS_TEAM_WORDS.takenDown}</Text>
        ) : null}
        <Text className="text-[12px] text-text-3">{relativeTimeAgo(c.createdAt)}</Text>
        <Pressable
          role="button"
          onPress={onToggle}
          disabled={busy}
          hitSlop={10}
          className="ml-auto"
          testID={`idea-comment-toggle-${c.id}`}
        >
          <Text className="text-[12px] text-text-3">
            {c.hidden ? IDEAS_TEAM_WORDS.putBack : IDEAS_TEAM_WORDS.takeDown}
          </Text>
        </Pressable>
      </View>
      <Text selectable className="text-[14px] leading-[20px]">
        {c.body}
      </Text>
    </View>
  );
}

/** Tidying an idea's words and its area, as the team may whoever shared it. */
function EditSheet({
  open,
  idea,
  areas,
  onClose,
  onSaved,
}: {
  open: boolean;
  idea: Idea;
  areas: readonly Area[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const [title, setTitle] = React.useState(idea.title);
  const [body, setBody] = React.useState(idea.body);
  const [areaId, setAreaId] = React.useState(idea.areaId);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setTitle(idea.title);
    setBody(idea.body);
    setAreaId(idea.areaId);
    setProblem(null);
  }, [open, idea.title, idea.body, idea.areaId]);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/idea.edit', {
        ideaId: idea.id,
        title: title.trim(),
        body: body.trim(),
        areaId,
      });
      onSaved();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={IDEAS_TEAM_WORDS.tidy} scroll testID="idea-edit">
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="mt-3 gap-3">
        <View className="gap-1.5">
          <Label>{IDEAS_TEAM_WORDS.titleLabel}</Label>
          <Input
            value={title}
            onChangeText={setTitle}
            maxLength={140}
            accessibilityLabel={IDEAS_TEAM_WORDS.titleLabel}
            testID="idea-edit-title"
          />
        </View>
        <View className="gap-1.5">
          <Label>{IDEAS_TEAM_WORDS.detailsLabel}</Label>
          <Input
            value={body}
            onChangeText={setBody}
            multiline
            textAlignVertical="top"
            maxLength={5000}
            accessibilityLabel={IDEAS_TEAM_WORDS.detailsLabel}
            className="h-32 py-3"
            testID="idea-edit-body"
          />
        </View>
        <View className="gap-1.5">
          <Label>{IDEAS_TEAM_WORDS.areaLabel}</Label>
          <FilterChips
            options={areas.map((a) => ({
              key: a.id,
              label: `${a.name}${a.archived ? IDEAS_TEAM_WORDS.archivedSuffix : ''}`,
            }))}
            value={areaId}
            onChange={setAreaId}
            testID="idea-edit-area"
          />
        </View>
        {problem ? <FieldError>{problem}</FieldError> : null}
        <Button onPress={() => void save()} loading={busy} testID="idea-edit-save">
          {IDEAS_TEAM_WORDS.save}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {IDEAS_TEAM_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * Where it stands (leads and admins): a new status with a note the followers are emailed, or, with the status as it
 * was, a note alone as an update ("still planned, now for spring").
 */
function StatusSheet({
  open,
  idea,
  followers,
  onClose,
  onDone,
}: {
  open: boolean;
  idea: Idea;
  followers: number;
  onClose: () => void;
  onDone: (said: string) => void;
}) {
  const keyboard = useKeyboardHeight();
  const [status, setStatus] = React.useState<IdeaStatus>(idea.status);
  const [note, setNote] = React.useState('');
  const [notify, setNotify] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setStatus(idea.status);
    setNote('');
    setNotify(true);
    setProblem(null);
  }, [open, idea.status]);

  const changed = status !== idea.status;
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/idea.set_status', {
        ideaId: idea.id,
        status,
        note: note.trim(),
        notify,
      });
      onDone(changed ? IDEAS_DESK_WORDS.moved(status) : IDEAS_DESK_WORDS.updatePosted);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={IDEAS_WORDS.whereItStands}
      scroll
      testID="idea-status-sheet"
    >
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="mt-3 gap-3">
        <View
          className="overflow-hidden rounded-card border border-border bg-card"
          accessibilityLabel={IDEAS_WORDS.statusLabel}
        >
          {IDEA_STATUSES.map((s, i) => {
            const on = s === status;
            return (
              <Pressable
                key={s}
                role="radio"
                accessibilityState={{ checked: on }}
                onPress={() => setStatus(s)}
                testID={`idea-status-${s}`}
                className={cn(
                  'min-h-12 flex-row items-center gap-3 px-4 active:bg-card-2',
                  i > 0 && 'border-t border-border',
                )}
              >
                <Text className="min-w-0 flex-1 text-base">{IDEA_STATUS_WORDS[s]}</Text>
                {on ? <Icon as={Check} className="size-5 text-accent" /> : null}
              </Pressable>
            );
          })}
        </View>
        <Input
          value={note}
          onChangeText={setNote}
          multiline
          textAlignVertical="top"
          maxLength={2000}
          placeholder={
            changed ? IDEAS_TEAM_WORDS.notePlaceholderMove : IDEAS_TEAM_WORDS.notePlaceholderUpdate
          }
          accessibilityLabel={IDEAS_TEAM_WORDS.noteLabel}
          className="h-28 py-3"
          testID="idea-status-note"
        />
        <View className="min-h-11 flex-row items-center justify-between gap-3">
          <Text className="min-w-0 flex-1 text-[14.5px]">
            {IDEAS_TEAM_WORDS.emailFollowers(followers)}
          </Text>
          <Switch
            checked={notify}
            onCheckedChange={setNotify}
            label={IDEAS_TEAM_WORDS.emailFollowers(followers)}
            testID="idea-status-notify"
          />
        </View>
        {problem ? <FieldError>{problem}</FieldError> : null}
        <Button
          onPress={() => void save()}
          loading={busy}
          disabled={!changed && !note.trim()}
          testID="idea-status-save"
        >
          {changed ? IDEAS_TEAM_WORDS.moveTo(status) : IDEAS_TEAM_WORDS.postUpdate}
        </Button>
      </View>
    </Sheet>
  );
}

/** Answering as the team: a comment with the HandsFreeOS badge, and whoever shared the idea is emailed. */
function AnswerSheet({
  open,
  ideaId,
  onClose,
  onPosted,
}: {
  open: boolean;
  ideaId: string;
  onClose: () => void;
  onPosted: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const [answer, setAnswer] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  const post = async () => {
    const body = answer.trim();
    if (!body) return;
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/idea.comment', { ideaId, body });
      setAnswer('');
      onPosted();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={IDEAS_TEAM_WORDS.answer} testID="team-answer-sheet">
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="mt-3 gap-3">
        <Input
          value={answer}
          onChangeText={setAnswer}
          multiline
          textAlignVertical="top"
          maxLength={5000}
          placeholder={IDEAS_TEAM_WORDS.answerPlaceholder}
          accessibilityLabel={IDEAS_TEAM_WORDS.answer}
          className="h-32 py-3"
          testID="team-answer"
        />
        {problem ? <FieldError>{problem}</FieldError> : null}
        <Button
          onPress={() => void post()}
          loading={busy}
          disabled={!answer.trim()}
          testID="team-answer-post"
        >
          {IDEAS_TEAM_WORDS.postAnswer}
        </Button>
      </View>
    </Sheet>
  );
}

/** "Merge #14 into #9?": its votes and followers move over, and they are told where it went. */
function MergeSheet({
  idea,
  into,
  onClose,
  onMerged,
}: {
  idea: Idea;
  into: Similar | null;
  onClose: () => void;
  onMerged: (number: number) => void;
}) {
  const keyboard = useKeyboardHeight();
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  // Kept while the sheet slides away, so its words don't vanish under it.
  const [shown, setShown] = React.useState<Similar | null>(into);
  React.useEffect(() => {
    if (!into) return;
    setShown(into);
    setProblem(null);
  }, [into]);

  const merge = async () => {
    if (!into) return;
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/idea.merge', {
        ideaId: idea.id,
        intoIdeaId: into.id,
        note: note.trim(),
        notify: true,
      });
      setNote('');
      onMerged(into.number);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={into !== null}
      onClose={onClose}
      title={shown ? IDEAS_TEAM_WORDS.mergeQuestion(idea.number, shown.number) : ''}
      description={IDEAS_TEAM_WORDS.duplicateDetail}
      testID="idea-merge-sheet"
    >
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="mt-3 gap-3">
        {shown ? (
          <Text className="text-[13.5px] text-text-2">{`#${shown.number} ${shown.title}`}</Text>
        ) : null}
        <Input
          value={note}
          onChangeText={setNote}
          maxLength={2000}
          placeholder={IDEAS_TEAM_WORDS.mergeNote}
          accessibilityLabel={IDEAS_TEAM_WORDS.noteLabel}
          testID="idea-merge-note"
        />
        {problem ? <FieldError>{problem}</FieldError> : null}
        <Button onPress={() => void merge()} loading={busy} testID="idea-merge-confirm">
          {shown ? IDEAS_DESK_WORDS.mergeButton(shown.number) : IDEAS_TEAM_WORDS.mergeInto}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {IDEAS_TEAM_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}
