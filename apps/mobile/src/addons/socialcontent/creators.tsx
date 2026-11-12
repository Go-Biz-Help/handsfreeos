import { CONTENT_NETWORK_INFO, networkName } from '@hfos/core/addons/socialcontent/networks';
import type { SetupStep } from '@hfos/core/addons/socialcontent/picking';
import type { Creator, Niche, Overview, Post } from '@hfos/core/addons/socialcontent/shapes';
import { DONE_WELL } from '@hfos/core/addons/socialcontent/standouts';
import { SOCIALCONTENT_WORDS as W, daysAgo } from '@hfos/core/addons/socialcontent/words';
import { router } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { change } from '@/changes';
import { Check, Sparkles, X } from '@/components/icons';
import { businessHref } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';
import { workerPost } from '@/lib/worker';

import { ActivityCard } from './activity';
import { SetupPart } from './setup';
import {
  Group,
  NeedsSignal,
  Note,
  openOutside,
  openSocialcontent,
  Part,
  useAct,
  useNow,
  useSocialcontentAnswer,
  useSocialcontentContext,
  type Act,
} from './kit';
import { OutsideLink, PostCard } from './post-card';

/**
 * Creators on the phone, as on the web (docs/socialcontent.md): how setting up on its own stands (./setup.tsx), what
 * the reading computer is doing, the niches
 * searched, adding a creator from a link, then the creators found, studied and skipped. Anyone on the team picks
 * niches and creators (one list for the whole business, decision 12): **Suggest niches** has the AI find the
 * business's own niche and ones like it, **Find creators now** asks the reading computer to search the ticked ones,
 * and a studied creator's posts open in a sheet, each with how many times the posts around it it did. It needs
 * signal, and asks again every half minute while it's open, for what the reading computer is doing.
 */

type Tab = 'suggested' | 'studying' | 'skipped';
const TABS: readonly Tab[] = ['suggested', 'studying', 'skipped'];

export interface CreatorsData {
  readonly overview: Overview;
  readonly niches: readonly Niche[];
  readonly creators: readonly Creator[];
}

/** What a press on Creators does: each runs through `act`, which says how it went. */
export interface CreatorsActions {
  findNow(): void;
  suggestNiches(): void;
  addNiche(name: string): Promise<boolean>;
  decideNiche(niche: Niche, state: 'picked' | 'skipped'): void;
  addCreator(link: string): Promise<boolean>;
  decideCreator(creator: Creator, study: boolean): void;
  readAgain(creator: Creator): void;
  posts(creator: Creator): Promise<readonly Post[] | null>;
  openSettings(): void;
  /** Where a step of setting up on its own is fixed: Settings, or the main offer and its lists for content. */
  openFix(fix: NonNullable<SetupStep['fix']>): void;
}

export function CreatorsScreen() {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const answer = useSocialcontentAnswer<CreatorsData>(
    async () => {
      const [overview, niches, creators] = await Promise.all([
        api.POST('/v1/queries/socialcontent.overview', { body: { workspaceId: ws } }).then(unwrap),
        api
          .POST('/v1/queries/socialcontent.niche.list', { body: { workspaceId: ws } })
          .then(unwrap),
        api
          .POST('/v1/queries/socialcontent.creator.list', { body: { workspaceId: ws } })
          .then(unwrap),
      ]);
      return { overview, niches: niches.niches, creators: creators.creators };
    },
    `socialcontent-creators:${ws}`,
    W.creators.title,
    { everySeconds: 30 },
  );
  const { busy, act } = useAct(answer.reload);
  const now = useNow();
  const actions = React.useMemo(() => creatorsActions(ws, act), [ws, act]);
  return (
    <CreatorsBody
      data={answer.data}
      error={answer.error}
      online={ctx.online}
      busy={busy}
      now={now}
      onRetry={answer.reload}
      actions={actions}
    />
  );
}

