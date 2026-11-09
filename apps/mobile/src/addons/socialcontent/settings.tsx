import {
  CONTENT_NETWORK_INFO,
  CONTENT_NETWORKS,
  networkName,
  type ContentNetwork,
} from '@hfos/core/addons/socialcontent/networks';
import type { Overview, Work } from '@hfos/core/addons/socialcontent/shapes';
import { SOCIALCONTENT_WORDS as W, daysAgo } from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { View } from 'react-native';

import { change } from '@/changes';
import { Screen } from '@/components/shell/screen';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { WorkFacts } from './activity';
import {
  NeedsSignal,
  Note,
  Part,
  useAct,
  useSocialcontentAnswer,
  useSocialcontentContext,
  workWhat,
  type Act,
} from './kit';

/**
 * Settings on the phone, as on the web (docs/socialcontent.md, decisions 2, 9, 11 and 12): the networks studied, whose
 * computer reads them, whether the AI watches standout videos (off until someone turns it on, after the notice that
 * it uses a lot more AI, with a way to try it on a few videos first), when it reads on its own, and what that
 * computer was asked to do lately. Owners and admins (`socialcontent.manage`) change the first three; anyone who uses
 * the add-on can stop work that hasn't finished. The extension itself goes on a computer, so the phone says where to
 * get it rather than offering the download. It needs signal.
 */

const STATE_BADGE: Record<Work['state'], NonNullable<BadgeProps['variant']>> = {
  waiting: 'gray',
  taken: 'pending',
  done: 'ok',
  failed: 'danger',
  stopped: 'gray',
};

/** What a press on Settings does: each runs through `act`, which says how it went. */
export interface SettingsActions {
  setNetwork(network: ContentNetwork, on: boolean): void;
  readOnMine(): void;
  stopReading(): void;
  watch(on: boolean): void;
  tryWatching(): void;
  stop(work: Work): void;
}

export function SettingsScreen() {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const answer = useSocialcontentAnswer<Overview>(
    async () =>
      unwrap(await api.POST('/v1/queries/socialcontent.overview', { body: { workspaceId: ws } })),
    `socialcontent-settings:${ws}`,
    W.settings.title,
    { everySeconds: 30 },
  );
  const { busy, act } = useAct(answer.reload);
  const networks = answer.data?.settings.networks;
  const actions = React.useMemo(
    () => settingsActions(ws, ctx.userId, networks ?? [], act),
    [ws, ctx.userId, networks, act],
  );
  return (
    <SettingsBody
      overview={answer.data}
      error={answer.error}
      online={ctx.online}
      busy={busy}
      onRetry={answer.reload}
      actions={actions}
    />
  );
}

/** Each press, wired to its command. */
export function settingsActions(
  ws: string,
  me: string,
  networks: readonly ContentNetwork[],
  act: Act,
): SettingsActions {
  const save = (
    key: string,
    body: { networks?: ContentNetwork[]; readerUserId?: string | null; watchVideos?: boolean },
    done: string = W.settings.saved,
  ) =>
    void act(
      key,
      async () =>
        (await change('socialcontent.settings.save', { workspaceId: ws, ...body })).output,
      done,
    );
  return {
    setNetwork: (n, on) => {
      const next = on ? [...networks, n] : networks.filter((x) => x !== n);
      if (next.length) save(`network:${n}`, { networks: next });
    },
    readOnMine: () => save('reader', { readerUserId: me }),
    stopReading: () => save('reader-off', { readerUserId: null }),
    watch: (on) => save('watch', { watchVideos: on }, W.settings.watchSaved(on)),
    tryWatching: () =>
      void act(
        'try',
        async () => (await change('socialcontent.watch.try', { workspaceId: ws })).output,
        (out) => W.watch.asked(out.asked),
      ),
    stop: (w) =>
      void act(
        `stop:${w.id}`,
        async () =>
          (await change('socialcontent.work.stop', { workspaceId: ws, workId: w.id })).output,
        W.settings.stopped,
      ),
  };
}

