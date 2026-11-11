import { networkName } from '@hfos/core/addons/socialcontent/networks';
import type { Idea, StandoutRef } from '@hfos/core/addons/socialcontent/shapes';
import { SOCIALCONTENT_WORDS as W, daysAgo } from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { View } from 'react-native';

import { change } from '@/changes';
import { Lightbulb } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { workerPost } from '@/lib/worker';

import {
  NeedsSignal,
  Note,
  OfferNotLive,
  useAct,
  useSocialcontentAnswer,
  useSocialcontentContext,
} from './kit';
import { StandoutLinks } from './post-card';

/**
 * Ideas on the phone, as on the web (docs/socialcontent.md, part 3): posts the AI suggests the business makes, from the
 * Playbook and what HandsFreeOS knows about the business, each with its hook, format, network, an outline, why it
 * should work and the standouts it's based on. **Get ideas** asks for more. Anyone on the team saves one, marks it
 * used once posted, or skips it, and can put it back to new. It needs signal.
 */

type State = Idea['state'];
const STATES: readonly State[] = ['new', 'saved', 'used', 'skipped'];
const NONE: Record<State, string> = {
  new: W.ideas.noneNew,
  saved: W.ideas.noneSaved,
  used: W.ideas.noneUsed,
  skipped: W.ideas.noneSkipped,
};

export interface IdeasData {
  readonly ideas: readonly Idea[];
  readonly examples: readonly StandoutRef[];
  readonly hasPlaybook: boolean;
  /** Until the main offer is live, the AI writes no ideas (pick 7b); an older API doesn't say, and means live. */
  readonly offerLive?: boolean;
}

export function IdeasScreen() {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const answer = useSocialcontentAnswer<IdeasData>(
    async () => {
      const [found, book] = await Promise.all([
        api.POST('/v1/queries/socialcontent.idea.list', { body: { workspaceId: ws } }).then(unwrap),
        api
          .POST('/v1/queries/socialcontent.playbook.get', { body: { workspaceId: ws } })
          .then(unwrap),
      ]);
      return {
        ideas: found.ideas,
        examples: found.examples,
        hasPlaybook: book.playbook.writtenAt !== null,
        offerLive: found.offerLive !== false,
      };
    },
    `socialcontent-ideas:${ws}`,
    W.ideas.title,
  );
  const { busy, act } = useAct(answer.reload);
  return (
    <IdeasBody
      data={answer.data}
      error={answer.error}
      online={ctx.online}
      busy={busy}
      onRetry={answer.reload}
      onGet={() =>
        void act(
          'get',
          () =>
            workerPost<{ added: number }>(
              '/v1/addons/socialcontent/actions/socialcontent.ideas.suggest',
              { workspaceId: ws, input: {} },
            ),
          (out) => W.ideas.got(out.added),
        )
      }
      onDecide={(idea, state) =>
        void act(
          `${idea.id}:${state}`,
          async () =>
            (await change('socialcontent.idea.decide', { workspaceId: ws, ideaId: idea.id, state }))
              .output,
          W.ideas.decided,
        )
      }
    />
  );
}