/** Each press, wired to its command or the worker's action. */
export function creatorsActions(ws: string, act: Act): CreatorsActions {
  return {
    findNow: () =>
      void act(
        'find',
        async () => (await change('socialcontent.find.now', { workspaceId: ws })).output,
        (out) => W.creators.finding(out.networks.map(networkName).join(', '), out.niches),
      ),
    suggestNiches: () =>
      void act(
        'suggest',
        () =>
          workerPost<{ added: number }>(
            '/v1/addons/socialcontent/actions/socialcontent.niches.suggest',
            { workspaceId: ws, input: {} },
          ),
        (out) => W.niches.suggested(out.added),
      ),
    addNiche: async (name) =>
      (await act(
        'add-niche',
        async () => (await change('socialcontent.niche.add', { workspaceId: ws, name })).output,
        (n) => W.niches.added(n.name),
      )) !== null,
    decideNiche: (niche, state) =>
      void act(
        `niche:${niche.id}`,
        async () =>
          (
            await change('socialcontent.niche.decide', {
              workspaceId: ws,
              nicheId: niche.id,
              state,
            })
          ).output,
      ),
    addCreator: async (link) =>
      (await act(
        'add-creator',
        async () => (await change('socialcontent.creator.add', { workspaceId: ws, link })).output,
        (c) => W.creators.added(c.shown),
      )) !== null,
    decideCreator: (creator, study) =>
      void act(
        `creator:${creator.id}`,
        async () =>
          (
            await change('socialcontent.creator.decide', {
              workspaceId: ws,
              creatorId: creator.id,
              study,
            })
          ).output,
      ),
    readAgain: (creator) =>
      void act(
        `read:${creator.id}`,
        async () =>
          (await change('socialcontent.read.now', { workspaceId: ws, creatorId: creator.id }))
            .output,
        () => W.creators.readingAgain(creator.shown),
      ),
    posts: async (creator) =>
      (
        await act(`posts:${creator.id}`, () =>
          api
            .POST('/v1/queries/socialcontent.post.list', {
              body: { workspaceId: ws, creatorId: creator.id, limit: 200 },
            })
            .then(unwrap),
        )
      )?.posts ?? null,
    openSettings: () => openSocialcontent(ws, 'settings'),
    openFix: (fix) =>
      fix === 'main-offer' || fix === 'main-offer-lists'
        ? router.push(
            businessHref(
              ws,
              fix === 'main-offer' ? 'settings/main-offer' : 'settings/main-offer-lists',
            ),
          )
        : openSocialcontent(ws, 'settings'),
  };
}