export function SettingsBody({
  overview,
  error,
  online,
  busy,
  onRetry,
  actions,
}: {
  overview: Overview | null;
  error: string | null;
  online: boolean;
  busy: string | null;
  onRetry: () => void;
  actions: SettingsActions;
}) {
  // Watching is turned on only after the notice again: it uses a lot more AI.
  const [asking, setAsking] = React.useState(false);
  if (!overview)
    return (
      <Screen title={W.settings.title} leading="back" testID="socialcontent-settings">
        {error ? (
          <NeedsSignal
            words={error}
            onRetry={onRetry}
            testID="socialcontent-settings-needs-signal"
          />
        ) : null}
      </Screen>
    );
  const { settings, mayManage } = overview;
  const reader = overview.readerIsMe
    ? W.settings.readerMine
    : settings.readerUserId
      ? W.settings.readerIs(settings.readerName)
      : W.settings.readerNone;
  const managersOnly = mayManage ? null : <Note>{W.settings.managersOnly}</Note>;
  return (
    <Screen title={W.settings.title} leading="back" testID="socialcontent-settings">
      <Part title={W.settings.networks} about={W.settings.networksIntro}>
        {CONTENT_NETWORKS.map((n) => {
          const ready = CONTENT_NETWORK_INFO[n].ready;
          const on = settings.networks.includes(n);
          return (
            <View key={n} className="flex-row items-center gap-3">
              <Text className={cn('flex-1 text-[14.5px]', !ready && 'text-text-3')}>
                {networkName(n)}
              </Text>
              {!ready ? <Badge>{W.settings.coming}</Badge> : null}
              <Switch
                label={networkName(n)}
                checked={on}
                disabled={
                  !online ||
                  !ready ||
                  !mayManage ||
                  busy !== null ||
                  (on && settings.networks.length === 1)
                }
                onCheckedChange={(next) => actions.setNetwork(n, next)}
                testID={`socialcontent-network-${n}`}
              />
            </View>
          );
        })}
        {managersOnly}
      </Part>

      <Part title={W.settings.reader} about={W.settings.readerIntro}>
        <Text className="text-[14px] font-medium" testID="socialcontent-reader">
          {reader}
        </Text>
        {mayManage ? (
          <View className="flex-row flex-wrap gap-2">
            {!overview.readerIsMe ? (
              <Button
                size="sm"
                loading={busy === 'reader'}
                disabled={!online}
                onPress={actions.readOnMine}
                testID="socialcontent-read-on-mine"
              >
                {W.settings.readOnMine}
              </Button>
            ) : null}
            {settings.readerUserId ? (
              <Button
                size="sm"
                variant="ghost"
                loading={busy === 'reader-off'}
                disabled={!online}
                onPress={actions.stopReading}
                testID="socialcontent-reader-stop"
              >
                {W.settings.readerStop}
              </Button>
            ) : null}
          </View>
        ) : null}
        <Text className="text-[12.5px] leading-[17px] text-text-3">{W.settings.extensionHow}</Text>
        <Text className="text-[12.5px] leading-[17px] text-text-3">
          {W.phone.extensionOnComputer}
        </Text>
        {managersOnly}
      </Part>

      <Part
        title={W.watch.title}
        about={W.watch.intro}
        side={
          <Switch
            label={W.watch.on}
            checked={settings.watchVideos}
            disabled={!online || !mayManage || (busy !== null && busy !== 'watch')}
            onCheckedChange={(on) => (on ? setAsking(true) : actions.watch(false))}
            testID="socialcontent-watch-on"
          />
        }
        testID="socialcontent-watch"
      >
        <View className="rounded-card bg-warning-soft p-3">
          <Text className="text-[13px] leading-[19px] text-warning-text">{W.watch.cost}</Text>
        </View>
        {mayManage ? (
          <View className="gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              loading={busy === 'try'}
              disabled={!online || (busy !== null && busy !== 'try')}
              onPress={actions.tryWatching}
              testID="socialcontent-watch-try"
            >
              {W.watch.tryIt}
            </Button>
            <Note>{W.watch.tryHint}</Note>
          </View>
        ) : (
          managersOnly
        )}
      </Part>

      <Card className="p-4">
        <Note>{W.settings.schedule}</Note>
      </Card>

      <Part
        title={W.settings.doing}
        about={W.settings.waiting(overview.counts.waiting)}
        testID="socialcontent-work"
      >
        {overview.work.length === 0 ? (
          <Note>{W.settings.noWork}</Note>
        ) : (
          overview.work.map((w) => (
            <WorkRow
              key={w.id}
              work={w}
              online={online}
              stopping={busy === `stop:${w.id}`}
              onStop={() => actions.stop(w)}
            />
          ))
        )}
      </Part>

      <Sheet
        open={asking}
        onClose={() => setAsking(false)}
        title={W.phone.watchAsk}
        description={W.watch.cost}
        testID="socialcontent-watch-sheet"
      >
        <View className="mt-4 gap-2">
          <Button
            onPress={() => {
              setAsking(false);
              actions.watch(true);
            }}
            testID="socialcontent-watch-yes"
          >
            {W.phone.watchYes}
          </Button>
          <Button
            variant="ghost"
            onPress={() => setAsking(false)}
            testID="socialcontent-watch-keep"
          >
            {W.phone.watchKeep}
          </Button>
        </View>
      </Sheet>
    </Screen>
  );
}

function WorkRow({
  work: w,
  online,
  stopping,
  onStop,
}: {
  work: Work;
  online: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  // Its progress says it better, where it has one.
  const done =
    w.state === 'done' && w.doneCount !== null && !w.progress
      ? w.kind === 'find'
        ? W.work.found(w.doneCount)
        : w.kind === 'posts'
          ? W.work.read(w.doneCount)
          : null
      : null;
  const facts = [
    W.work.askedFor[w.askedFor],
    daysAgo(w.finishedAt ?? w.takenAt ?? w.createdAt),
    done,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View className="gap-1.5 border-t border-border pt-2.5" testID={`socialcontent-work-${w.id}`}>
      <View className="flex-row items-start gap-2">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[13.5px] leading-[19px]">{workWhat(w)}</Text>
          <Text className="text-[12.5px] text-text-3">{facts}</Text>
        </View>
        <Badge variant={STATE_BADGE[w.state]}>{W.work.states[w.state]}</Badge>
      </View>
      <WorkFacts work={w} />
      {w.state === 'failed' && w.failure ? (
        <Text className="text-[12.5px] text-danger-text">{w.failure}</Text>
      ) : null}
      {w.state === 'waiting' || w.state === 'taken' ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          loading={stopping}
          disabled={!online}
          onPress={onStop}
          testID="socialcontent-work-stop"
        >
          {W.settings.stop}
        </Button>
      ) : null}
    </View>
  );
}
