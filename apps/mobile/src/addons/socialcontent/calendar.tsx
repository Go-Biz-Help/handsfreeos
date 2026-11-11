import { addDays, localDateOf } from '@hfos/core';
import { POSTING_NETWORKS, type PostingNetwork } from '@hfos/core/addons/socialcontent/calendar';
import type { CalendarView, Content } from '@hfos/core/addons/socialcontent/content-shapes';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import {
  SOCIALCONTENT_WORDS as W,
  dayShown,
  filledLine,
  numbersLines,
  planShown,
  postingLines,
  timeShown,
} from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { change } from '@/changes';
import { CalendarCheck, CalendarPlus, PenLine } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';
import { workerPost } from '@/lib/worker';

import {
  NeedsSignal,
  Note,
  openSocialcontent,
  useAct,
  useNow,
  useSocialcontentAnswer,
  useSocialcontentContext,
} from './kit';
import { PostPictureTile, STATE_BADGE } from './own-post';

/**
 * The Calendar on the phone, as on the web (docs/socialcontent.md, "Making posts" and part 12): the business's own
 * posts for today and the next two weeks, each day's posts and open days, posts with no day yet, and what went up
 * lately with how each did. **Fill the calendar** has the AI write posts for the open days, **OK the week** OKs every
 * post ready in the next 7 days, and **Write a post** (or **Write one** on an open day) writes one. **Fill on its own**
 * stops the AI filling it, or starts it again (the owner, 11 Nov). Opening a post shows it on its own screen, at the
 * web's own address (`calendar?post=<id>`). It needs signal.
 */

const WRITE = '/v1/addons/socialcontent/actions/socialcontent.content.write';
const FILL = '/v1/addons/socialcontent/actions/socialcontent.calendar.fill';

const networkNameOf = (n: string) => networkName(n as PostingNetwork);

export function CalendarScreen() {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const answer = useSocialcontentAnswer<CalendarView>(
    async () =>
      unwrap(
        await api.POST('/v1/queries/socialcontent.calendar.get', { body: { workspaceId: ws } }),
      ),
    `socialcontent-calendar:${ws}`,
    W.calendar.title,
    // Posts the AI is writing, and pictures it's making, show as they're done.
    { everySeconds: 20 },
  );
  const { busy, act } = useAct(answer.reload);
  const now = useNow();
  const open = (postId: string) => openSocialcontent(ws, 'calendar', `post=${postId}`);
  return (
    <CalendarBody
      data={answer.data}
      error={answer.error}
      online={ctx.online}
      busy={busy}
      now={now}
      onRetry={answer.reload}
      onOpen={open}
      onFill={() =>
        void act(
          'fill',
          () => workerPost<{ open: number }>(FILL, { workspaceId: ws, input: {} }),
          (out) => (out.open ? W.calendar.fillAsked : W.calendar.fillNothing),
        )
      }
      onAutoFill={(on) =>
        void act(
          'autoFill',
          async () =>
            (await change('socialcontent.settings.save', { workspaceId: ws, autoFill: on })).output,
          on ? W.calendar.fillStarted : W.calendar.fillStopped,
        )
      }
      onOkWeek={() =>
        void act(
          'week',
          async () =>
            (await change('socialcontent.content.approve_week', { workspaceId: ws })).output,
          (out) => W.calendar.approvedWeek(out?.approved ?? 0, out?.notReady.length ?? 0),
        )
      }
      onWrite={(network, postAt, key) =>
        void act(
          key,
          () =>
            workerPost<{ postId: string }>(WRITE, {
              workspaceId: ws,
              input: { ...(network ? { network } : {}), ...(postAt ? { postAt } : {}) },
            }),
          W.calendar.written,
        ).then((out) => {
          if (out?.postId) open(out.postId);
        })
      }
    />
  );
}