export function CreatorsBody({
  data,
  error,
  online,
  busy,
  now,
  onRetry,
  actions,
}: {
  data: CreatorsData | null;
  error: string | null;
  online: boolean;
  busy: string | null;
  now: number;
  onRetry: () => void;
  actions: CreatorsActions;
}) {
  const creators = data?.creators ?? [];
  const by = (s: Tab) => creators.filter((c) => c.state === s);
  const [tab, setTab] = React.useState<Tab | null>(null);
  // Suggested first while anyone waits to be ticked, as on the web; then whichever the person picked.
  const shownTab: Tab = tab ?? (by('suggested').length ? 'suggested' : 'studying');
  const shown = by(shownTab);
  const [postsOf, setPostsOf] = React.useState<Creator | null>(null);
  return (
    <Screen title={W.creators.title} leading="back" testID="socialcontent-creators">
      {data ? (
        <>
          <Note>{W.creators.intro}</Note>
          <Button
            loading={busy === 'find'}
            disabled={!online || (busy !== null && busy !== 'find')}
            onPress={actions.findNow}
            testID="socialcontent-find"
          >
            {W.creators.find}
          </Button>
          {!data.overview.settings.readerUserId ? (
            <Card
              className="gap-3 border-warning-soft bg-warning-soft/40 p-4"
              testID="socialcontent-needs-reader"
            >
              <Text className="text-[13.5px] leading-[19px]">{W.needsReader}</Text>
              {data.overview.mayManage ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  onPress={actions.openSettings}
                  testID="socialcontent-needs-reader-settings"
                >
                  {W.settings.title}
                </Button>
              ) : null}
            </Card>
          ) : null}
          <SetupPart
            setup={data.overview.setup}
            now={now}
            mayManage={data.overview.mayManage}
            onFix={actions.openFix}
          />
          <ActivityCard overview={data.overview} now={now} />
          <NichesPart niches={data.niches} online={online} busy={busy} actions={actions} />
          <AddCreator online={online} busy={busy} onAdd={actions.addCreator} onAdded={setTab} />
          <Segmented<Tab>
            value={shownTab}
            onChange={setTab}
            label={W.creators.title}
            options={TABS.map((t) => ({
              value: t,
              label: `${W.creators.tabs[t]} (${by(t).length})`,
              testID: `socialcontent-tab-${t}`,
            }))}
          />
          {shown.length === 0 ? (
            <Note testID="socialcontent-creators-empty">
              {shownTab === 'suggested'
                ? W.creators.noneSuggested
                : shownTab === 'studying'
                  ? W.creators.noneStudying
                  : W.creators.noneSkipped}
            </Note>
          ) : (
            shown.map((c) => (
              <CreatorCard
                key={c.id}
                creator={c}
                online={online}
                busy={busy}
                actions={actions}
                onPosts={() => setPostsOf(c)}
              />
            ))
          )}
          <PostsSheet creator={postsOf} onClose={() => setPostsOf(null)} load={actions.posts} />
        </>
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="socialcontent-creators-needs-signal" />
      ) : null}
    </Screen>
  );
}

