import {
  copyMissingKinds,
  dropdownOf,
  groupLabel,
  holds,
  searchCount,
  searchHref,
  searchProbes,
  SEARCH_WORDS as W,
  unavailableLine,
  type SearchGroup,
  type SearchHit,
} from '@hfos/core';
import { usePowerSync } from '@powersync/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Clock, Search as SearchIcon, X } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useGrants } from '@/lib/grants';
import { openWeb } from '@/lib/open-web';
import { asOfText, useSyncStatus } from '@/lib/sync-status';
import {
  clearRecentSearches,
  rememberSearch,
  useRecentSearches,
  type RecentDb,
} from '@/search/recent';
import { BestMatch, GroupHeading, SearchNote, SearchRow } from '@/search/rows';
import {
  FULL_PER_KIND,
  KIND_PAGE,
  knownKind,
  searchedOffline,
  useEverything,
  useOneKind,
  useSettingsGroup,
  type EverythingState,
} from '@/search/use-search';

/**
 * Search everything on the phone (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, boards 5 and 5b), full screen over the
 * business. Reached from a link for now (a web `/search#q=…` link opens it with `q` and `kind`); Search 9 adds the app
 * bar's button. The box is focused, with Cancel; the kinds as chips with their counts, the ones that wait for signal
 * greyed when there's none; the best match with Call and Text; a few of each kind, each with See all; the Settings
 * group; and See all results. One kind (a chip, or See all) is a list 25 at a time with Show 25 more, and for contacts
 * Leads or Clients and the banner when two share a number. With no signal it searches the phone's own copy and says
 * so, as the board does.
 */
export default function Search() {
  const params = useLocalSearchParams<{ q?: string; kind?: string }>();
  const { business, userId } = useBusiness();
  const insets = useSafeAreaInsets();
  const db: RecentDb = usePowerSync();
  const [typed, setTyped] = React.useState(() => (params.q ?? '').trim().slice(0, 120));
  // A kind this build doesn't know is skipped: everything is searched instead.
  const [kind, setKind] = React.useState<string | null>(() =>
    params.kind && knownKind(params.kind) ? params.kind : null,
  );
  const [full, setFull] = React.useState(false);
  const everything = useEverything(typed, { full });
  const remember = React.useCallback(
    () => void rememberSearch(db, { workspaceId: business.id, userId }, typed).catch(() => null),
    [db, business.id, userId, typed],
  );

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(business.id));
  };

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }} testID="search">
      <View className="flex-row items-center gap-2 px-3 pb-2 pt-2">
        <View className="flex-1">
          <Input
            value={typed}
            onChangeText={(t) => {
              setTyped(t);
              setFull(false);
            }}
            placeholder={W.box}
            accessibilityLabel={W.box}
            autoFocus
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            maxLength={120}
            className="h-11"
            testID="search-box"
            trailing={
              typed ? (
                <Pressable
                  role="button"
                  accessibilityLabel={W.clear}
                  onPress={() => setTyped('')}
                  hitSlop={8}
                  className="size-11 items-center justify-center"
                >
                  <Icon as={X} className="size-4 text-text-3" />
                </Pressable>
              ) : (
                <View className="size-11 items-center justify-center">
                  <Icon as={SearchIcon} className="size-4 text-text-3" />
                </View>
              )
            }
          />
        </View>
        <Pressable
          role="button"
          onPress={close}
          hitSlop={8}
          className="min-h-11 justify-center px-1"
          testID="search-cancel"
        >
          <Text className="text-[15px] font-medium text-accent-text">{W.cancel}</Text>
        </Pressable>
      </View>
      <Chips everything={everything} kind={kind} onKind={setKind} />
      {typed.trim().length < 2 ? (
        <Recent onPick={setTyped} />
      ) : kind ? (
        <OneKind typed={typed} kind={kind} label={kindLabel(everything, kind)} onOpen={remember} />
      ) : (
        <Everything
          state={everything}
          full={full}
          onFull={() => setFull(true)}
          onKind={setKind}
          onOpen={remember}
        />
      )}
    </View>
  );
}

/** A kind's label, from the group that answered it, or core's. */
function kindLabel(s: EverythingState, kind: string): string {
  const group = [...(s.answer?.groups ?? []), ...(s.settings ? [s.settings] : [])].find(
    (g) => g.kind === kind,
  );
  return groupLabel(group ?? { kind, label: null });
}