export function CalendarBody({
  data: c,
  error,
  online,
  busy,
  now,
  onRetry,
  onOpen,
  onFill,
  onAutoFill,
  onOkWeek,
  onWrite,
}: {
  data: CalendarView | null;
  error: string | null;
  online: boolean;
  busy: string | null;
  now: number;
  onRetry: () => void;
  onOpen: (postId: string) => void;
  onFill: () => void;
  onAutoFill: (on: boolean) => void;
  onOkWeek: () => void;
  onWrite: (network: PostingNetwork | null, postAt: string | null, key: string) => void;
}) {
  const other = (key: string) => !online || (busy !== null && busy !== key);
  if (!c)
    return (
      <Screen title={W.calendar.title} leading="back" testID="socialcontent-calendar">
        <Note>{W.calendar.intro}</Note>
        {error ? (
          <NeedsSignal
            words={error}
            onRetry={onRetry}
            testID="socialcontent-calendar-needs-signal"
          />
        ) : null}
      </Screen>
    );

  const days = Array.from({ length: c.days }, (_, i) => addDays(c.from, i));
  const byDay = new Map<string, Content[]>();
  for (const p of c.posts) {
    if (!p.postAt) continue;
    const day = localDateOf(Date.parse(p.postAt), c.timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), p]);
  }
  const openByDay = new Map<string, CalendarView['open']>();
  for (const o of c.open) openByDay.set(o.date, [...(openByDay.get(o.date) ?? []), o]);
  const drafts = c.posts.filter((p) => p.state === 'draft').length;
  const row = (p: Content) => (
    <PostRow key={p.id} post={p} timeZone={c.timeZone} onOpen={() => onOpen(p.id)} />
  );

  return (
    <Screen title={W.calendar.title} leading="back" testID="socialcontent-calendar">
      <Note>{W.calendar.intro}</Note>
      <View className="gap-2">
        {c.autoFill ? (
          <Button
            icon={CalendarPlus}
            loading={busy === 'fill'}
            disabled={other('fill')}
            onPress={onFill}
            testID="socialcontent-calendar-fill"
          >
            {busy === 'fill' ? W.calendar.filling : W.calendar.fill}
          </Button>
        ) : null}
        <View className="flex-row gap-2">
          {drafts ? (
            <Button
              className="flex-1"
              variant="secondary"
              icon={CalendarCheck}
              loading={busy === 'week'}
              disabled={other('week')}
              onPress={onOkWeek}
              testID="socialcontent-calendar-ok-week"
            >
              {W.calendar.approveWeek}
            </Button>
          ) : null}
          <Button
            className="flex-1"
            variant="secondary"
            icon={PenLine}
            loading={busy === 'write'}
            disabled={other('write')}
            onPress={() => onWrite(null, null, 'write')}
            testID="socialcontent-calendar-write"
          >
            {busy === 'write' ? W.calendar.writing : W.calendar.write}
          </Button>
        </View>
      </View>

      <Card className="gap-2 p-4">
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 text-[14.5px] font-medium">{W.calendar.autoFill}</Text>
          <Switch
            label={W.calendar.autoFill}
            checked={c.autoFill}
            disabled={!c.mayManage || other('autoFill')}
            onCheckedChange={onAutoFill}
            testID="socialcontent-calendar-auto-fill"
          />
        </View>
        <Text
          className="text-[13.5px] leading-[19px] text-text-2"
          testID="socialcontent-calendar-filled"
        >
          {filledLine(c, now)}
          {!c.autoFill && !c.mayManage ? ` ${W.calendar.fillOffWho}` : null}
        </Text>
        <Text className="text-[12.5px] leading-[17px] text-text-3">
          {planShown(c.plan, POSTING_NETWORKS, networkNameOf)}
        </Text>
        {postingLines(c, networkNameOf, now).map((l) => (
          <Text
            key={l.text}
            className={cn(
              'text-[12.5px] leading-[17px]',
              l.warn ? 'text-warning-text' : 'text-text-3',
            )}
            testID="socialcontent-calendar-posting"
          >
            {l.text}
          </Text>
        ))}
      </Card>

      {!c.posts.length && !c.undated.length && !c.open.length ? (
        <Note testID="socialcontent-calendar-empty">{W.calendar.empty}</Note>
      ) : null}

      {days.map((day) => {
        const posts = byDay.get(day) ?? [];
        const free = openByDay.get(day) ?? [];
        if (!posts.length && !free.length) return null;
        return (
          <View key={day} className="gap-2" testID={`socialcontent-day-${day}`}>
            <Text variant="group">{dayShown(day, c.today)}</Text>
            {posts.map(row)}
            {free.map((o) => {
              const key = `open:${o.network}:${o.date}`;
              return (
                <View
                  key={key}
                  className="flex-row items-center gap-3 rounded-card border border-dashed border-border-strong px-3.5 py-3"
                  testID={`socialcontent-open-${o.network}-${o.date}`}
                >
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text className="text-[12.5px] text-text-3">{W.calendar.open}</Text>
                    <Text className="text-[13.5px] text-text-2">
                      {W.calendar.openHint(networkName(o.network), timeShown(o.at, c.timeZone))}
                    </Text>
                  </View>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === key}
                    disabled={other(key)}
                    onPress={() => onWrite(o.network, o.at, key)}
                    testID={`socialcontent-open-write-${o.network}-${o.date}`}
                  >
                    {W.calendar.writeFor}
                  </Button>
                </View>
              );
            })}
          </View>
        );
      })}

      {c.undated.length ? (
        <View className="gap-2" testID="socialcontent-undated">
          <Text variant="group">{W.calendar.undated}</Text>
          {c.undated.map(row)}
        </View>
      ) : null}

      {c.recent.length ? (
        <View className="gap-2" testID="socialcontent-recent">
          <Text variant="group">{W.calendar.recent}</Text>
          {c.recent.map(row)}
        </View>
      ) : null}
    </Screen>
  );
}