export function IdeasBody({
  data,
  error,
  online,
  busy,
  onRetry,
  onGet,
  onDecide,
}: {
  data: IdeasData | null;
  error: string | null;
  online: boolean;
  busy: string | null;
  onRetry: () => void;
  onGet: () => void;
  onDecide: (idea: Idea, state: State) => void;
}) {
  const ideas = data?.ideas ?? [];
  const countOf = (s: State) => ideas.filter((i) => i.state === s).length;
  const [tab, setTab] = React.useState<State | null>(null);
  // New first while there are any, or while nothing's saved; Saved otherwise, as on the web.
  const shownTab: State = tab ?? (countOf('new') || !countOf('saved') ? 'new' : 'saved');
  const shown = ideas.filter((i) => i.state === shownTab);
  const byId = React.useMemo(
    () => new Map((data?.examples ?? []).map((e) => [e.id, e])),
    [data?.examples],
  );
  return (
    <Screen title={W.ideas.title} leading="back" testID="socialcontent-ideas">
      <Note>{W.ideas.intro}</Note>
      {data?.offerLive === false ? <OfferNotLive /> : null}
      {data ? (
        <>
          {data.hasPlaybook && data.offerLive !== false ? (
            <Button
              icon={Lightbulb}
              loading={busy === 'get'}
              disabled={!online || (busy !== null && busy !== 'get')}
              onPress={onGet}
              testID="socialcontent-ideas-get"
            >
              {busy === 'get' ? W.ideas.getting : W.ideas.get}
            </Button>
          ) : null}
          {!ideas.length ? (
            <Note testID="socialcontent-ideas-none">
              {data.hasPlaybook ? W.ideas.none : W.ideas.needsPlaybook}
            </Note>
          ) : (
            <>
              <Segmented<State>
                value={shownTab}
                onChange={setTab}
                label={W.ideas.title}
                options={STATES.map((s) => ({
                  value: s,
                  label: `${W.ideas.tabs[s]} (${countOf(s)})`,
                  testID: `socialcontent-ideas-tab-${s}`,
                }))}
              />
              {shown.length === 0 ? (
                <Note testID="socialcontent-ideas-empty">{NONE[shownTab]}</Note>
              ) : (
                shown.map((i) => (
                  <IdeaCard
                    key={i.id}
                    idea={i}
                    examples={byId}
                    online={online}
                    busy={busy}
                    onDecide={(state) => onDecide(i, state)}
                  />
                ))
              )}
            </>
          )}
        </>
      ) : error ? (
        <NeedsSignal words={error} onRetry={onRetry} testID="socialcontent-ideas-needs-signal" />
      ) : null}
    </Screen>
  );
}

function IdeaCard({
  idea: i,
  examples,
  online,
  busy,
  onDecide,
}: {
  idea: Idea;
  examples: ReadonlyMap<string, StandoutRef>;
  online: boolean;
  busy: string | null;
  onDecide: (state: State) => void;
}) {
  const button = (state: State, label: string, variant: 'primary' | 'secondary' | 'ghost') => (
    <Button
      size="sm"
      variant={variant}
      loading={busy === `${i.id}:${state}`}
      disabled={!online || (busy !== null && busy !== `${i.id}:${state}`)}
      onPress={() => onDecide(state)}
      testID={`socialcontent-idea-${state}`}
    >
      {label}
    </Button>
  );
  const facts = [i.network ? networkName(i.network) : null, daysAgo(i.createdAt)].filter(Boolean);
  return (
    <Card className="gap-2 p-4" testID={`socialcontent-idea-${i.id}`}>
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <Text className="text-[12.5px] text-text-3">{facts.join(' · ')}</Text>
        {i.format ? <Badge>{i.format}</Badge> : null}
      </View>
      <Text className="text-[15px] font-semibold leading-[20px]">{i.title}</Text>
      {i.hook ? (
        <Text className="text-[13.5px] leading-[19px]">
          <Text className="text-text-3">{W.ideas.hook}: </Text>“{i.hook}”
        </Text>
      ) : null}
      {i.outline ? (
        <View className="gap-0.5">
          <Text className="text-[12.5px] text-text-3">{W.ideas.outline}</Text>
          <Text className="text-[13.5px] leading-[19px]">{i.outline}</Text>
        </View>
      ) : null}
      {i.why ? (
        <Text className="text-[13px] leading-[18px] text-text-2">
          <Text className="text-text-3">{W.ideas.why}: </Text>
          {i.why}
        </Text>
      ) : null}
      <StandoutLinks
        label={W.ideas.basedOn(i.basedOn.length)}
        ids={i.basedOn}
        examples={examples}
      />
      <View className="flex-row flex-wrap gap-2 pt-1">
        {i.state === 'new' ? (
          <>
            {button('saved', W.ideas.save, 'primary')}
            {button('used', W.ideas.use, 'secondary')}
            {button('skipped', W.ideas.skip, 'ghost')}
          </>
        ) : i.state === 'saved' ? (
          <>
            {button('used', W.ideas.use, 'primary')}
            {button('skipped', W.ideas.skip, 'ghost')}
          </>
        ) : (
          button('new', W.ideas.again, 'ghost')
        )}
      </View>
    </Card>
  );
}
