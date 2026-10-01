import {
  IDEA_STATUS_WORDS,
  IDEAS_WORDS,
  ideaDay,
  WHATS_NEW_KINDS,
  WHATS_NEW_KIND_WORDS,
  WHATS_NEW_TEAM_WORDS,
  type IdeaStatus,
  type WhatsNewKind,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { IDEAS_DESK_WORDS } from '@/admin/ideas-words';
import { desk, useLive, usePaged, type Ok } from '@/admin/live';
import { DeskWaiting, Empty, FilterChips } from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { SquarePen, X } from '@/components/icons';
import { KindPill, PlainText } from '@/components/ideas/idea-bits';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useColors } from '@/theme';

type WhatsNewList = Ok<'/v1/queries/whats_new.list'>;
type Entry = WhatsNewList['entries'][number];
type Area = Ok<'/v1/queries/idea.areas'>['areas'][number];
type LinkedIdea = { id: string; number: number; title: string; status: IdeaStatus };

interface Draft {
  readonly id: string | null;
  readonly title: string;
  readonly body: string;
  readonly kind: WhatsNewKind;
  readonly areaId: string;
  readonly ideas: readonly LinkedIdea[];
}

const blank: Draft = { id: null, title: '', body: '', kind: 'new', areaId: '', ideas: [] };

/** How many entries come down at a time: the web's page shows this many. */
const PAGE = 50;

/**
 * Writing What's new (the web's /admin/ideas/whats-new). An entry is a draft only the team sees until it is
 * published; publishing marks the ideas it delivers Done (unless told not to) and emails everybody following them,
 * the moment a person who asked for something hears that it is here. Every support role reads the drafts here;
 * leads and admins write, publish, unpublish and delete them.
 */
export default function DeskWhatsNew() {
  const colors = useColors();
  const canManage = useDeskCan('platform.ideas.manage');
  const list = usePaged<WhatsNewList>(
    (cursor) =>
      desk('/v1/queries/whats_new.list', {
        includeDrafts: true,
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      }),
    (was, page) => ({
      entries: [
        ...was.entries,
        ...page.entries.filter((e) => !was.entries.some((w) => w.id === e.id)),
      ],
      nextCursor: page.nextCursor,
    }),
    'whats-new-admin',
  );
  const areas = useLive(() => desk('/v1/queries/idea.areas', {}), 'idea-areas');
  const names = new Map((areas.data?.areas ?? []).map((a) => [a.id, a.name]));
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [markDone, setMarkDone] = React.useState(true);
  const [asking, setAsking] = React.useState<{ kind: 'publish' | 'delete'; entry: Entry } | null>(
    null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<unknown>, said: string) => {
    setBusy(what);
    try {
      await fn();
      toast.show(said);
      list.reload();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const edit = (e: Entry) =>
    setDraft({
      id: e.id,
      title: e.title,
      body: e.body,
      kind: e.kind,
      areaId: e.areaId ?? '',
      ideas: e.ideas.map((i) => ({ id: i.id, number: i.number, title: i.title, status: i.status })),
    });

  const answer = async () => {
    if (!asking) return;
    const { kind, entry } = asking;
    const ok =
      kind === 'publish'
        ? await run(
            `publish-${entry.id}`,
            () => desk('/v1/commands/whats_new.publish', { id: entry.id, markIdeasDone: markDone }),
            WHATS_NEW_TEAM_WORDS.publishedToast,
          )
        : await run(
            `delete-${entry.id}`,
            () => desk('/v1/commands/whats_new.delete', { id: entry.id }),
            WHATS_NEW_TEAM_WORDS.deleted,
          );
    if (ok) setAsking(null);
  };

  return (
    <Screen
      title={IDEAS_WORDS.tabs.whatsNew}
      leading="back"
      back={deskHref('ideas')}
      scroll={false}
      testID="desk-whats-new"
    >
      {list.data ? (
        <FlatList
          data={list.data.entries}
          keyExtractor={(e) => e.id}
          renderItem={({ item }) => (
            <EntryView
              entry={item}
              area={item.areaId ? (names.get(item.areaId) ?? item.areaId) : null}
              canManage={canManage}
              busy={busy}
              onEdit={() => edit(item)}
              onPublish={() => setAsking({ kind: 'publish', entry: item })}
              onDelete={() => setAsking({ kind: 'delete', entry: item })}
              onUnpublish={() =>
                void run(
                  `unpublish-${item.id}`,
                  () => desk('/v1/commands/whats_new.unpublish', { id: item.id }),
                  WHATS_NEW_TEAM_WORDS.unpublished,
                )
              }
            />
          )}
          contentContainerClassName="p-3 pb-8"
          ItemSeparatorComponent={() => <View className="h-3" />}
          testID="whats-new-list"
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={list.reload}
              tintColor={colors.accent}
            />
          }
          ListHeaderComponent={
            <View className="mb-3 gap-3">
              <Text className="px-1 text-[13px] leading-[18px] text-text-3">
                {WHATS_NEW_TEAM_WORDS.intro}
              </Text>
              {canManage ? (
                <>
                  <Button icon={SquarePen} onPress={() => setDraft(blank)} testID="whats-new-add">
                    {WHATS_NEW_TEAM_WORDS.write}
                  </Button>
                  <Card className="flex-row items-center gap-3 px-3.5 py-3">
                    <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px]">
                      {WHATS_NEW_TEAM_WORDS.markDone}
                    </Text>
                    <Switch
                      checked={markDone}
                      onCheckedChange={setMarkDone}
                      label={WHATS_NEW_TEAM_WORDS.markDone}
                      testID="whats-new-mark-done"
                    />
                  </Card>
                </>
              ) : null}
            </View>
          }
          ListEmptyComponent={<Empty title={IDEAS_WORDS.whatsNewEmpty} testID="whats-new-empty" />}
          ListFooterComponent={
            list.hasMore ? (
              <Button
                variant="secondary"
                className="mt-4"
                loading={list.loadingMore}
                onPress={list.more}
                testID="whats-new-more"
              >
                {IDEAS_WORDS.showOlder}
              </Button>
            ) : null
          }
        />
      ) : (
        <DeskWaiting live={list} testID="whats-new" />
      )}

      {canManage ? (
        <>
          <EditorSheet
            draft={draft}
            areas={areas.data?.areas ?? []}
            onChange={setDraft}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              toast.show(WHATS_NEW_TEAM_WORDS.savedDraft);
              list.reload();
            }}
          />
          <ConfirmSheet
            asking={asking}
            markDone={markDone}
            busy={busy !== null}
            onClose={() => setAsking(null)}
            onConfirm={() => void answer()}
          />
        </>
      ) : null}
    </Screen>
  );
}

