import { addDays, fmtDateShort, holds, localDateOf } from '@hfos/core';
import {
  CALENDAR,
  POSTING_NETWORKS,
  firstPlannedNetwork,
  type PostingNetwork,
} from '@hfos/core/addons/socialcontent/calendar';
import {
  CALENDAR_LOOKS,
  SHOW_FILTERS,
  filterCounts,
  inTurns,
  isCalendarLook,
  lookRange,
  monthMoved,
  monthName,
  monthOf,
  monthShown,
  shows,
  weekShown,
  weekShownShort,
  type CalendarLook,
  type PickWhich,
  type ShowFilter,
} from '@hfos/core/addons/socialcontent/calendar-looks';
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
import { Pressable, ScrollView, View } from 'react-native';

import { change } from '@/changes';
import {
  CalendarCheck,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  PenLine,
  SquareCheck,
} from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { deviceStore } from '@/lib/device-store';
import { useGrants } from '@/lib/grants';
import { cn } from '@/lib/utils';
import { workerPost } from '@/lib/worker';

import {
  CompactRow,
  DidntPost,
  MonthDots,
  PickBar,
  PickSheet,
  Tick,
  WeekStrip,
  itemOf,
  placedOf,
  type PickAct,
  type PickItem,
  type Sent,
} from './calendar-picking';
import {
  NeedsSignal,
  Note,
  OfferNotLive,
  openSocialcontent,
  useAct,
  useNow,
  useSocialcontentAnswer,
  useSocialcontentContext,
} from './kit';
import { PostPictureTile, STATE_BADGE } from './own-post';

/**
 * The Calendar on the phone, as on the web (docs/socialcontent.md, "Making posts", "Picking many posts" and part 12):
 * the business's own posts. It looks like a **List** of today and the next two weeks (each day's posts and open days,
 * posts with no day yet, and what went up or didn't lately with how each did), a **Week** from Monday (a strip of its
 * days, then each day's posts) or a **Month** (each day with a dot for each post; a day opens its week), and keeps the
 * look picked on this phone (the owner, 15 Nov; the design they OK'd). The filters show everything or one kind, with
 * Hidden holding hidden posts. **Fill the calendar** has the AI write posts for the open days, **OK the week** OKs
 * every post ready in the next 7 days, and **Write a post** (or **Write one** on an open day) writes one, asking two
 * things first in a sheet (the owner, 14 Nov). **Fill on its own** stops the AI filling it, or starts it again (the
 * owner, 11 Nov). **Select** picks many posts (one, a day, a week, a kind, or any date from Pick), and the bar at the
 * foot OKs, redoes, checks or hides them, with More for Mark posted, Show again and Delete. A post that didn't post
 * has Try again, Check if it posted and Mark as posted. Opening a post shows it on its own screen, at the web's own
 * address (`calendar?post=<id>`). It needs signal.
 */

const WRITE = '/v1/addons/socialcontent/actions/socialcontent.content.write';
const FILL = '/v1/addons/socialcontent/actions/socialcontent.calendar.fill';
/** The look picked last, kept on this phone. */
const LOOK_KEY = 'socialcontent.calendar.look';

const networkNameOf = (n: string) => networkName(n as PostingNetwork);

/** The words after each of the bar's presses. */
const doneWords: Record<PickAct, (done: number, left: number) => string> = {
  ok: W.picking.approved,
  redo: W.calendar.redone,
  look: W.picking.lookAsked,
  mark: W.picking.marked,
  hide: (n) => W.picking.hidden(n),
  show: (n) => W.picking.shown(n),
  remove: W.picking.removed,
};