/** One post on the Calendar: its picture, network, time, format and state, title and first line. */
function PostRow({
  post: p,
  timeZone,
  onOpen,
}: {
  post: Content;
  timeZone: string;
  onOpen: () => void;
}) {
  const first = p.pictures[0];
  // A post that went up: its latest numbers, or that it did well, in one line.
  const numbers = numbersLines(p, networkNameOf).at(-1);
  const making = p.pictureState === 'waiting' || p.pictureState === 'making';
  return (
    <Pressable
      role="button"
      onPress={onOpen}
      className={cn(
        'flex-row items-start gap-3 rounded-card border border-border bg-card p-3',
        p.state === 'skipped' && 'opacity-60',
      )}
      accessibilityLabel={p.title}
      testID={`socialcontent-post-${p.id}`}
    >
      <View className="h-[60px] w-12 overflow-hidden rounded-md bg-card-2">
        {first ? <PostPictureTile picture={first} /> : null}
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text className="text-[12.5px] text-text-3">
            {[
              networkName(p.network),
              p.postAt ? timeShown(p.postAt, timeZone) : null,
              W.post.formats[p.format],
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Badge variant={STATE_BADGE[p.state]}>{W.post.states[p.state]}</Badge>
        </View>
        <Text className="text-[14.5px] font-semibold" numberOfLines={1}>
          {p.title}
        </Text>
        <Text className="text-[13px] leading-[18px] text-text-2" numberOfLines={2}>
          {p.hook ?? p.words.split('\n')[0]}
        </Text>
        {making ? (
          <Text className="text-[12.5px] text-text-3">{W.post.pictureStates.making}</Text>
        ) : null}
        {p.state === 'draft' && p.stillNeeds ? (
          <Text className="text-[12.5px] leading-[17px] text-warning-text">{p.stillNeeds}</Text>
        ) : null}
        {numbers ? (
          <Text
            className={cn(
              'text-[12.5px] leading-[17px]',
              numbers.well ? 'text-success-text' : 'text-text-3',
            )}
            testID={`socialcontent-post-${p.id}-numbers`}
          >
            {numbers.text}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
