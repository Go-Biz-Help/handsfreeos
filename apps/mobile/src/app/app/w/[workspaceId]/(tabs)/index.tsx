import {
  ATTENTION_WORDS,
  foldAttentionRows,
  type AttentionItemOut,
  type AttentionKind,
  type AttentionScope,
} from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { FlatList, View } from 'react-native';

import { AddonNewsCard } from '@/components/add-ons/news-card';
import { AddonSuggestionCard } from '@/components/add-ons/suggestion-card';
import { useWaitingDrafts } from '@/components/drafts';
import { AttentionCard } from '@/components/home/attention-card';
import { AttentionGroup } from '@/components/home/attention-group';
import { SectionHead } from '@/components/home/bits';
import { CaughtUp, HandledByHandsFree } from '@/components/home/handled';
import { HomeEnvProvider, type HomeEnv } from '@/components/home/home-context';
import { HomeHeader } from '@/components/home/home-header';
import { DismissSheet, ItemSheet, PickTimeSheet } from '@/components/home/item-sheets';
import { LetHandleSheet } from '@/components/home/let-handle-sheet';
import { WaitingChanges } from '@/components/home/waiting-changes';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth';
import { greeting } from '@/lib/greeting';
import { useNetwork } from '@/lib/network';
import { useHomeActions, type HomeSheet } from '@/home/actions';
import { HomeTestTools } from '@/home/test-tools';
import {
  useClearedToday,
  useHome,
  useMembers,
  useNow,
  useTeammateName,
  useWorkspaceRow,
} from '@/home/use-home';

type Row =
  | {
      readonly key: string;
      readonly type: 'head';
      readonly label: string;
      readonly count: number;
      readonly urgent: boolean;
    }
  | { readonly key: string; readonly type: 'item'; readonly item: AttentionItemOut }
  | {
      readonly key: string;
      readonly type: 'group';
      readonly kind: AttentionKind;
      readonly items: readonly AttentionItemOut[];
    }
  | { readonly key: string; readonly type: 'handled' }
  | { readonly key: string; readonly type: 'caught-up' }
  | { readonly key: string; readonly type: 'loading' };

/** How long a card a link opened stays marked. */
const HIGHLIGHT_MS = 4000;
/** A sheet's slide away, before another opens. */
const SHEET_GAP_MS = 260;

/** A Home that can't draw shows why, and the other tabs still work. */
export { ScreenError as ErrorBoundary } from '@/components/shell/screen-error';

/**
 * Home: the Action Center, as the canvas draws it on the phone and the web draws it at 390 px. The greeting and the quiet
 * "Up to date" line, "$ affected" with the counts, Mine / Everyone, then Urgent, Up next (three or more lower items of
 * one kind folded into a group) and "Handled by HandsFreeOS", and under it, now and then and only for an owner or
 * an admin, an add-on that fits the business (`AddonSuggestionCard`, asked of HandsFreeOS rather than the copy),
 * and news of an add-on the business voted for (`AddonNewsCard`).
 * Everything else is read from the phone's copy and ranked by core's scoring, so it's the web's list at the same
 * moment; every button's command waits for signal on the phone. The list is virtualized. A link with `?item=` brings
 * that card into view and marks it for a moment.
 */