export function CalendarScreen() {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const [look, setLook] = React.useState<CalendarLook>(() => {
    const kept = deviceStore.get<string>(LOOK_KEY);
    return isCalendarLook(kept) ? kept : 'list';
  });
  // A day in the week or month shown; the one with today in it when null.
  const [day, setDay] = React.useState<string | null>(null);
  const get = async (range?: { from?: string; days: number }) =>
    unwrap(
      await api.POST('/v1/queries/socialcontent.calendar.get', {
        body: { workspaceId: ws, ...range },
      }),
    );
  const answer = useSocialcontentAnswer<CalendarView>(
    async () => {
      if (look === 'list') return get();
      if (day) return get(lookRange(look, day, day));
      // Today in the business's time zone first.
      const first = await get({ days: 1 });
      return get(lookRange(look, first.today, first.today));
    },
    `socialcontent-calendar:${ws}:${look}:${day ?? ''}`,
    W.calendar.title,
    // Posts the AI is writing, and pictures it's making, show as they're done.
    { everySeconds: 20 },
  );
  // Moving to another week keeps the one shown until the next one comes.
  const last = React.useRef<{ look: CalendarLook; data: CalendarView } | null>(null);
  if (answer.data) last.current = { look, data: answer.data };
  const data = answer.data ?? (last.current?.look === look ? last.current.data : null);
  const { busy, act } = useAct(answer.reload);
  const now = useNow();
  // Deleting a post is archiving its record: owners and admins (records.archive).
  const canRemove = holds(useGrants(), 'records.archive');
  const open = (postId: string) => openSocialcontent(ws, 'calendar', `post=${postId}`);

  const sendTurn = async (
    kind: PickAct,
    postIds: string[],
    link: string | null,
  ): Promise<{ done: number; left: number }> => {
    const body = { workspaceId: ws, postIds };
    switch (kind) {
      case 'ok': {
        const o = (await change('socialcontent.content.approve_many', body)).output;
        return { done: o?.approved ?? 0, left: o?.notApproved.length ?? 0 };
      }
      case 'redo': {
        const o = (await change('socialcontent.content.redo', body)).output;
        return { done: o?.redone ?? 0, left: o?.notRedone.length ?? 0 };
      }
      case 'look': {
        const o = (await change('socialcontent.content.look', body)).output;
        return { done: o?.asked ?? 0, left: o?.notAsked.length ?? 0 };
      }
      case 'mark': {
        const o = (
          await change('socialcontent.content.mark_posted', {
            ...body,
            link: postIds.length === 1 ? link : null,
          })
        ).output;
        return { done: o?.marked ?? 0, left: o?.notMarked.length ?? 0 };
      }
      case 'hide':
      case 'show': {
        const o = (await change('socialcontent.content.hide', { ...body, hide: kind === 'hide' }))
          .output;
        return { done: o?.changed ?? 0, left: o?.notChanged.length ?? 0 };
      }
      case 'remove': {
        const o = (await change('socialcontent.content.remove_many', body)).output;
        return { done: o?.removed ?? 0, left: o?.notRemoved.length ?? 0 };
      }
    }
  };
  // Picked posts go 500 at a time, so any number can be picked.
  const send = (
    kind: PickAct,
    ids: readonly string[],
    link: string | null = null,
    key: string = kind,
  ) =>
    act(
      key,
      async () => {
        let done = 0;
        let left = 0;
        for (const part of inTurns(ids)) {
          const o = await sendTurn(kind, part, link);
          done += o.done;
          left += o.left;
        }
        return { done, left };
      },
      (o) => doneWords[kind](o.done, o.left),
    );

  return (
    <CalendarBody
      data={data}
      error={answer.error}
      online={ctx.online}
      busy={busy}
      now={now}
      look={look}
      day={day}
      canRemove={canRemove}
      onGo={(l, d) => {
        deviceStore.set(LOOK_KEY, l);
        setLook(l);
        setDay(l === 'list' ? null : d);
      }}
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
      onWriteFor={(networks, ask) =>
        act(
          'write',
          () =>
            workerPost<{ postId: string; postIds?: string[]; missed?: PostingNetwork[] }>(WRITE, {
              workspaceId: ws,
              input: { networks, ...(ask ? { ask } : {}) },
            }),
          (out) =>
            networks.length > 1
              ? W.calendar.writtenMany(
                  out.postIds?.length ?? 1,
                  (out.missed ?? []).map(networkName),
                )
              : W.calendar.written,
        ).then((out) => {
          // One post opens; several show on their days.
          if (out?.postId && networks.length === 1) open(out.postId);
          return out;
        })
      }
      onAct={(kind, ids, link) => send(kind, ids, link ?? null)}
      onAsk={async (which, range) => {
        try {
          const out = unwrap(
            await api.POST('/v1/queries/socialcontent.content.pick', {
              body: { workspaceId: ws, which, ...range },
            }),
          );
          if (out.more) toast.show(W.picking.menu.more(out.posts.length));
          else if (!out.posts.length) toast.show(W.picking.nothingShown);
          return out.posts.map(itemOf);
        } catch (e) {
          toast.error(errorMessage(e));
          return null;
        }
      }}
      onTryAgain={(postId) =>
        void act(
          `again:${postId}`,
          async () =>
            (await change('socialcontent.content.post_now', { workspaceId: ws, postId })).output,
          W.post.postNowAsked,
        )
      }
      onLookOne={(postId) => void send('look', [postId], null, `look:${postId}`)}
      onMarkOne={(postId, link) => send('mark', [postId], link, `mark:${postId}`)}
    />
  );
}

