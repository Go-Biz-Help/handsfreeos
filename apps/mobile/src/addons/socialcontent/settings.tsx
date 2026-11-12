import {
  CONTENT_NETWORK_INFO,
  CONTENT_NETWORKS,
  networkName,
  type ContentNetwork,
} from '@hfos/core/addons/socialcontent/networks';
import {
  CALENDAR,
  PLAN_MODES,
  POSTING_NETWORKS,
  type NetworkPlan,
  type PostingNetwork,
} from '@hfos/core/addons/socialcontent/calendar';
import type { LearnedShown } from '@hfos/core/addons/socialcontent/schedule';
import type { Overview, Work } from '@hfos/core/addons/socialcontent/shapes';
import {
  SOCIALCONTENT_WORDS as W,
  clockShown,
  daysAgo,
  learnedLine,
} from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { change } from '@/changes';
import { Screen } from '@/components/shell/screen';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
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
 * computer was asked to do lately; and Posting (decisions 21 to 27): Fill on its own, and each network's plan, AI picks
 * (how many a week, the most a day, the hours, and what it learned) or I pick (the times on each weekday). Owners and
 * admins (`socialcontent.manage`) change all but the work; anyone who uses the add-on can stop work that hasn't
 * finished. The extension itself goes on a computer, so the phone says where to get it rather than offering the
 * download. It needs signal.
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
  /** Only what changes on one network's plan: the server keeps (and checks) the rest. */
  setPlan(network: PostingNetwork, change: Partial<NetworkPlan>): void;
  autoFill(on: boolean): void;
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
    body: {
      networks?: ContentNetwork[];
      readerUserId?: string | null;
      watchVideos?: boolean;
      plan?: Partial<Record<PostingNetwork, Partial<NetworkPlan>>>;
      autoFill?: boolean;
    },
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
    setPlan: (n, plan) => save(`plan:${n}`, { plan: { [n]: plan } }),
    autoFill: (on) =>
      save('autoFill', { autoFill: on }, on ? W.calendar.fillStarted : W.calendar.fillStopped),
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

      <Part
        title={W.settings.posting}
        about={W.settings.postingIntro}
        testID="socialcontent-posting"
      >
        <View className="flex-row items-center gap-3">
          <View className="flex-1 gap-0.5">
            <Text className="text-[14.5px] font-medium">{W.calendar.autoFill}</Text>
            <Note>{W.calendar.autoFillHint}</Note>
          </View>
          <Switch
            label={W.calendar.autoFill}
            checked={settings.autoFill}
            disabled={!online || !mayManage || (busy !== null && busy !== 'autoFill')}
            onCheckedChange={actions.autoFill}
            testID="socialcontent-auto-fill"
          />
        </View>
        {POSTING_NETWORKS.map((n) => (
          <PlanBlock
            key={n}
            network={n}
            plan={settings.plan[n]}
            learned={overview.learned?.[n]}
            off={!online || !mayManage || busy !== null}
            onChange={(c) => actions.setPlan(n, c)}
          />
        ))}
        {managersOnly}
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

/** Every half hour of the day, as a post's time is picked on its screen. */
const HALF_HOURS = Array.from(
  { length: 48 },
  (_, k) => `${String(Math.floor(k / 2)).padStart(2, '0')}:${k % 2 ? '30' : '00'}`,
);
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

function Chips({ children }: { children: React.ReactNode }) {
  return <View className="flex-row flex-wrap gap-1.5">{children}</View>;
}

/** A row of chips to scroll sideways, starting near the one picked. */
function ChipRow({ children, startAt = 0 }: { children: React.ReactNode; startAt?: number }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-1.5"
      contentOffset={{ x: Math.max(0, startAt - 1) * 76, y: 0 }}
    >
      {children}
    </ScrollView>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <Text className="text-[13px] font-medium text-text-2">{children}</Text>;
}

/**
 * One network's plan on the phone, as on the web (decisions 21, 22 and 24): AI picks, with how many a week, the most a
 * day, the hours it posts between and what it learned; or I pick, with up to 3 times on each weekday.
 */