/** One entry: what it is, published or a draft, its words, the ideas it delivers, and what the team can do with it. */
function EntryView({
  entry: e,
  area,
  canManage,
  busy,
  onEdit,
  onPublish,
  onUnpublish,
  onDelete,
}: {
  entry: Entry;
  area: string | null;
  canManage: boolean;
  busy: string | null;
  onEdit: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="gap-2 px-4 py-3.5" testID={`wn-entry-${e.id}`}>
      <View className="flex-row flex-wrap items-center gap-2">
        <KindPill kind={e.kind} />
        {e.publishedAt ? (
          <Text className="text-[13px] text-text-3">
            {WHATS_NEW_TEAM_WORDS.published(ideaDay(e.publishedAt))}
          </Text>
        ) : (
          <Badge variant="pending" testID="wn-draft">
            <Text>{WHATS_NEW_TEAM_WORDS.draft}</Text>
          </Badge>
        )}
        {area ? <Text className="text-[13px] text-text-3">{`· ${area}`}</Text> : null}
      </View>
      <Text className="text-[17px] font-semibold leading-6">{e.title}</Text>
      {e.body ? <PlainText text={e.body} /> : null}
      {e.ideas.length ? (
        <View className="gap-1">
          <Text className="text-[13px] text-text-2">{WHATS_NEW_TEAM_WORDS.delivers}</Text>
          {e.ideas.map((i) => (
            <Pressable
              key={i.id}
              role="link"
              onPress={() => router.push(deskHref(`ideas/${i.id}`) as Href)}
              className="min-h-8 justify-center active:opacity-70"
              testID={`wn-idea-${i.number}`}
            >
              <Text className="text-[13px] text-text-2">
                <Text className="underline">{`#${i.number} ${i.title}`}</Text>
                {` (${IDEA_STATUS_WORDS[i.status]})`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {canManage ? (
        <View className="flex-row flex-wrap gap-2 pt-1">
          <Button size="sm" variant="secondary" onPress={onEdit} testID="wn-edit">
            {WHATS_NEW_TEAM_WORDS.edit}
          </Button>
          {e.publishedAt ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === `unpublish-${e.id}`}
              onPress={onUnpublish}
              testID="wn-unpublish"
            >
              {WHATS_NEW_TEAM_WORDS.unpublish}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                loading={busy === `publish-${e.id}`}
                onPress={onPublish}
                testID="wn-publish"
              >
                {WHATS_NEW_TEAM_WORDS.publish}
              </Button>
              <Button
                size="sm"
                variant="ghostDanger"
                loading={busy === `delete-${e.id}`}
                onPress={onDelete}
                testID="wn-delete"
              >
                {WHATS_NEW_TEAM_WORDS.delete}
              </Button>
            </>
          )}
        </View>
      ) : null}
    </Card>
  );
}

/** Publish or delete, asked first, in the words the web's confirm box uses. */
function ConfirmSheet({
  asking,
  markDone,
  busy,
  onClose,
  onConfirm,
}: {
  asking: { kind: 'publish' | 'delete'; entry: Entry } | null;
  markDone: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  // Kept while the sheet slides away, so its words don't vanish under it.
  const [shown, setShown] = React.useState(asking);
  React.useEffect(() => {
    if (asking) setShown(asking);
  }, [asking]);
  const question = !shown
    ? ''
    : shown.kind === 'publish'
      ? WHATS_NEW_TEAM_WORDS.publishQuestion(
          shown.entry.title,
          shown.entry.ideas.filter((i) => i.status !== 'done').length,
          markDone,
        )
      : WHATS_NEW_TEAM_WORDS.deleteQuestion(shown.entry.title);

  return (
    <Sheet open={asking !== null} onClose={onClose} testID="wn-confirm">
      <View className="gap-3">
        <Text className="text-[15px] leading-[22px]" testID="wn-confirm-question">
          {question}
        </Text>
        <Button
          variant={shown?.kind === 'delete' ? 'danger' : 'primary'}
          loading={busy}
          onPress={onConfirm}
          testID="wn-confirm-yes"
        >
          {shown?.kind === 'delete' ? WHATS_NEW_TEAM_WORDS.delete : WHATS_NEW_TEAM_WORDS.publish}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {WHATS_NEW_TEAM_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}

/** Writing an entry, or changing one: it saves as a draft, whatever it was. */
function EditorSheet({
  draft,
  areas,
  onChange,
  onClose,
  onSaved,
}: {
  draft: Draft | null;
  areas: readonly Area[];
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const keyboard = useKeyboardHeight();
  const [find, setFind] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const open = draft !== null;
  React.useEffect(() => {
    if (!open) return;
    setFind('');
    setProblem(null);
  }, [open]);
  const found = useFound(open ? find : '');
  // Kept while the sheet slides away, so its fields don't empty under it.
  const [shown, setShown] = React.useState<Draft>(draft ?? blank);
  React.useEffect(() => {
    if (draft) setShown(draft);
  }, [draft]);
  const d = draft ?? shown;
  const set = (patch: Partial<Draft>) => onChange({ ...d, ...patch });

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await desk('/v1/commands/whats_new.save', {
        ...(d.id ? { id: d.id } : {}),
        title: d.title.trim(),
        body: d.body.trim(),
        kind: d.kind,
        areaId: d.areaId || null,
        ideaIds: d.ideas.map((i) => i.id),
      });
      onSaved();
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
      title={d.id ? IDEAS_DESK_WORDS.editTitle : WHATS_NEW_TEAM_WORDS.write}
      scroll
      testID="whats-new-editor"
    >
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="mt-3 gap-4">
        <View className="gap-1.5">
          <Label>{WHATS_NEW_TEAM_WORDS.titleLabel}</Label>
          <Input
            value={d.title}
            onChangeText={(title) => set({ title })}
            maxLength={140}
            placeholder={WHATS_NEW_TEAM_WORDS.titlePlaceholder}
            accessibilityLabel={WHATS_NEW_TEAM_WORDS.titleLabel}
            testID="wn-title"
          />
        </View>
        <View className="gap-1.5">
          <Label>{WHATS_NEW_TEAM_WORDS.kindLabel}</Label>
          <Segmented
            value={d.kind}
            onChange={(kind) => set({ kind })}
            label={WHATS_NEW_TEAM_WORDS.kindLabel}
            options={WHATS_NEW_KINDS.map((k) => ({
              value: k,
              label: WHATS_NEW_KIND_WORDS[k],
              testID: `wn-kind-${k}`,
            }))}
          />
        </View>
        <View className="gap-1.5">
          <Label>{WHATS_NEW_TEAM_WORDS.areaLabel}</Label>
          <FilterChips
            options={[
              { key: '', label: WHATS_NEW_TEAM_WORDS.noArea },
              ...areas.map((a) => ({ key: a.id, label: a.name })),
            ]}
            value={d.areaId}
            onChange={(areaId) => set({ areaId })}
            testID="wn-area"
          />
        </View>
        <View className="gap-1.5">
          <Label>{WHATS_NEW_TEAM_WORDS.bodyLabel}</Label>
          <Input
            value={d.body}
            onChangeText={(body) => set({ body })}
            multiline
            textAlignVertical="top"
            maxLength={20000}
            accessibilityLabel={WHATS_NEW_TEAM_WORDS.bodyLabel}
            className="h-40 py-3"
            testID="wn-body"
          />
          <Text className="text-xs leading-[17px] text-text-3">
            {WHATS_NEW_TEAM_WORDS.bodyHint}
          </Text>
        </View>
        <View className="gap-1.5">
          <Label>{WHATS_NEW_TEAM_WORDS.ideasLabel}</Label>
          <Text className="text-xs leading-[17px] text-text-3">
            {WHATS_NEW_TEAM_WORDS.ideasHint}
          </Text>
          {d.ideas.length ? (
            <View className="flex-row flex-wrap gap-2 pt-1">
              {d.ideas.map((i) => (
                <View
                  key={i.id}
                  className="max-w-full flex-row items-center gap-1 rounded-full border border-border bg-card-2 py-1 pl-3 pr-1"
                  testID={`wn-linked-${i.number}`}
                >
                  <Text className="flex-shrink text-[13px]" numberOfLines={1}>
                    {`#${i.number} ${i.title}`}
                  </Text>
                  <Pressable
                    role="button"
                    accessibilityLabel={WHATS_NEW_TEAM_WORDS.removeIdea(i.number)}
                    onPress={() => set({ ideas: d.ideas.filter((x) => x.id !== i.id) })}
                    hitSlop={10}
                    className="size-7 items-center justify-center rounded-full active:bg-card-3"
                    testID={`wn-unlink-${i.number}`}
                  >
                    <Icon as={X} className="size-3.5 text-text-3" />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          <Input
            value={find}
            onChangeText={setFind}
            placeholder={WHATS_NEW_TEAM_WORDS.findIdea}
            accessibilityLabel={WHATS_NEW_TEAM_WORDS.findIdea}
            autoCorrect={false}
            className="h-11"
            testID="wn-find"
          />
          {found
            .filter((f) => !d.ideas.some((i) => i.id === f.id))
            .map((f) => (
              <Pressable
                key={f.id}
                role="button"
                onPress={() => {
                  set({ ideas: [...d.ideas, f] });
                  setFind('');
                }}
                className="min-h-10 justify-center rounded-control px-2 active:bg-card-2"
                testID={`wn-found-${f.number}`}
              >
                <Text className="text-[13px]" numberOfLines={1}>
                  {`#${f.number} ${f.title} `}
                  <Text className="text-text-3">{`· ${IDEA_STATUS_WORDS[f.status]}`}</Text>
                </Text>
              </Pressable>
            ))}
        </View>
        {problem ? <FieldError>{problem}</FieldError> : null}
        <Button onPress={() => void save()} loading={busy} testID="wn-save">
          {WHATS_NEW_TEAM_WORDS.saveDraft}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {WHATS_NEW_TEAM_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}

/** The ideas that sound like what's typed, to link; only the latest answer counts, and a failed one shows none. */
function useFound(text: string): readonly LinkedIdea[] {
  const [found, setFound] = React.useState<readonly LinkedIdea[]>([]);
  const asked = React.useRef(0);
  React.useEffect(() => {
    const typed = text.trim();
    const n = ++asked.current;
    if (typed.length < 3) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      desk('/v1/queries/idea.similar', { text: typed })
        .then((out) => {
          if (n === asked.current)
            setFound(
              out.ideas.map((i) => ({
                id: i.id,
                number: i.number,
                title: i.title,
                status: i.status,
              })),
            );
        })
        // Finding nothing is fine.
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);
  return found;
}