/**
 * The dropdown's choices for an answer, with the phone's limits; when it's all of them, every group with all it
 * brought (`FULL_PER_KIND` a kind).
 */
function useDropdown(s: EverythingState, full: boolean) {
  return React.useMemo(
    () =>
      s.answer
        ? dropdownOf(
            s.answer,
            s.settings,
            full
              ? { maxGroups: 40, maxRows: 400, perGroup: FULL_PER_KIND }
              : { maxGroups: 6, maxRows: 12 },
          )
        : null,
    [s.answer, s.settings, full],
  );
}

/** The kinds as chips with their counts; with no signal, the ones that wait for it greyed. */
function Chips({
  everything,
  kind,
  onKind,
}: {
  everything: EverythingState;
  kind: string | null;
  onKind: (kind: string | null) => void;
}) {
  const { permissions } = useGrants();
  const dropdown = useDropdown(everything, false);
  const offline = everything.offline && !everything.viewingOffline;
  const missing = offline ? copyMissingKinds(permissions ?? []) : [];
  if (!dropdown && missing.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      className="max-h-11 grow-0"
      contentContainerClassName="items-center gap-1.5 px-3 pb-2"
      testID="search-chips"
    >
      {(dropdown?.chips ?? [])
        .filter((c) => c.kind !== 'close')
        .map((c) => (
          <FilterChip
            key={c.kind}
            label={c.label}
            count={searchCount(c.count, c.capped)}
            on={c.kind === 'all' ? kind === null : kind === c.kind}
            onPress={() => onKind(c.kind === 'all' ? null : c.kind)}
            testID={`search-chip-${c.kind}`}
          />
        ))}
      {missing.map((k) => (
        <FilterChip
          key={k.key}
          label={k.label ?? k.key}
          on={false}
          disabled
          onPress={() => undefined}
          testID={`search-chip-${k.key}`}
        />
      ))}
    </ScrollView>
  );
}