export function PlanBlock({
  network,
  plan,
  learned,
  off,
  onChange,
}: {
  network: PostingNetwork;
  plan: NetworkPlan;
  learned: LearnedShown | undefined;
  off: boolean;
  onChange: (change: Partial<NetworkPlan>) => void;
}) {
  const S = W.settings;
  const name = networkName(network);
  // The weekday whose new time is being picked, in a sheet.
  const [adding, setAdding] = React.useState<number | null>(null);
  const setDay = (d: number, times: readonly string[]) =>
    onChange({ week: plan.week.map((t, k) => (k === d ? [...times].sort() : t)) });
  const setPerWeek = (perWeek: number) =>
    onChange(
      plan.perDay !== null && perWeek > 7 * plan.perDay
        ? { perWeek, perDay: Math.ceil(perWeek / 7) }
        : { perWeek },
    );
  const tid = `socialcontent-plan-${network}`;
  return (
    <View className="gap-2.5 border-t border-border pt-3" testID={tid}>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="flex-1 text-[14.5px] font-semibold">{name}</Text>
        {PLAN_MODES.map((m) => (
          <FilterChip
            key={m}
            label={S.modes[m]}
            on={plan.mode === m}
            disabled={off}
            accessibilityLabel={`${S.modeFor(name)}: ${S.modes[m]}`}
            onPress={() => {
              if (plan.mode !== m) onChange({ mode: m });
            }}
            testID={`${tid}-${m}`}
          />
        ))}
      </View>
      <Note>{S.modeHints[plan.mode]}</Note>
      {plan.mode === 'ai' ? (
        <>
          <Label>{S.perWeek(name)}</Label>
          <ChipRow startAt={plan.perWeek}>
            {Array.from({ length: CALENDAR.perWeekMost + 1 }, (_, k) => (
              <FilterChip
                key={k}
                label={S.perWeekOption(k)}
                on={plan.perWeek === k}
                disabled={off}
                onPress={() => setPerWeek(k)}
                testID={`${tid}-per-week-${k}`}
              />
            ))}
          </ChipRow>
          {plan.perWeek > 0 ? (
            <>
              <Label>{S.perDay(name)}</Label>
              <Chips>
                {[null, ...Array.from({ length: CALENDAR.perDayMost }, (_, k) => k + 1)]
                  .filter((k) => plan.perWeek <= 7 * (k ?? CALENDAR.perDayMost))
                  .map((k) => (
                    <FilterChip
                      key={k ?? 'any'}
                      label={S.perDayOption(k)}
                      on={plan.perDay === k}
                      disabled={off}
                      onPress={() => onChange({ perDay: k })}
                      testID={`${tid}-per-day-${k ?? 'any'}`}
                    />
                  ))}
              </Chips>
              <Label>{S.fromFor(name)}</Label>
              <ChipRow startAt={Number(plan.from.slice(0, 2))}>
                {HOURS.filter((h) => h < plan.to).map((h) => (
                  <FilterChip
                    key={h}
                    label={clockShown(h)}
                    on={plan.from === h}
                    disabled={off}
                    onPress={() => onChange({ from: h })}
                    testID={`${tid}-from-${h}`}
                  />
                ))}
              </ChipRow>
              <Label>{S.toFor(name)}</Label>
              <ChipRow startAt={Number(plan.to.slice(0, 2)) - 4}>
                {HOURS.filter((h) => h > plan.from).map((h) => (
                  <FilterChip
                    key={h}
                    label={clockShown(h)}
                    on={plan.to === h}
                    disabled={off}
                    onPress={() => onChange({ to: h })}
                    testID={`${tid}-to-${h}`}
                  />
                ))}
              </ChipRow>
              {learned ? (
                <Note testID={`socialcontent-learned-${network}`}>
                  {learnedLine(learned, plan.time)}
                </Note>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <View className="gap-2">
          {S.days.map((day, d) => {
            const times = plan.week[d] ?? [];
            return (
              <View key={day} className="flex-row flex-wrap items-center gap-1.5">
                <Text className="w-10 text-[13.5px] text-text-2">{day}</Text>
                {times.length === 0 ? (
                  <Text className="text-[13px] text-text-3">{S.noTimes}</Text>
                ) : null}
                {times.map((t) => (
                  <FilterChip
                    key={t}
                    label={`${clockShown(t)} ×`}
                    on
                    disabled={off}
                    accessibilityLabel={S.removeTime(day, clockShown(t))}
                    onPress={() =>
                      setDay(
                        d,
                        times.filter((x) => x !== t),
                      )
                    }
                    testID={`${tid}-${d}-${t}`}
                  />
                ))}
                {times.length < CALENDAR.perDayMost ? (
                  <FilterChip
                    label={`+ ${S.addTime}`}
                    on={false}
                    disabled={off}
                    accessibilityLabel={S.addTimeFor(day)}
                    onPress={() => setAdding(d)}
                    testID={`${tid}-${d}-add`}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      )}
      <Sheet
        open={adding !== null}
        onClose={() => setAdding(null)}
        title={adding === null ? S.addTime : S.addTimeFor(S.days[adding])}
        testID={`${tid}-add-sheet`}
      >
        <View className="mt-3 flex-row flex-wrap gap-1.5">
          {HALF_HOURS.filter((h) => adding === null || !(plan.week[adding] ?? []).includes(h)).map(
            (h) => (
              <FilterChip
                key={h}
                label={clockShown(h)}
                on={false}
                onPress={() => {
                  const d = adding;
                  setAdding(null);
                  if (d !== null) setDay(d, [...(plan.week[d] ?? []), h]);
                }}
                testID={`${tid}-add-${h}`}
              />
            ),
          )}
        </View>
      </Sheet>
    </View>
  );
}