function NichesPart({
  niches,
  online,
  busy,
  actions,
}: {
  niches: readonly Niche[];
  online: boolean;
  busy: string | null;
  actions: CreatorsActions;
}) {
  const [name, setName] = React.useState('');
  const own = niches.filter((n) => n.own);
  const similar = niches.filter((n) => !n.own);
  const add = async () => {
    if (await actions.addNiche(name.trim())) setName('');
  };
  const row = (n: Niche) => (
    <View key={n.id} className="gap-2 border-t border-border pt-2.5" testID="socialcontent-niche">
      <View className="flex-row items-start gap-2">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            className={cn(
              'text-[14px] font-medium',
              n.state === 'skipped' && 'text-text-3 line-through',
            )}
          >
            {n.name}
          </Text>
          {n.why ? <Text className="text-[12.5px] text-text-3">{n.why}</Text> : null}
        </View>
        {n.state === 'picked' ? (
          <Badge variant="ok">{W.niches.picked}</Badge>
        ) : n.state === 'skipped' ? (
          <Badge>{W.niches.skipped}</Badge>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {n.state !== 'picked' ? (
          <Button
            size="sm"
            variant="secondary"
            icon={Check}
            loading={busy === `niche:${n.id}`}
            disabled={!online}
            onPress={() => actions.decideNiche(n, 'picked')}
            testID="socialcontent-niche-pick"
          >
            {W.niches.pick}
          </Button>
        ) : null}
        {n.state !== 'skipped' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={X}
            disabled={!online || busy === `niche:${n.id}`}
            onPress={() => actions.decideNiche(n, 'skipped')}
            testID="socialcontent-niche-skip"
          >
            {W.niches.skip}
          </Button>
        ) : null}
      </View>
    </View>
  );
  return (
    <Part
      title={W.niches.title}
      about={W.niches.intro}
      side={
        <Button
          size="sm"
          variant="ghost"
          icon={Sparkles}
          loading={busy === 'suggest'}
          disabled={!online}
          onPress={actions.suggestNiches}
          testID="socialcontent-suggest-niches"
        >
          {busy === 'suggest' ? W.niches.suggesting : W.niches.suggest}
        </Button>
      }
      testID="socialcontent-niches"
    >
      {niches.length === 0 ? <Note>{W.niches.none}</Note> : null}
      {own.length ? (
        <View className="gap-2.5">
          <Group>{W.niches.own}</Group>
          {own.map(row)}
        </View>
      ) : null}
      {similar.length ? (
        <View className="gap-2.5">
          <Group>{W.niches.similar}</Group>
          {similar.map(row)}
        </View>
      ) : null}
      <View className="gap-2">
        <Input
          value={name}
          onChangeText={setName}
          placeholder={W.niches.addPlaceholder}
          accessibilityLabel={W.niches.add}
          maxLength={80}
          returnKeyType="done"
          onSubmitEditing={() => (name.trim() && online ? void add() : undefined)}
          testID="socialcontent-add-niche"
        />
        <Button
          variant="secondary"
          loading={busy === 'add-niche'}
          disabled={!online || !name.trim()}
          onPress={() => void add()}
          testID="socialcontent-add-niche-go"
        >
          {W.niches.add}
        </Button>
      </View>
    </Part>
  );
}

function AddCreator({
  online,
  busy,
  onAdd,
  onAdded,
}: {
  online: boolean;
  busy: string | null;
  onAdd: (link: string) => Promise<boolean>;
  onAdded: (tab: Tab) => void;
}) {
  const [link, setLink] = React.useState('');
  const add = async () => {
    if (!(await onAdd(link.trim()))) return;
    setLink('');
    onAdded('studying');
  };
  return (
    <Part title={W.creators.add} testID="socialcontent-add-creator">
      <Input
        value={link}
        onChangeText={setLink}
        placeholder={W.creators.addPlaceholder}
        accessibilityLabel={W.creators.addPlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        onSubmitEditing={() => (link.trim() && online ? void add() : undefined)}
        testID="socialcontent-add-link"
      />
      <Button
        variant="secondary"
        loading={busy === 'add-creator'}
        disabled={!online || !link.trim()}
        onPress={() => void add()}
        testID="socialcontent-add-link-go"
      >
        {W.creators.add}
      </Button>
    </Part>
  );
}

function CreatorCard({
  creator: c,
  online,
  busy,
  actions,
  onPosts,
}: {
  creator: Creator;
  online: boolean;
  busy: string | null;
  actions: CreatorsActions;
  onPosts: () => void;
}) {
  const facts = [
    networkName(c.network),
    c.followers !== null ? W.creators.followers(c.followers) : null,
    c.lastPostAt ? W.creators.posted(daysAgo(c.lastPostAt) ?? '') : null,
    c.nicheName,
  ].filter(Boolean);
  const read =
    c.state !== 'studying'
      ? null
      : c.postsReadAt
        ? `${W.creators.postsRead(c.postsCount)} · ${W.creators.standouts(c.standoutsCount)} · ${W.creators.readWhen(daysAgo(c.postsReadAt) ?? '')}`
        : W.creators.notRead;
  const deciding = busy === `creator:${c.id}`;
  return (
    <Card className="gap-2.5 p-4" testID={`socialcontent-creator-${c.handle}`}>
      <View className="gap-1">
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Pressable onPress={() => openOutside(c.link)} accessibilityRole="link">
            <Text className="text-[14.5px] font-semibold">{c.name ?? c.shown}</Text>
          </Pressable>
          {c.name ? <Text className="text-[13px] text-text-3">{c.shown}</Text> : null}
          {c.reading ? <Badge variant="pending">{W.creators.reading}</Badge> : null}
          {c.pickedBy === 'ai' && c.state === 'studying' ? (
            <Badge variant="accent">{W.creators.byAi}</Badge>
          ) : null}
        </View>
        <Text className="text-[12.5px] text-text-3">{facts.join(' · ')}</Text>
        {(c.state === 'suggested' || (c.state === 'skipped' && c.pickedBy === 'ai')) && c.why ? (
          <Text className="text-[13px] leading-[18px] text-text-2">{c.why}</Text>
        ) : null}
        {c.match !== null && c.state !== 'didnt_fit' ? (
          <Text
            className="text-[13px] leading-[18px] text-text-2"
            testID="socialcontent-creator-match"
          >
            {W.creators.match(c.match, c.matchWhy)}
            {c.engagement !== null ? ` · ${W.creators.engagement(c.engagement)}` : ''}
          </Text>
        ) : null}
        {read ? (
          <Text className="text-[13px] text-text-2" testID="socialcontent-creator-read">
            {read}
          </Text>
        ) : null}
        {c.foundBy === 'person' &&
        c.followers !== null &&
        c.followers < DONE_WELL.followersAtLeast ? (
          <Text className="text-[12.5px] text-text-3">{W.creators.smaller}</Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {c.state === 'suggested' ? (
          <>
            <Button
              size="sm"
              loading={deciding}
              disabled={!online}
              onPress={() => actions.decideCreator(c, true)}
              testID="socialcontent-creator-study"
            >
              {W.creators.study}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!online || deciding}
              onPress={() => actions.decideCreator(c, false)}
              testID="socialcontent-creator-skip"
            >
              {W.creators.skip}
            </Button>
          </>
        ) : c.state === 'studying' ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={!online}
              onPress={onPosts}
              testID="socialcontent-creator-posts"
            >
              {W.creators.seePosts}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === `read:${c.id}`}
              disabled={!online || c.reading || !CONTENT_NETWORK_INFO[c.network].ready}
              onPress={() => actions.readAgain(c)}
              testID="socialcontent-creator-read-again"
            >
              {W.creators.readAgain}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!online || deciding}
              onPress={() => actions.decideCreator(c, false)}
              testID="socialcontent-creator-stop"
            >
              {W.creators.stop}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={deciding}
            disabled={!online}
            onPress={() => actions.decideCreator(c, true)}
            testID="socialcontent-creator-study-again"
          >
            {W.creators.studyAgain}
          </Button>
        )}
      </View>
    </Card>
  );
}