/** Recent searches, when nothing is typed yet. */
function Recent({ onPick }: { onPick: (q: string) => void }) {
  const { business, userId } = useBusiness();
  const db: RecentDb = usePowerSync();
  const recent = useRecentSearches(business.id, userId);
  if (recent.length === 0) return null;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" testID="search-recent">
      <View className="flex-row items-center px-4 pb-1.5 pt-3.5">
        <Text variant="group">{W.recent}</Text>
        <View className="flex-1" />
        <Pressable
          role="button"
          onPress={() =>
            void clearRecentSearches(db, { workspaceId: business.id, userId }).catch(() => null)
          }
          hitSlop={8}
          testID="search-recent-clear"
        >
          <Text className="text-[13px] font-medium text-accent-text">{W.clear}</Text>
        </Pressable>
      </View>
      {recent.map((r) => (
        <Pressable
          key={r.id}
          role="button"
          onPress={() => onPick(r.q)}
          className="min-h-12 flex-row items-center gap-3 border-t border-border px-4 active:bg-card-2"
          testID={`search-recent-${r.id}`}
        >
          <Icon as={Clock} className="size-4 text-text-3" />
          <Text className="flex-1 text-[15px]" numberOfLines={1}>
            {r.q}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** The lines at the top: viewing as someone with no signal, no signal, the phone's own rows, a refusal. */
function TopLines({
  state,
  source,
}: {
  state: { offline: boolean; viewingOffline: boolean; error: string | null; retry: () => void };
  source: 'server' | 'phone' | null;
}) {
  const { viewing } = useBusiness();
  const sync = useSyncStatus();
  if (state.viewingOffline)
    return (
      <SearchNote testID="search-viewing-offline">
        {W.viewingAsOffline(viewing?.person.fullName || viewing?.person.email || '')}
      </SearchNote>
    );
  if (state.offline && source === 'phone')
    return (
      <SearchNote testID="search-offline">
        {`${W.offline} ${asOfText(sync.asOf, Date.now())}`}
      </SearchNote>
    );
  if (state.error)
    return (
      <SearchNote
        tone="warning"
        action={{ label: W.tryAgain, onPress: state.retry }}
        testID="search-error"
      >
        {state.error}
      </SearchNote>
    );
  if (source === 'phone')
    return (
      <Text className="px-4 pt-1 text-[12px] text-text-3" testID="search-on-phone">
        {W.onThisPhone}
      </Text>
    );
  return null;
}

/** Everything: the best match, a few of each kind, Settings, and See all results. */
function Everything({
  state,
  full,
  onFull,
  onKind,
  onOpen,
}: {
  state: EverythingState;
  full: boolean;
  onFull: () => void;
  onKind: (kind: string) => void;
  onOpen: () => void;
}) {
  const { business } = useBusiness();
  const grants = useGrants();
  const dropdown = useDropdown(state, full);
  const timeZone = business.timezone || 'UTC';
  const now = React.useMemo(() => Date.now(), [state.answer]);
  const q = state.q;
  const row = (hit: SearchHit) => (
    <View key={`${hit.kind}:${hit.id}`} className="border-t border-border">
      <SearchRow
        hit={hit}
        q={q}
        workspaceId={business.id}
        now={now}
        timeZone={timeZone}
        onOpen={onOpen}
      />
    </View>
  );
  const group = (g: SearchGroup, rows: readonly SearchHit[], more: number) => (
    <View key={g.kind} testID={`search-group-${g.kind}`}>
      <GroupHeading
        label={groupLabel(g)}
        seeAll={
          more > 0 && g.kind !== 'archived' && g.kind !== 'bin' && g.kind !== 'close'
            ? { label: W.seeAll(g.total, g.capped), onPress: () => onKind(g.kind) }
            : null
        }
        testID={`search-heading-${g.kind}`}
      />
      {rows.map(row)}
    </View>
  );
  // Viewing as someone with no signal: only settings, found on the phone.
  const onlySettings = state.viewingOffline;

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-1 pb-8 pt-1"
      testID="search-results"
    >
      <TopLines state={state} source={state.answer?.source ?? null} />
      {onlySettings ? (
        state.settings ? (
          group(state.settings, state.settings.items, 0)
        ) : null
      ) : dropdown ? (
        <>
          {dropdown.line === 'close' ? (
            <SearchNote testID="search-close">{W.closeMatches(q)}</SearchNote>
          ) : dropdown.line === 'none_active' ? (
            <SearchNote testID="search-none-active">{W.noneActive(q)}</SearchNote>
          ) : dropdown.line === 'empty' ? (
            <View className="items-center gap-1 px-6 py-10" testID="search-empty">
              <Text className="text-center text-[15px] font-semibold">{W.noMatches(q)}</Text>
              <Text className="text-center text-[13px] text-text-2">{W.noMatchesHelp}</Text>
            </View>
          ) : null}
          {dropdown.unavailable.map((g) => (
            <SearchNote
              key={`unavailable-${g.kind}`}
              action={{ label: W.tryAgain, onPress: state.retry }}
              testID={`search-unavailable-${g.kind}`}
            >
              {unavailableLine(g)}
            </SearchNote>
          ))}
          {dropdown.best ? (
            <View>
              <GroupHeading label={W.best} />
              <View className="border-t border-border">
                <BestMatch
                  hit={dropdown.best}
                  q={q}
                  workspaceId={business.id}
                  now={now}
                  timeZone={timeZone}
                  canReach={holds(grants, 'inbox.use')}
                  onOpen={onOpen}
                />
              </View>
            </View>
          ) : null}
          {dropdown.exact ? (
            <View testID="search-exact">
              <GroupHeading label={W.exact} />
              {dropdown.exact.map(row)}
              {dropdown.groups.length ? <GroupHeading label={W.alsoHas(q)} /> : null}
            </View>
          ) : null}
          {dropdown.groups.map((d) => group(d.group, d.rows, d.more))}
          {dropdown.alsoFound.length ? (
            <Text className="px-4 pt-3 text-[13px] text-text-2" testID="search-also-found">
              {`${W.alsoFound} ${dropdown.alsoFound
                .map((a) => `${a.label} ${searchCount(a.total, a.capped)}`)
                .join(' · ')}`}
            </Text>
          ) : null}
          {dropdown.archived
            ? group(dropdown.archived, dropdown.archived.items, dropdown.archived.total)
            : null}
          {dropdown.bin ? group(dropdown.bin, dropdown.bin.items, 0) : null}
          {!full && dropdown.total > 0 && (dropdown.alsoFound.length > 0 || hasMore(dropdown)) ? (
            <Pressable
              role="button"
              onPress={onFull}
              className="mx-3 mt-3 min-h-11 items-center justify-center rounded-card border border-border bg-card active:bg-card-2"
              testID="search-see-all"
            >
              <Text className="text-[14px] font-medium text-accent-text">
                {W.seeAllResults(dropdown.total, dropdown.capped)}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

/** Whether the groups shown hold fewer than they found. */
function hasMore(d: NonNullable<ReturnType<typeof dropdownOf>>): boolean {
  return d.groups.some((g) => g.more > 0);
}

/** One kind: 25 at a time, Leads or Clients for contacts, and the banner when two share a number. */
function OneKind({
  typed,
  kind,
  label,
  onOpen,
}: {
  typed: string;
  kind: string;
  label: string;
  onOpen: () => void;
}) {
  const { business } = useBusiness();
  const grants = useGrants();
  const [standing, setStanding] = React.useState<'lead' | 'client' | null>(null);
  const settings = useSettingsGroup(kind === 'settings' ? typed.trim() : '');
  // Settings are found on the phone; every other kind is asked of HandsFreeOS, or the copy with no signal.
  const state = useOneKind(kind === 'settings' ? '' : typed, kind, standing);
  const timeZone = business.timezone || 'UTC';
  const group = kind === 'settings' ? settings : state.group;
  const now = React.useMemo(() => Date.now(), [group]);
  const q = kind === 'settings' ? typed.trim() : state.q;
  const pair = state.duplicates.find((d) => d.on === 'phone');
  // With no signal, a kind the phone doesn't keep wasn't searched at all: it says so, not that nothing matched.
  const waits =
    kind !== 'settings' &&
    state.offline &&
    !state.viewingOffline &&
    !searchedOffline(kind, grants.permissions ?? []);

  if (waits)
    return (
      <View className="gap-1 pt-1" testID={`search-kind-${kind}`}>
        <SearchNote testID="search-needs-signal">{W.needsSignal(label)}</SearchNote>
      </View>
    );

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-1 pb-8 pt-1"
      testID={`search-kind-${kind}`}
    >
      {kind === 'settings' ? null : <TopLines state={state} source={state.source} />}
      {kind === 'contacts' && state.standingCounts ? (
        <View className="flex-row gap-1.5 px-3 pb-1" testID="search-standing">
          <FilterChip
            label={W.standing.all}
            count={state.standingCounts.leads + state.standingCounts.clients}
            on={standing === null}
            onPress={() => setStanding(null)}
            testID="search-standing-all"
          />
          <FilterChip
            label={W.standing.leads}
            count={state.standingCounts.leads}
            on={standing === 'lead'}
            onPress={() => setStanding('lead')}
            testID="search-standing-lead"
          />
          <FilterChip
            label={W.standing.clients}
            count={state.standingCounts.clients}
            on={standing === 'client'}
            onPress={() => setStanding('client')}
            testID="search-standing-client"
          />
        </View>
      ) : null}
      {pair ? (
        <SearchNote
          action={
            holds(grants, 'records.archive')
              ? {
                  label: W.compare,
                  onPress: () =>
                    void openWeb(
                      searchHref(business.id, {
                        type: 'merge',
                        personId: pair.ids[0],
                        otherId: pair.ids[1],
                      }),
                    ),
                }
              : undefined
          }
          testID="search-duplicates"
        >
          {W.twoSharePhone(pair.name)}
        </SearchNote>
      ) : null}
      {group && group.items.length > 0 ? (
        <View testID={`search-group-${kind}`}>
          <GroupHeading label={label} />
          {group.items.map((hit) => (
            <View key={`${hit.kind}:${hit.id}`} className="border-t border-border">
              <SearchRow
                hit={hit}
                q={q}
                workspaceId={business.id}
                now={now}
                timeZone={timeZone}
                onOpen={onOpen}
              />
            </View>
          ))}
        </View>
      ) : !state.loading && !state.viewingOffline && !searchProbes(q).tooShort ? (
        <View className="items-center gap-1 px-6 py-10" testID="search-empty">
          <Text className="text-center text-[15px] font-semibold">{W.noMatches(q)}</Text>
          <Text className="text-center text-[13px] text-text-2">{W.noMatchesHelp}</Text>
        </View>
      ) : null}
      {kind !== 'settings' && state.more ? (
        <Pressable
          role="button"
          onPress={state.showMore}
          disabled={state.loadingMore}
          className="mx-3 mt-3 min-h-11 items-center justify-center rounded-card border border-border bg-card active:bg-card-2"
          testID="search-show-more"
        >
          <Text className="text-[14px] font-medium text-accent-text">
            {W.showMoreOf(KIND_PAGE)}
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