export function CalendarBody({
  data: c,
  error,
  online,
  busy,
  now,
  look,
  day,
  canRemove,
  onGo,
  onRetry,
  onOpen,
  onFill,
  onAutoFill,
  onOkWeek,
  onWrite,
  onWriteFor,
  onAct,
  onAsk,
  onTryAgain,
  onLookOne,
  onMarkOne,
}: {
  data: CalendarView | null;
  error: string | null;
  online: boolean;
  busy: string | null;
  now: number;
  look: CalendarLook;
  /** A day in the week or month shown; null for the one with today in it. */
  day: string | null;
  /** Owners and admins delete posts (records.archive). */
  canRemove: boolean;
  /** Moves to a look, and a day in its week or month (null: today's). */
  onGo: (look: CalendarLook, day: string | null) => void;
  onRetry: () => void;
  onOpen: (postId: string) => void;
  onFill: () => void;
  onAutoFill: (on: boolean) => void;
  onOkWeek: () => void;
  onWrite: (network: PostingNetwork | null, postAt: string | null, key: string) => void;
  /**
   * Write a post: one for each network, about the same thing, from what the person said or the AI on its own. What
   * it gives back, when anything, is what was written (null when it was refused).
   */
  onWriteFor: (networks: readonly PostingNetwork[], ask: string | null) => unknown;
  /** The bar's presses on the picked posts (the owner, 15 Nov). What it gives back is null when refused. */
  onAct: (kind: PickAct, ids: readonly string[], link?: string | null) => Promise<Sent>;
  /** The Pick sheet's picks across days not on the screen, or any date. */
  onAsk: (
    which: PickWhich,
    range?: { from: string; days: number },
  ) => Promise<readonly PickItem[] | null>;
  /** A post that didn't post: Try again, Check if it posted, Mark as posted. */
  onTryAgain: (postId: string) => void;
  onLookOne: (postId: string) => void;
  onMarkOne: (postId: string, link: string | null) => unknown;
}) {
  // Write a post's two questions are up (the owner, 14 Nov).
  const [asking, setAsking] = React.useState(false);
  // Picking many posts, and which kind of post shows (the owner, 15 Nov).
  const [selecting, setSelecting] = React.useState(false);
  const [filter, setFilter] = React.useState<ShowFilter>('all');
  const [picking, setPicking] = React.useState(false);
  const [picked, setPicked] = React.useState<ReadonlyMap<string, PickItem>>(new Map());
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

  const pick = (list: readonly PickItem[], on: boolean) =>
    setPicked((was) => {
      const next = new Map(was);
      for (const p of list) {
        if (on) next.set(p.id, p);
        else next.delete(p.id);
      }
      return next;
    });
  const pickPosts = (posts: readonly Content[], on: boolean) => pick(posts.map(itemOf), on);
  const isPicked = (id: string) => picked.has(id);
  const clear = () => setPicked(new Map());
  const stopSelecting = () => {
    setSelecting(false);
    clear();
  };
  const all = [...c.posts, ...c.undated, ...c.recent];
  const byId = new Map(all.map((p) => [p.id, p]));
  // What's picked, as it stands now (one may have gone up since it was picked).
  const items = [...picked.values()].map((p) => {
    const nowIs = byId.get(p.id);
    return nowIs ? itemOf(nowIs) : p;
  });

  const end = addDays(c.from, c.days);
  const month = monthOf(day ?? c.today);
  const anchor = c.today >= c.from && c.today < end ? c.today : look === 'month' ? month : c.from;
  const title =
    look === 'week'
      ? weekShown(c.from)
      : look === 'month'
        ? monthShown(month)
        : W.picking.listTitle;
  const rangeLabel =
    look === 'week'
      ? weekShownShort(c.from)
      : look === 'month'
        ? monthName(month)
        : W.picking.listRange;

  const shown = (p: Content) => shows(p, filter);
  const counts = filterCounts(look === 'list' ? all : c.posts);
  const days = Array.from({ length: c.days }, (_, i) => addDays(c.from, i));
  const byDay = new Map<string, Content[]>();
  for (const p of c.posts) {
    if (!p.postAt || !shown(p)) continue;
    const d = localDateOf(Date.parse(p.postAt), c.timeZone);
    byDay.set(d, [...(byDay.get(d) ?? []), p]);
  }
  // Open places show with everything, not under one kind.
  const openByDay = new Map<string, CalendarView['open']>();
  if (filter === 'all')
    for (const o of c.open) openByDay.set(o.date, [...(openByDay.get(o.date) ?? []), o]);
  const undated = c.undated.filter(shown);
  const recent = c.recent.filter(shown);
  const drafts = c.posts.filter((p) => p.state === 'draft').length;

  const dayTick = (d: string, posts: readonly Content[]) => {
    const n = posts.filter((p) => isPicked(p.id)).length;
    return (
      <View className="flex-row items-center gap-2.5">
        {selecting && posts.length ? (
          <Tick
            checked={n === posts.length}
            label={W.picking.pickDay(fmtDateShort(d))}
            onPress={() => pickPosts(posts, n !== posts.length)}
            testID={`socialcontent-pick-day-${d}`}
          />
        ) : null}
        <Text variant="group" className="flex-1">
          {dayShown(d, c.today)}
        </Text>
        {selecting && posts.length ? (
          <Text className={cn('text-[12.5px]', n ? 'text-accent' : 'text-text-3')}>
            {W.picking.dayPicked(n, posts.length)}
          </Text>
        ) : null}
      </View>
    );
  };
  const row = (p: Content) => (
    <PostRow
      key={p.id}
      post={p}
      timeZone={c.timeZone}
      now={now}
      online={online}
      busy={busy}
      onOpen={() => (selecting ? pickPosts([p], !isPicked(p.id)) : onOpen(p.id))}
      tick={
        selecting
          ? { checked: isPicked(p.id), onPress: () => pickPosts([p], !isPicked(p.id)) }
          : undefined
      }
      onTryAgain={() => onTryAgain(p.id)}
      onLook={() => onLookOne(p.id)}
      onMark={(link) => onMarkOne(p.id, link)}
    />
  );
  const openSlot = (o: CalendarView['open'][number]) => {
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
          {selecting ? (
            <Text className="text-[12px] text-text-3">{W.picking.openNoPick}</Text>
          ) : null}
        </View>
        {selecting ? null : (
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
        )}
      </View>
    );
  };

  return (
    <Screen title={W.calendar.title} leading="back" scroll={false} testID="socialcontent-calendar">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        keyboardShouldPersistTaps="handled"
      >
        {selecting ? (
          <View className="flex-row items-center gap-2" testID="socialcontent-pick-head">
            <Button
              size="sm"
              variant="ghost"
              onPress={stopSelecting}
              testID="socialcontent-pick-cancel"
            >
              {W.picking.cancel}
            </Button>
            <Text
              className="flex-1 text-center text-[15px] font-semibold"
              testID="socialcontent-pick-count"
            >
              {W.picking.picked(picked.size)}
            </Text>
            <Pressable
              role="button"
              onPress={() => setPicking(true)}
              className="flex-row items-center gap-1 px-2 py-2"
              testID="socialcontent-pick-menu"
            >
              <Text className="text-[14px] font-medium">{W.picking.pick}</Text>
              <Icon as={ChevronDown} className="size-4 text-text" />
            </Pressable>
          </View>
        ) : (
          <>
            <Note>{W.calendar.intro}</Note>
            {/* No posts are written until the main offer is live (pick 7b); an older API doesn't say, and means live. */}
            {c.offerLive === false ? <OfferNotLive /> : null}
            <View className="gap-2">
              {c.autoFill && c.offerLive !== false ? (
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
                {drafts && look === 'list' ? (
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
                {c.offerLive !== false ? (
                  <Button
                    className="flex-1"
                    variant="secondary"
                    icon={PenLine}
                    loading={busy === 'write'}
                    disabled={other('write')}
                    onPress={() => setAsking(true)}
                    testID="socialcontent-calendar-write"
                  >
                    {busy === 'write' ? W.calendar.writing : W.calendar.write}
                  </Button>
                ) : null}
              </View>
            </View>
          </>
        )}
        <WriteSheet
          open={asking}
          plan={c.plan}
          online={online}
          onClose={() => setAsking(false)}
          onWrite={onWriteFor}
        />

        {selecting ? null : (
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
        )}

        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Segmented
              value={look}
              onChange={(l) => (l === look ? undefined : onGo(l, anchor))}
              label={W.picking.looksLabel}
              options={CALENDAR_LOOKS.map((l) => ({
                value: l,
                label: W.picking.looks[l],
                testID: `socialcontent-look-${l}`,
              }))}
            />
          </View>
          {selecting ? null : (
            <Button
              size="sm"
              variant="secondary"
              icon={SquareCheck}
              onPress={() => setSelecting(true)}
              testID="socialcontent-calendar-select"
            >
              {W.picking.select}
            </Button>
          )}
        </View>
        {look === 'list' ? null : (
          <View className="flex-row items-center gap-1">
            <Pressable
              role="button"
              accessibilityLabel={W.picking.back[look]}
              onPress={() =>
                onGo(look, look === 'week' ? addDays(c.from, -7) : monthMoved(month, -1))
              }
              hitSlop={8}
              className="p-1.5"
              testID="socialcontent-calendar-back"
            >
              <Icon as={ChevronLeft} className="size-5 text-text" />
            </Pressable>
            <Text
              className="flex-1 text-[16px] font-semibold"
              testID="socialcontent-calendar-range"
            >
              {look === 'week' ? weekShownShort(c.from) : title}
            </Text>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => onGo(look, null)}
              testID="socialcontent-calendar-today"
            >
              {W.picking.today}
            </Button>
            <Pressable
              role="button"
              accessibilityLabel={W.picking.ahead[look]}
              onPress={() =>
                onGo(look, look === 'week' ? addDays(c.from, 7) : monthMoved(month, 1))
              }
              hitSlop={8}
              className="p-1.5"
              testID="socialcontent-calendar-ahead"
            >
              <Icon as={ChevronRight} className="size-5 text-text" />
            </Pressable>
          </View>
        )}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityLabel={W.picking.showsLabel}
          contentContainerClassName="gap-1.5"
        >
          {SHOW_FILTERS.map((f) => (
            <FilterChip
              key={f}
              label={W.picking.shows[f]}
              count={counts[f]}
              on={filter === f}
              onPress={() => setFilter(f)}
              testID={`socialcontent-show-${f}`}
            />
          ))}
        </ScrollView>

        {look === 'week' ? (
          <>
            <WeekStrip
              from={c.from}
              today={c.today}
              byDay={byDay}
              selecting={selecting}
              isPicked={isPicked}
              onDay={(_, posts) => {
                if (selecting && posts.length)
                  pickPosts(posts, !posts.every((p) => isPicked(p.id)));
              }}
            />
            {days.map((d) => {
              const posts = byDay.get(d) ?? [];
              const free = openByDay.get(d) ?? [];
              if (!posts.length && !free.length) return null;
              return (
                <View key={d} className="gap-2" testID={`socialcontent-day-${d}`}>
                  {dayTick(d, posts)}
                  {posts.map((p) => (
                    <CompactRow
                      key={p.id}
                      post={p}
                      timeZone={c.timeZone}
                      pick={
                        selecting
                          ? {
                              checked: isPicked(p.id),
                              onPress: () => pickPosts([p], !isPicked(p.id)),
                            }
                          : undefined
                      }
                      onPress={() => (selecting ? pickPosts([p], !isPicked(p.id)) : onOpen(p.id))}
                    />
                  ))}
                  {free.map(openSlot)}
                </View>
              );
            })}
          </>
        ) : look === 'month' ? (
          <>
            <MonthDots
              from={c.from}
              month={month}
              today={c.today}
              byDay={byDay}
              openByDay={openByDay}
              selecting={selecting}
              isPicked={isPicked}
              onDay={(d, posts) => {
                if (!selecting) onGo('week', d);
                else if (posts.length) pickPosts(posts, !posts.every((p) => isPicked(p.id)));
              }}
            />
            {selecting ? <Note>{W.picking.monthHint}</Note> : null}
          </>
        ) : (
          <>
            {!c.posts.length && !c.undated.length && !c.open.length ? (
              <Note testID="socialcontent-calendar-empty">{W.calendar.empty}</Note>
            ) : null}
            {days.map((d) => {
              const posts = byDay.get(d) ?? [];
              const free = openByDay.get(d) ?? [];
              if (!posts.length && !free.length) return null;
              return (
                <View key={d} className="gap-2" testID={`socialcontent-day-${d}`}>
                  {dayTick(d, posts)}
                  {posts.map(row)}
                  {free.map(openSlot)}
                </View>
              );
            })}

            {undated.length ? (
              <View className="gap-2" testID="socialcontent-undated">
                <Text variant="group">{W.calendar.undated}</Text>
                {undated.map(row)}
              </View>
            ) : null}

            {recent.length ? (
              <View className="gap-2" testID="socialcontent-recent">
                <View className="flex-row items-center gap-2.5">
                  {selecting ? (
                    <Tick
                      checked={recent.every((p) => isPicked(p.id))}
                      label={W.picking.pickLately}
                      onPress={() => pickPosts(recent, !recent.every((p) => isPicked(p.id)))}
                      testID="socialcontent-pick-recent"
                    />
                  ) : null}
                  <Text variant="group" className="flex-1">
                    {W.calendar.recent}
                  </Text>
                </View>
                {recent.map(row)}
                {selecting ? <Note>{W.picking.olderHint}</Note> : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
      {selecting ? (
        <PickBar
          items={items}
          canRemove={canRemove}
          online={online}
          busy={busy}
          onAct={onAct}
          onDone={clear}
        />
      ) : null}
      <PickSheet
        open={picking}
        onClose={() => setPicking(false)}
        look={look}
        today={c.today}
        from={c.from}
        days={c.days}
        month={month}
        rangeLabel={rangeLabel}
        inRange={c.posts.map((p) => placedOf(p, c.timeZone))}
        online={online}
        onPick={(list) => pick(list, true)}
        onAsk={(which, range) =>
          void onAsk(which, range).then((list) => {
            if (list) pick(list, true);
          })
        }
        onClear={clear}
        anyPicked={picked.size > 0}
      />
    </Screen>
  );
}

/**
 * Write a post's two questions (the owner, 14 Nov): which networks, one or more, starting on the first with posts in
 * the plan, and whether the AI writes it on its own (the same mix Fill the calendar uses) or from what the person says
 * it's about. Each network gets its own post, written to fit it. Write it closes the sheet and writes, with the
 * Calendar's Write a post button spinning; refused, the choices stay for another go, and written, they start over.
 */
function WriteSheet({
  open,
  plan,
  online,
  onClose,
  onWrite,
}: {
  open: boolean;
  plan: CalendarView['plan'];
  online: boolean;
  onClose: () => void;
  onWrite: (networks: readonly PostingNetwork[], ask: string | null) => unknown;
}) {
  // Null until one is pressed: the first network with posts in the plan.
  const [networks, setNetworks] = React.useState<readonly PostingNetwork[] | null>(null);
  const [how, setHow] = React.useState<'auto' | 'mine'>('auto');
  const [about, setAbout] = React.useState('');
  const picked = networks ?? [firstPlannedNetwork(plan)];
  const ready = online && picked.length > 0 && (how === 'auto' || about.trim().length > 0);
  const flip = (n: PostingNetwork) =>
    setNetworks(
      picked.includes(n)
        ? picked.filter((x) => x !== n)
        : POSTING_NETWORKS.filter((x) => x === n || picked.includes(x)),
    );
  const go = () => {
    const ask = how === 'mine' ? about.trim() : null;
    onClose();
    void Promise.resolve(onWrite(picked, ask)).then((out) => {
      if (!out) return;
      setNetworks(null);
      setHow('auto');
      setAbout('');
    });
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={W.calendar.write}
      description={W.calendar.writeAsk}
      testID="socialcontent-write-sheet"
    >
      <View className="mt-4 gap-4">
        <View className="gap-2">
          <Text className="text-[13.5px] font-medium">{W.calendar.writeNetwork}</Text>
          <View className="flex-row flex-wrap gap-1.5">
            {POSTING_NETWORKS.map((n) => (
              <FilterChip
                key={n}
                label={networkName(n)}
                on={picked.includes(n)}
                onPress={() => flip(n)}
                testID={`socialcontent-write-network-${n}`}
              />
            ))}
          </View>
          <Text className="text-[12.5px] leading-[17px] text-text-3">
            {W.calendar.writeNetworkHint}
          </Text>
        </View>
        <View className="gap-2">
          <Text className="text-[13.5px] font-medium">{W.calendar.writeHow}</Text>
          <Segmented
            value={how}
            onChange={setHow}
            label={W.calendar.writeHow}
            options={[
              { value: 'auto', label: W.calendar.writeAuto, testID: 'socialcontent-write-auto' },
              { value: 'mine', label: W.calendar.writeMine, testID: 'socialcontent-write-mine' },
            ]}
          />
          <Text className="text-[12.5px] leading-[17px] text-text-3">
            {how === 'auto' ? W.calendar.writeAutoHint : W.calendar.writeMineHint}
          </Text>
        </View>
        {how === 'mine' ? (
          <View className="gap-1.5">
            <Text className="text-[13.5px] font-medium">{W.calendar.writeAbout}</Text>
            <Input
              value={about}
              multiline
              maxLength={CALENDAR.askMost}
              placeholder={W.calendar.writeAboutPlaceholder}
              accessibilityLabel={W.calendar.writeAbout}
              className="min-h-[96px] py-2.5"
              textAlignVertical="top"
              onChangeText={setAbout}
              testID="socialcontent-write-about"
            />
          </View>
        ) : null}
        <Button icon={PenLine} disabled={!ready} onPress={go} testID="socialcontent-write-go">
          {W.calendar.writeGo(picked.length)}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * One post on the Calendar: its picture, network, time, format and state, title and first line; while picking, its
 * tick beside it; a post that didn't post, with Try again, Check if it posted and Mark as posted under it.
 */
function PostRow({
  post: p,
  timeZone,
  now,
  online,
  busy,
  onOpen,
  tick,
  onTryAgain,
  onLook,
  onMark,
}: {
  post: Content;
  timeZone: string;
  now: number;
  online: boolean;
  busy: string | null;
  onOpen: () => void;
  tick?: { checked: boolean; onPress: () => void };
  onTryAgain: () => void;
  onLook: () => void;
  onMark: (link: string | null) => unknown;
}) {
  const shown = (
    <View className="gap-2">
      <PostRowBody post={p} timeZone={timeZone} picked={tick?.checked ?? false} onOpen={onOpen} />
      {tick ? null : (
        <DidntPost
          post={p}
          timeZone={timeZone}
          now={now}
          online={online}
          busy={busy}
          onTryAgain={onTryAgain}
          onLook={onLook}
          onMark={onMark}
        />
      )}
    </View>
  );
  if (!tick) return shown;
  return (
    <View className="flex-row items-center gap-3">
      <Tick
        checked={tick.checked}
        label={W.picking.pickPost(p.title)}
        onPress={tick.onPress}
        testID={`socialcontent-post-${p.id}-pick`}
      />
      <View className="min-w-0 flex-1">{shown}</View>
    </View>
  );
}

function PostRowBody({
  post: p,
  timeZone,
  picked,
  onOpen,
}: {
  post: Content;
  timeZone: string;
  picked: boolean;
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
        'flex-row items-start gap-3 rounded-card border bg-card p-3',
        picked ? 'border-accent bg-accent-soft' : 'border-border',
        (p.state === 'skipped' || p.hidden) && 'opacity-60',
        p.hidden && 'border-dashed',
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
          {p.hidden ? <Badge variant="gray">{W.picking.hiddenBadge}</Badge> : null}
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
        {p.state === 'failed' && p.failure ? (
          <Text className="text-[12.5px] leading-[17px] text-danger-text" numberOfLines={2}>
            {p.failure}
          </Text>
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