export default function Home() {
  const { me, business, userId } = useBusiness();
  const state = useSession();
  const { online } = useNetwork();
  const params = useLocalSearchParams<{ item?: string }>();
  const now = useNow();
  const [scope, setScope] = React.useState<AttentionScope | null>(null);
  const home = useHome(scope, now);
  const members = useMembers();
  const teammateName = useTeammateName();
  const workspace = useWorkspaceRow();
  const timeZone = workspace.timezone || business.timezone || 'UTC';
  const drafts = useWaitingDrafts();
  const [sheet, setSheet] = React.useState<HomeSheet | null>(null);
  const [highlightId, setHighlightId] = React.useState<string | null>(params.item ?? null);
  const list = React.useRef<FlatList<Row>>(null);

  // One sheet at a time: one opened from another (⋯ → Dismiss) waits for the first to slide away.
  const closedAt = React.useRef(0);
  const open = React.useCallback((next: HomeSheet) => {
    const wait = SHEET_GAP_MS - (Date.now() - closedAt.current);
    if (wait > 0) setTimeout(() => setSheet(next), wait);
    else setSheet(next);
  }, []);
  const close = React.useCallback(() => {
    closedAt.current = Date.now();
    setSheet(null);
  }, []);
  const act = useHomeActions({
    workspaceId: business.id,
    timeZone,
    myUserId: userId,
    members,
    open,
  });
  const draftById = React.useMemo(
    () => new Map(drafts.items.map((d) => [d.draft.id, d.draft])),
    [drafts.items],
  );

  // Items cleared today count as handled today, but only HandsFreeOS knows them (they don't reach phones).
  const cleared = useClearedToday(home.list.scope, timeZone, now);
  const data = React.useMemo(
    () => ({ ...home.list, handledToday: home.list.handledToday + cleared }),
    [home.list, cleared],
  );
  const items = data.items;
  // A refused change whose item isn't on Home says why over the list; one whose card is back says it on the card.
  const refusedElsewhere = React.useMemo(() => {
    const shown = new Set([...data.items.map((i) => i.id)]);
    return [...home.refused.values()].filter((c) => !shown.has(c.itemId));
  }, [data.items, home.refused]);
  const urgent = items.filter((i) => i.urgent);
  const upNext = items.filter((i) => !i.urgent);
  const rows = React.useMemo<Row[]>(() => {
    if (home.loading && !items.length) return [{ key: 'loading', type: 'loading' }];
    if (!items.length) return [{ key: 'caught-up', type: 'caught-up' }];
    const out: Row[] = [];
    if (urgent.length) {
      out.push({
        key: 'head-urgent',
        type: 'head',
        label: ATTENTION_WORDS.urgent,
        count: urgent.length,
        urgent: true,
      });
      for (const item of urgent) out.push({ key: item.id, type: 'item', item });
    }
    if (upNext.length) {
      out.push({
        key: 'head-next',
        type: 'head',
        label: ATTENTION_WORDS.upNext,
        count: upNext.length,
        urgent: false,
      });
      for (const r of foldAttentionRows(upNext, urgent.length))
        out.push(
          r.type === 'item'
            ? { key: r.item.id, type: 'item', item: r.item }
            : { key: `group-${r.kind}`, type: 'group', kind: r.kind, items: r.items },
        );
    }
    out.push({ key: 'handled', type: 'handled' });
    return out;
  }, [home.loading, items, urgent, upNext]);

  // A link's `?item=`: bring that card into view, and mark it for a few seconds.
  React.useEffect(() => {
    if (params.item) setHighlightId(params.item);
  }, [params.item]);
  React.useEffect(() => {
    if (!highlightId) return;
    const index = rows.findIndex((r) => r.type === 'item' && r.item.id === highlightId);
    if (index >= 0) list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true });
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
    // Once per link: the rows moving on their own don't scroll it back.
  }, [highlightId, rows.length > 1]);

  const env: HomeEnv = {
    workspaceId: business.id,
    timeZone,
    now,
    myUserId: userId,
    members,
    teammateName,
    online,
    drafts: draftById,
    refused: home.refused,
    handing: home.handing,
    highlightId,
    act,
  };
  const fullName =
    me.user.fullName || (state.status === 'signedIn' ? (state.person.name ?? '') : '');

  const renderItem = ({ item: row }: { item: Row }) => {
    switch (row.type) {
      case 'loading':
        return (
          <Card className="px-5 py-8" testID="attention-loading">
            <Text className="text-center text-[13px] text-text-3">{ATTENTION_WORDS.loading}</Text>
          </Card>
        );
      case 'caught-up':
        return (
          <>
            <CaughtUp items={data.handled} count={data.handledToday} />
            <AddonNewsCard className="mt-2.5" />
            <AddonSuggestionCard className="mt-2.5" />
            <HomeTestTools workspaceId={business.id} list={data} timeZone={timeZone} />
          </>
        );
      case 'head':
        return (
          <View className={row.urgent ? '' : 'mt-2'}>
            <SectionHead
              label={row.label}
              count={row.count}
              urgent={row.urgent}
              testID={row.urgent ? 'attention-urgent' : 'attention-next'}
            />
          </View>
        );
      case 'item':
        return <AttentionCard item={row.item} />;
      case 'group':
        return <AttentionGroup kind={row.kind} items={row.items} />;
      case 'handled':
        return (
          <>
            <HandledByHandsFree items={data.handled} />
            <AddonNewsCard className="mt-2.5" />
            <AddonSuggestionCard className="mt-2.5" />
            <HomeTestTools workspaceId={business.id} list={data} timeZone={timeZone} />
          </>
        );
    }
  };

  return (
    <HomeEnvProvider value={env}>
      <Screen title="Home" testID="home" scroll={false}>
        <FlatList
          ref={list}
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={renderItem}
          testID="attention-list"
          ListHeaderComponent={
            <View className="-mx-3 -mt-3 mb-3 gap-3">
              <HomeHeader
                greeting={greeting(fullName.split(' ')[0] ?? '', timeZone)}
                total={items.length}
                urgent={urgent.length}
                handledToday={data.handledToday}
                affectedCents={data.affectedCents}
                scope={data.scope}
                onScope={setScope}
              />
              {home.waiting.length || refusedElsewhere.length ? (
                <View className="px-3">
                  <WaitingChanges
                    changes={home.waiting}
                    refused={refusedElsewhere}
                    titles={home.titles}
                  />
                </View>
              ) : null}
            </View>
          }
          ItemSeparatorComponent={() => <View className="h-2.5" />}
          contentContainerClassName="p-3 pb-8"
          initialNumToRender={8}
          windowSize={9}
          onScrollToIndexFailed={({ index, averageItemLength }) =>
            list.current?.scrollToOffset({ offset: index * averageItemLength, animated: true })
          }
        />
      </Screen>
      <ItemSheet item={sheet?.type === 'menu' ? sheet.item : null} onClose={close} />
      <DismissSheet item={sheet?.type === 'dismiss' ? sheet.item : null} onClose={close} />
      <PickTimeSheet item={sheet?.type === 'pick_time' ? sheet.item : null} onClose={close} />
      <LetHandleSheet item={sheet?.type === 'let_handle' ? sheet.item : null} onClose={close} />
    </HomeEnvProvider>
  );
}
