import {
  ASK_WORDS,
  ASK_WORDS_MOST,
  latestAsk,
  type AsksOutput,
} from '@hfos/core/addons/outreach/asks';
import {
  GROUP_CHECK_STATES,
  GROUP_CHECK_WORDS,
  JOIN_STATES,
  prospectsWords,
} from '@hfos/core/addons/outreach/group-checks';
import {
  GROUP_VERDICTS,
  GROUP_VIEWS,
  type GroupsOutput,
  type GroupView,
} from '@hfos/core/addons/outreach/groups';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { ExternalLink } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';

import { OutreachFrame, OutreachWorkspace } from './frame';
import {
  AskButton,
  AskLine,
  ComputerNote,
  useAskActions,
  useAsks,
  useDoneReload,
  type AskActions,
} from './asks';
import {
  NeedsSignal,
  Note,
  openOutreach,
  openOutside,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';

/**
 * Groups on the phone (decision 44): the groups the extension saved, by its verdict (Work these, Maybe, Skip, all),
 * why, and how they've done, searched by name, with Show more for the next page. Each opens its own page of who was
 * found there (./group-page.tsx, decision 103), and on Facebook. From
 * Facebook asks the person's computer to save their groups, find groups by words, save members and find posts, as the
 * web's buttons do (decision 43, ./asks.tsx); a group's own **Save its members** too. It needs signal.
 */

const VIEW_KEYS = Object.keys(GROUP_VIEWS) as GroupView[];
export const groupViewOf = (show: string | undefined): GroupView =>
  VIEW_KEYS.find((k) => k === show) ?? 'work';

export function GroupsScreen({ show, q }: { show?: string; q?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [view, setView] = React.useState<GroupView>(groupViewOf(show));
  const [search, setSearch] = React.useState(q ?? '');
  const [asked, setAsked] = React.useState(q ?? '');
  const [pages, setPages] = React.useState(1);
  React.useEffect(() => {
    const t = setTimeout(() => setAsked(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);
  React.useEffect(() => setPages(1), [view, asked]);
  const answer = useOutreachAnswer(
    async () => {
      const all: GroupsOutput[] = [];
      for (let page = 1; page <= pages; page++)
        all.push(
          unwrap(
            await api.POST('/v1/queries/outreach.groups', {
              body: { workspaceId: ws, view, page, ...(asked ? { search: asked } : {}) },
            }),
          ),
        );
      const last = all[all.length - 1]!;
      return { ...last, groups: all.flatMap((a) => a.groups) };
    },
    `groups:${ws}:${view}:${asked}:${pages}`,
    W.rows.groups,
  );
  const asks = useAsks('groups', W.rows.groups);
  const actions = useAskActions(asks.data, asks.reload);
  // The groups an ask saved show once it's done.
  useDoneReload(asks.data, answer.reload);
  return (
    <GroupsBody
      view={view}
      onView={setView}
      search={search}
      onSearch={setSearch}
      groups={answer.data}
      error={answer.error}
      onRetry={answer.reload}
      onMore={() => setPages((p) => p + 1)}
      asks={asks.data}
      actions={actions}
    />
  );
}

export function GroupsBody({
  view,
  onView,
  search,
  onSearch,
  groups,
  error,
  onRetry,
  onMore,
  asks = null,
  actions,
}: {
  view: GroupView;
  onView: (v: GroupView) => void;
  search: string;
  onSearch: (s: string) => void;
  groups: GroupsOutput | null;
  error: string | null;
  onRetry: () => void;
  onMore: () => void;
  /** What the person asked their computer here, with signal; the buttons show once it's known. */
  asks?: AsksOutput | null;
  actions?: AskActions;
}) {
  const workspaceId = React.useContext(OutreachWorkspace);
  const empty = search.trim() ? W.groupsNoMatch : W.groupsEmpty[view];
  return (
    <OutreachFrame page="find" testID="outreach-groups">
      {groups ? (
        <Card className="gap-1.5 px-4 py-3.5" testID="groups-prospects">
          <Text className="text-[15px] font-semibold">{GROUP_CHECK_WORDS.prospectsTitle}</Text>
          <Note>{prospectsWords(groups.prospects, groups.joinsOnItsOwn)}</Note>
        </Card>
      ) : null}
      {asks && actions ? <GroupAsks asks={asks} actions={actions} /> : null}
      <Segmented
        value={view}
        onChange={onView}
        label={W.rows.groups}
        options={VIEW_KEYS.map((k) => ({
          value: k,
          label: groups && k !== 'all' ? `${GROUP_VIEWS[k]} ${groups.counts[k]}` : GROUP_VIEWS[k],
          testID: `groups-view-${k}`,
        }))}
      />
      <Input
        value={search}
        onChangeText={onSearch}
        placeholder={W.search}
        autoCorrect={false}
        testID="groups-search"
      />
      {groups ? (
        groups.groups.length ? (
          <>
            {groups.groups.map((g) => (
              <Card key={g.groupId} className="gap-1.5 px-4 py-3.5" testID="groups-item">
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="text-[15px] font-semibold">{g.name ?? g.url}</Text>
                  <Badge
                    variant={
                      g.verdict === 'work' ? 'ok' : g.verdict === 'maybe' ? 'pending' : 'gray'
                    }
                  >
                    <Text>{GROUP_VERDICTS[g.verdict]}</Text>
                  </Badge>
                </View>
                {W.groupLine(g.members, g.people, g.joined) ? (
                  <Note>{W.groupLine(g.members, g.people, g.joined)}</Note>
                ) : null}
                {g.check && g.check.state !== 'waiting' ? (
                  <Text className="text-[14px] leading-[20px]" testID="groups-check">
                    {[GROUP_CHECK_STATES[g.check.state], g.check.who].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                {g.reasons.length ? <Note>{g.reasons.join(' · ')}</Note> : null}
                {g.playbookName ? <Note>{g.playbookName}</Note> : null}
                {g.left ? <Note>{W.leftToReach(g.left)}</Note> : null}
                {g.join ? <Note testID="groups-join">{JOIN_STATES[g.join.state]}</Note> : null}
                {/* Its own page: who was found there and how each turned out (decision 103). */}
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  onPress={() => openOutreach(workspaceId, 'groups', `group=${g.groupId}`)}
                  testID="groups-open"
                >
                  See who was found
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={ExternalLink}
                  className="self-start"
                  onPress={() => openOutside(g.url)}
                >
                  {W.openOnFacebook}
                </Button>
                {asks && actions ? (
                  <AskButton
                    asks={asks}
                    actions={actions}
                    ask={{ kind: 'members', groupIds: [g.groupId] }}
                    label={ASK_WORDS.saveItsMembers}
                    variant="ghost"
                    testID="ask-group-members"
                  />
                ) : null}
                {asks &&
                actions &&
                g.joined !== true &&
                g.verdict !== 'skip' &&
                (!g.join || g.join.state === 'failed') ? (
                  <AskButton
                    asks={asks}
                    actions={actions}
                    ask={{ kind: 'join', groupIds: [g.groupId] }}
                    label={GROUP_CHECK_WORDS.joinOne}
                    variant="ghost"
                    testID="ask-group-join"
                  />
                ) : null}
              </Card>
            ))}
            {groups.page < groups.pages ? (
              <Button variant="secondary" onPress={onMore} testID="groups-more">
                {W.more}
              </Button>
            ) : null}
          </>
        ) : (
          <Card className="gap-1.5 px-5 py-6" testID="groups-empty">
            <Text className="text-[16px] font-semibold">{empty.title}</Text>
            <Note>{empty.body}</Note>
          </Card>
        )
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="groups-needs-signal" />
      ) : null}
    </OutreachFrame>
  );
}

/** From Facebook: what the person can ask their computer to do for this screen. */
function GroupAsks({ asks, actions }: { asks: AsksOutput; actions: AskActions }) {
  const [words, setWords] = React.useState('');
  const lastSearch = latestAsk(asks, 'group_search');
  return (
    <Card className="gap-3 px-4 py-3.5" testID="groups-asks">
      <View className="gap-0.5">
        <Text className="text-[15px] font-semibold">{ASK_WORDS.fromFacebook}</Text>
        <Note>{ASK_WORDS.fromFacebookNote}</Note>
      </View>
      <ComputerNote asks={asks} />
      <AskButton
        asks={asks}
        actions={actions}
        ask={{ kind: 'groups' }}
        label={ASK_WORDS.saveGroups}
        testID="ask-groups"
      />
      <View className="gap-1.5">
        <Input
          value={words}
          onChangeText={setWords}
          placeholder={ASK_WORDS.searchFor}
          maxLength={ASK_WORDS_MOST}
          testID="ask-group-search-words"
        />
        <AskButton
          asks={asks}
          actions={actions}
          ask={{ kind: 'group_search', words: words.trim() }}
          label={ASK_WORDS.findGroups}
          disabled={words.trim().length < 2}
          showLine={false}
          testID="ask-group-search"
        />
        {lastSearch ? <AskLine asks={asks} ask={lastSearch} actions={actions} /> : null}
      </View>
      <AskButton
        asks={asks}
        actions={actions}
        ask={{ kind: 'members' }}
        label={ASK_WORDS.saveMembers}
        testID="ask-members"
      />
      <AskButton
        asks={asks}
        actions={actions}
        ask={{ kind: 'posts' }}
        label={ASK_WORDS.findPosts}
        testID="ask-posts"
      />
      <AskButton
        asks={asks}
        actions={actions}
        ask={{ kind: 'group_checks' }}
        label={GROUP_CHECK_WORDS.checkButton}
        testID="ask-group-checks"
      />
      <Note>{GROUP_CHECK_WORDS.checkNote}</Note>
      <AskButton
        asks={asks}
        actions={actions}
        ask={{ kind: 'join' }}
        label={GROUP_CHECK_WORDS.joinButton}
        testID="ask-join"
      />
      <Note>{GROUP_CHECK_WORDS.joinNote}</Note>
    </Card>
  );
}