/** How many of a creator's posts the sheet shows at a time: Show more posts adds as many again. */
const POSTS_AT_A_TIME = 30;

/** A studied creator's posts, newest first, each with how many times the posts around it it did. */
function PostsSheet({
  creator,
  onClose,
  load,
}: {
  creator: Creator | null;
  onClose: () => void;
  load: (creator: Creator) => Promise<readonly Post[] | null>;
}) {
  const [posts, setPosts] = React.useState<readonly Post[] | null>(null);
  const [showing, setShowing] = React.useState(POSTS_AT_A_TIME);
  React.useEffect(() => {
    if (!creator) return;
    let gone = false;
    setPosts(null);
    setShowing(POSTS_AT_A_TIME);
    void load(creator).then((got) => {
      if (!gone) setPosts(got ?? []);
    });
    return () => {
      gone = true;
    };
  }, [creator, load]);
  return (
    <Sheet
      open={creator !== null}
      onClose={onClose}
      title={creator ? `${W.creators.posts.title}: ${creator.name ?? creator.shown}` : ''}
      scroll
      testID="socialcontent-posts-sheet"
    >
      <View className="mt-3 gap-2.5">
        {creator ? (
          <OutsideLink
            words={W.phone.openProfile}
            onPress={() => openOutside(creator.link)}
            testID="socialcontent-posts-profile"
          />
        ) : null}
        {posts === null ? (
          <Note>{W.phone.loading}</Note>
        ) : posts.length === 0 ? (
          <Note testID="socialcontent-posts-none">{W.creators.posts.none}</Note>
        ) : (
          <>
            {posts.slice(0, showing).map((p) => (
              <PostCard key={p.id} post={p} showCreator={false} />
            ))}
            {posts.length > showing ? (
              <Button
                variant="secondary"
                onPress={() => setShowing((n) => n + POSTS_AT_A_TIME)}
                testID="socialcontent-posts-more"
              >
                {W.phone.morePosts}
              </Button>
            ) : null}
          </>
        )}
      </View>
    </Sheet>
  );
}
