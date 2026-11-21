import { addDays, fmtDateShort, localDateOf, parseLocalDate } from '@hfos/core';
import { canLook, canRedo, type PostingNetwork } from '@hfos/core/addons/socialcontent/calendar';
import {
  daysFrom,
  monthMoved,
  monthName,
  monthOf,
  picks,
  summaryOf,
  weekShownShort,
  weekStartOf,
  type CalendarLook,
  type PickWhich,
  type PickedLike,
} from '@hfos/core/addons/socialcontent/calendar-looks';
import type { CalendarView, Content } from '@hfos/core/addons/socialcontent/content-shapes';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import {
  SOCIALCONTENT_WORDS as W,
  listShown,
  timeShown,
} from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import {
  Check,
  CircleCheck,
  Ellipsis,
  Eye,
  EyeOff,
  RotateCcw,
  Search,
  Trash,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * Picking many posts on the phone's Calendar, and what a post that didn't post can do (docs/socialcontent.md,
 * "Picking many posts"; the owner, 15 Nov; the design they OK'd), as on the web: the Pick sheet adds posts by day,
 * week, month, kind or any date; the bar at the foot OKs, redoes (past ones go up again; waiting ones are written again
 * by the AI, after asking), checks or hides them, with More for Mark posted, Show again and Delete. Which posts each button takes is core's (`summaryOf`), so the web and the phone decide alike.
 */

/** A picked post: enough to say what the buttons do with it. */
export interface PickItem extends PickedLike {
  readonly title: string;
}

export const itemOf = (
  p: Pick<Content, 'id' | 'title' | 'state' | 'network' | 'hidden'>,
): PickItem => ({
  id: p.id,
  title: p.title,
  state: p.state,
  network: p.network,
  hidden: p.hidden,
});

/** What the bar does with picked posts: each sent a turn at a time, then how many it did and how many it couldn't. */
export type PickAct = 'ok' | 'redo' | 'rewrite' | 'look' | 'mark' | 'hide' | 'show' | 'remove';
export type Sent = { done: number; left: number } | null;

const networksOf = (items: readonly PickedLike[]) =>
  listShown([...new Set(items.map((p) => networkName(p.network as PostingNetwork)))]);

/** A post as a dot: waiting, OK'd or posted, didn't post, hidden. */
export function dotClass(p: Pick<Content, 'state' | 'hidden'>): string {
  if (p.hidden) return 'border border-border-strong';
  if (p.state === 'draft') return 'bg-warning';
  if (p.state === 'failed') return 'bg-danger';
  if (p.state === 'skipped') return 'bg-border-strong';
  return 'bg-success';
}

/** A tick for picking. */
export function Tick({
  checked,
  label,
  onPress,
  testID,
}: {
  checked: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      testID={testID}
      className={cn(
        'size-6 items-center justify-center rounded-[7px] border',
        checked ? 'border-accent bg-accent' : 'border-border-strong bg-card',
      )}
    >
      {checked ? <Icon as={Check} className="size-4 text-white" /> : null}
    </Pressable>
  );
}

/** One of the bar's buttons: an icon over its name and how many it takes. */
function BarButton({
  icon,
  label,
  n,
  disabled,
  onPress,
  testID,
}: {
  icon: typeof Check;
  label: string;
  n: number | null;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  const off = disabled || n === 0;
  return (
    <Pressable
      role="button"
      accessibilityState={{ disabled: off }}
      accessibilityLabel={n === null ? label : `${label} ${n}`}
      disabled={off}
      onPress={onPress}
      testID={testID}
      className={cn('min-w-0 flex-1 items-center gap-1 py-1.5', off && 'opacity-40')}
    >
      <Icon as={icon} className="size-5 text-text" />
      <Text className="text-[12px] font-medium text-text" numberOfLines={1}>
        {n === null ? label : `${label} ${n.toLocaleString('en-US')}`}
      </Text>
    </Pressable>
  );
}

/**
 * The bar at the foot while picking: what's picked, and OK, Redo, Check and Hide (or Show again), with More for Mark
 * posted, Show again and Delete. Delete asks first and offers Hide instead; Mark posted asks first too.
 */
export function PickBar({
  items,
  canRemove,
  online,
  busy,
  onAct,
  onDone,
}: {
  items: readonly PickItem[];
  canRemove: boolean;
  online: boolean;
  busy: string | null;
  onAct: (kind: PickAct, ids: readonly string[], link?: string | null) => Promise<Sent>;
  /** After each, what's picked is cleared. */
  onDone: () => void;
}) {
  const s = summaryOf(items);
  const [more, setMore] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [marking, setMarking] = React.useState(false);
  const [redoing, setRedoing] = React.useState(false);
  const byId = new Map(items.map((p) => [p.id, p]));
  const of = (ids: readonly string[]) => ids.map((id) => byId.get(id)!).filter(Boolean);
  const off = !online || busy !== null;
  const run = (kind: PickAct, ids: readonly string[], link?: string | null) =>
    onAct(kind, ids, link).then((out) => {
      if (out) onDone();
      return out;
    });
  // Redo: past posts go up again, waiting ones are written again by the AI (the owner, 15 Nov).
  const redo = async () => {
    const past = s.redo.length ? await onAct('redo', s.redo) : null;
    const again = s.rewrite.length ? await onAct('rewrite', s.rewrite) : null;
    if (past || again) {
      setRedoing(false);
      onDone();
    }
  };
  const hideInBar = s.hide.length > 0 || s.show.length === 0;
  const redoPosted = of(s.redo).filter((p) => p.state === 'posted');
  return (
    <View className="border-t border-border bg-card px-2 pb-3 pt-2" testID="socialcontent-pick-bar">
      <Text
        className="px-2 text-center text-[12px] leading-[16px] text-text-2"
        testID="socialcontent-pick-summary"
      >
        {s.picked ? W.picking.summary(s) : W.picking.menu.adds}
      </Text>
      {redoPosted.length ? (
        <Text
          className="px-2 pt-1 text-center text-[11.5px] leading-[15px] text-warning-text"
          testID="socialcontent-pick-redo-posted"
        >
          {W.calendar.redoPosted([
            ...new Set(redoPosted.map((p) => networkName(p.network as PostingNetwork))),
          ])}
        </Text>
      ) : null}
      <View role="toolbar" accessibilityLabel={W.picking.actionsLabel} className="mt-1 flex-row">
        <BarButton
          icon={Check}
          label={W.picking.ok}
          n={s.ok.length}
          disabled={off}
          onPress={() => void run('ok', s.ok)}
          testID="socialcontent-pick-ok"
        />
        <BarButton
          icon={RotateCcw}
          label={W.picking.redo}
          n={s.redo.length + s.rewrite.length}
          disabled={off}
          onPress={() => (s.rewrite.length ? setRedoing(true) : void redo())}
          testID="socialcontent-pick-redo"
        />
        <BarButton
          icon={Search}
          label={W.picking.lookShort}
          n={s.look.length}
          disabled={off}
          onPress={() => void run('look', s.look)}
          testID="socialcontent-pick-look"
        />
        {hideInBar ? (
          <BarButton
            icon={EyeOff}
            label={W.picking.hide}
            n={s.hide.length}
            disabled={off}
            onPress={() => void run('hide', s.hide)}
            testID="socialcontent-pick-hide"
          />
        ) : (
          <BarButton
            icon={Eye}
            label={W.picking.show}
            n={s.show.length}
            disabled={off}
            onPress={() => void run('show', s.show)}
            testID="socialcontent-pick-show"
          />
        )}
        <BarButton
          icon={Ellipsis}
          label={W.picking.more}
          n={null}
          disabled={off || !s.picked}
          onPress={() => setMore(true)}
          testID="socialcontent-pick-more"
        />
      </View>

      <Sheet
        open={more}
        onClose={() => setMore(false)}
        title={W.picking.picked(s.picked)}
        testID="socialcontent-pick-more-sheet"
      >
        <View className="mt-3 gap-2">
          <Button
            variant="secondary"
            icon={CircleCheck}
            disabled={off || !s.look.length}
            onPress={() => {
              setMore(false);
              setMarking(true);
            }}
            testID="socialcontent-pick-mark"
          >
            {`${W.picking.mark} ${s.look.length}`}
          </Button>
          {hideInBar && s.show.length ? (
            <Button
              variant="secondary"
              icon={Eye}
              disabled={off}
              onPress={() => {
                setMore(false);
                void run('show', s.show);
              }}
              testID="socialcontent-pick-show"
            >
              {`${W.picking.show} ${s.show.length}`}
            </Button>
          ) : null}
          {canRemove ? (
            <Button
              variant="dangerOutline"
              icon={Trash}
              disabled={off || !s.remove.length}
              onPress={() => {
                setMore(false);
                setRemoving(true);
              }}
              testID="socialcontent-pick-remove"
            >
              {`${W.picking.remove} ${s.remove.length}`}
            </Button>
          ) : (
            <Text className="text-[12.5px] leading-[17px] text-text-3">{W.picking.removeWho}</Text>
          )}
        </View>
      </Sheet>

      <Sheet
        open={redoing && s.rewrite.length > 0}
        onClose={() => (busy ? null : setRedoing(false))}
        title={W.picking.redoTitle(s.redo.length + s.rewrite.length)}
        testID="socialcontent-pick-redo-sheet"
      >
        <View className="mt-2 gap-3">
          <Text className="text-[14px] leading-[20px] text-text-2">
            {W.picking.redoRewrite(s.rewrite.length)}
          </Text>
          {s.redo.length ? (
            <Text className="text-[13.5px] leading-[19px] text-text-2">
              {W.picking.redoPast(s.redo.length)}
            </Text>
          ) : null}
          <Button
            loading={busy === 'redo' || busy === 'rewrite'}
            disabled={!online || (busy !== null && busy !== 'redo' && busy !== 'rewrite')}
            onPress={() => void redo()}
            testID="socialcontent-pick-redo-go"
          >
            {W.picking.redoGo(s.redo.length + s.rewrite.length)}
          </Button>
          <Button variant="ghost" disabled={busy !== null} onPress={() => setRedoing(false)}>
            {W.picking.redoCancel}
          </Button>
        </View>
      </Sheet>

      <DeleteSheet
        open={removing}
        items={of(s.remove)}
        online={online}
        busy={busy}
        onClose={() => setRemoving(false)}
        onHide={() =>
          void run(
            'hide',
            of(s.remove)
              .filter((p) => !p.hidden)
              .map((p) => p.id),
          ).then((o) => o && setRemoving(false))
        }
        onDelete={() => void run('remove', s.remove).then((o) => o && setRemoving(false))}
      />
      <MarkSheet
        open={marking}
        items={of(s.look)}
        online={online}
        busy={busy}
        onClose={() => setMarking(false)}
        onLook={() => void run('look', s.look).then((o) => o && setMarking(false))}
        onMark={(link) => void run('mark', s.look, link).then((o) => o && setMarking(false))}
      />
    </View>
  );
}

/** Delete asks first: what comes off, that posts already up stay up there, and Hide instead. */
function DeleteSheet({
  open,
  items,
  online,
  busy,
  onClose,
  onHide,
  onDelete,
}: {
  open: boolean;
  items: readonly PickItem[];
  online: boolean;
  busy: string | null;
  onClose: () => void;
  onHide: () => void;
  onDelete: () => void;
}) {
  const up = items.filter((p) => p.state === 'posted');
  const upcoming = items.filter((p) => p.state === 'draft' || p.state === 'ready').length;
  const hideable = items.some((p) => !p.hidden);
  const off = (key: string) => !online || (busy !== null && busy !== key);
  return (
    <Sheet
      open={open && items.length > 0}
      onClose={onClose}
      title={W.picking.removeTitle(items.length)}
      description={W.picking.removeSays(upcoming)}
      testID="socialcontent-pick-remove-sheet"
    >
      <View className="mt-3 gap-3">
        {up.length ? (
          <Card className="border-warning-soft bg-warning-soft p-3">
            <Text className="text-[13px] leading-[18px] text-warning-text">
              {W.picking.removeUp(up.length, networksOf(up))}
            </Text>
          </Card>
        ) : null}
        {hideable ? (
          <Text className="text-[12.5px] leading-[17px] text-text-3">
            {W.picking.removeHideInstead}
          </Text>
        ) : null}
        <Button
          variant="danger"
          loading={busy === 'remove'}
          disabled={off('remove')}
          onPress={onDelete}
          testID="socialcontent-pick-remove-go"
        >
          {W.picking.removeGo(items.length)}
        </Button>
        {hideable ? (
          <Button
            variant="secondary"
            loading={busy === 'hide'}
            disabled={off('hide')}
            onPress={onHide}
            testID="socialcontent-pick-remove-hide"
          >
            {W.picking.removeHide}
          </Button>
        ) : null}
        <Button variant="ghost" disabled={busy !== null} onPress={onClose}>
          {W.picking.removeKeep}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * Mark as posted asks first: do it when you can see it on the network. One post can carry its link; several skip the
 * links. Check if it posted is beside it.
 */
export function MarkSheet({
  open,
  items,
  online,
  busy,
  onClose,
  onLook,
  onMark,
}: {
  open: boolean;
  items: readonly PickItem[];
  online: boolean;
  busy: string | null;
  onClose: () => void;
  onLook: () => void;
  onMark: (link: string | null) => void;
}) {
  const [link, setLink] = React.useState('');
  const one = items.length === 1 ? items[0]! : null;
  const off = (key: string) => !online || (busy !== null && busy !== key);
  const close = () => {
    setLink('');
    onClose();
  };
  return (
    <Sheet
      open={open && items.length > 0}
      onClose={close}
      title={W.picking.markTitle(one?.title ?? null, items.length)}
      description={items.length ? W.picking.markSays(networksOf(items)) : undefined}
      testID="socialcontent-mark-sheet"
    >
      <View className="mt-3 gap-3">
        {one ? (
          <View className="gap-1.5">
            <Text className="text-[13.5px] font-medium">
              {W.picking.markLink}{' '}
              <Text className="font-normal text-text-3">{W.picking.markLinkOptional}</Text>
            </Text>
            <Input
              value={link}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              maxLength={500}
              placeholder="https://…"
              accessibilityLabel={W.picking.markLink}
              onChangeText={setLink}
              testID="socialcontent-mark-link"
            />
            <Text className="text-[12.5px] leading-[17px] text-text-3">
              {W.picking.markLinkHint}
            </Text>
          </View>
        ) : (
          <Text className="text-[12.5px] leading-[17px] text-text-3">{W.picking.markMany}</Text>
        )}
        <Button
          icon={CircleCheck}
          loading={busy === 'mark'}
          disabled={off('mark')}
          onPress={() => onMark(one ? link.trim() || null : null)}
          testID="socialcontent-mark-go"
        >
          {W.picking.markGo}
        </Button>
        <Button
          variant="secondary"
          icon={Search}
          loading={busy === 'look'}
          disabled={off('look')}
          onPress={onLook}
          testID="socialcontent-mark-look"
        >
          {W.picking.lookOne}
        </Button>
        <Button variant="ghost" disabled={busy !== null} onPress={close}>
          {W.picking.markCancel}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * A post that didn't post (the owner, 15 Nov): Try again, Check if it posted (Chrome looks on the network and marks it
 * posted if it's there) or Mark as posted, with where the looking stands. It looks once on its own, 10 minutes after.
 */
export function DidntPost({
  post: p,
  timeZone,
  now,
  online,
  busy,
  onTryAgain,
  onLook,
  onMark,
}: {
  post: Content;
  timeZone: string;
  now: number;
  online: boolean;
  busy: string | null;
  onTryAgain: () => void;
  onLook: () => void;
  /** What it gives back is null when refused. */
  onMark: (link: string | null) => unknown;
}) {
  const [marking, setMarking] = React.useState(false);
  if (p.state !== 'failed' || p.hidden) return null;
  const network = networkName(p.network as PostingNetwork);
  const lookAt = p.lookAt ? Date.parse(p.lookAt) : null;
  // Asked for, or due: the computer that posts is looking now (or as soon as Chrome opens).
  const looking = lookAt !== null && lookAt <= now + 60_000;
  const line = looking
    ? { text: W.picking.looking(network), tone: 'text-text-2' }
    : p.lookFailure
      ? { text: W.picking.lookCouldnt(p.lookFailure), tone: 'text-danger-text' }
      : p.lookedAt
        ? {
            text: W.picking.notFound(network, timeShown(p.lookedAt, timeZone)),
            tone: 'text-text-2',
          }
        : lookAt !== null
          ? {
              text: W.picking.lookSoon(timeShown(new Date(lookAt).toISOString(), timeZone)),
              tone: 'text-text-3',
            }
          : null;
  const off = (key: string) => !online || (busy !== null && busy !== key);
  return (
    <View className="gap-2" testID={`socialcontent-post-${p.id}-didnt`}>
      {line ? (
        <Text
          className={cn('text-[12.5px] leading-[17px]', line.tone)}
          testID={`socialcontent-post-${p.id}-look-line`}
        >
          {line.text}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {canRedo(p) && !looking ? (
          <Button
            size="sm"
            variant="secondary"
            icon={RotateCcw}
            loading={busy === `again:${p.id}`}
            disabled={off(`again:${p.id}`)}
            onPress={onTryAgain}
            testID={`socialcontent-post-${p.id}-again`}
          >
            {W.picking.tryAgain}
          </Button>
        ) : null}
        {canLook(p) && !looking ? (
          <Button
            size="sm"
            variant="secondary"
            icon={Search}
            loading={busy === `look:${p.id}`}
            disabled={off(`look:${p.id}`)}
            onPress={onLook}
            testID={`socialcontent-post-${p.id}-look`}
          >
            {p.lookedAt ? W.picking.lookAgain : W.picking.lookOne}
          </Button>
        ) : null}
        {canLook(p) ? (
          <Button
            size="sm"
            variant="ghost"
            icon={CircleCheck}
            disabled={!online || busy !== null}
            onPress={() => setMarking(true)}
            testID={`socialcontent-post-${p.id}-mark`}
          >
            {p.lookedAt ? W.picking.markAnyway : W.picking.markOne}
          </Button>
        ) : null}
      </View>
      <MarkSheet
        open={marking}
        items={[itemOf(p)]}
        online={online}
        busy={busy === `mark:${p.id}` ? 'mark' : busy === `look:${p.id}` ? 'look' : busy}
        onClose={() => setMarking(false)}
        onLook={() => {
          setMarking(false);
          onLook();
        }}
        onMark={(link) =>
          void Promise.resolve(onMark(link)).then((out) => {
            if (out) setMarking(false);
          })
        }
      />
    </View>
  );
}

/** A post on the page, as the Pick sheet reads it: its day in the business's time zone. */
export interface Placed extends PickItem {
  readonly day: string | null;
}

export const placedOf = (p: Content, timeZone: string): Placed => ({
  ...itemOf(p),
  day: p.postAt ? localDateOf(Date.parse(p.postAt), timeZone) : null,
});

/** How many days a month has, from its first. */
const monthDays = (month: string) => {
  const next = monthMoved(month, 1);
  let n = 28;
  while (addDays(month, n) < next) n++;
  return n;
};

/**
 * The Pick sheet: quick picks (today, this week or this month), every kind in the days shown, and every kind across
 * any date. Each pick adds to what's already picked. Picks inside the days on the screen are made from what's shown
 * (with how many); the rest ask for them.
 */
export function PickSheet({
  open,
  onClose,
  look,
  today,
  from,
  days,
  month,
  rangeLabel,
  inRange,
  online,
  onPick,
  onAsk,
  onClear,
  anyPicked,
}: {
  open: boolean;
  onClose: () => void;
  look: CalendarLook;
  today: string;
  from: string;
  days: number;
  month: string;
  rangeLabel: string;
  inRange: readonly Placed[];
  online: boolean;
  onPick: (items: readonly PickItem[]) => void;
  /** Asks for the posts picked across days not on the screen, or any date. */
  onAsk: (which: PickWhich, range?: { from: string; days: number }) => void;
  onClear: () => void;
  anyPicked: boolean;
}) {
  const [where, setWhere] = React.useState<'shown' | 'any'>('shown');
  const end = addDays(from, days);
  const held = (a: string, n: number) => a >= from && addDays(a, n) <= end;
  const local = (a: string, n: number) =>
    inRange.filter((p) => p.day !== null && p.day >= a && p.day < addDays(a, n));
  const span = (a: string, n: number) =>
    held(a, n)
      ? { count: local(a, n).length as number | null, go: () => onPick(local(a, n)) }
      : { count: null, go: () => onAsk('all', { from: a, days: n }) };
  const thisMonth = monthOf(today);
  const quick = [
    { key: 'today', label: W.picking.menu.today(fmtDateShort(today)), ...span(today, 1) },
    look === 'week'
      ? {
          key: 'month',
          label: W.picking.menu.thisMonth(monthName(thisMonth)),
          ...span(thisMonth, monthDays(thisMonth)),
        }
      : {
          key: 'week',
          label: W.picking.menu.thisWeek(weekShownShort(weekStartOf(today))),
          ...span(weekStartOf(today), 7),
        },
  ];
  const ofKind = (which: PickWhich) =>
    inRange.filter(
      (p) => (look === 'month' ? p.day?.startsWith(month.slice(0, 7)) : true) && picks(p, which),
    );
  const kinds: readonly { which: PickWhich; label: string }[] =
    where === 'shown'
      ? [
          { which: 'all', label: W.picking.menu.everythingIn(rangeLabel) },
          { which: 'waiting', label: W.picking.menu.waiting },
          { which: 'okd', label: W.picking.menu.okd },
          { which: 'past', label: W.picking.menu.past },
          { which: 'failed', label: W.picking.menu.failed },
          { which: 'hidden', label: W.picking.menu.hidden },
        ]
      : [
          { which: 'all', label: W.picking.menu.everything },
          { which: 'waiting', label: W.picking.menu.allWaiting },
          { which: 'past', label: W.picking.menu.allPast },
          { which: 'failed', label: W.picking.menu.allFailed },
          { which: 'hidden', label: W.picking.menu.allHidden },
        ];
  const done = (go: () => void) => {
    go();
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={W.picking.pick}
      description={W.picking.menu.adds}
      scroll
      testID="socialcontent-pick-sheet"
    >
      <View className="mt-3 gap-3">
        <View className="flex-row gap-2">
          {quick.map((q) => (
            <Pressable
              key={q.key}
              role="button"
              disabled={!online && q.count === null}
              onPress={() => done(q.go)}
              className="min-w-0 flex-1 gap-0.5 rounded-card border border-border bg-card p-3 active:bg-card-2"
              testID={`socialcontent-pick-${q.key}`}
            >
              <Text className="text-[13.5px] font-medium" numberOfLines={2}>
                {q.label}
              </Text>
              {q.count !== null ? <Text className="text-[12px] text-text-3">{q.count}</Text> : null}
            </Pressable>
          ))}
        </View>
        <Segmented
          value={where}
          onChange={setWhere}
          label={W.picking.pick}
          options={[
            {
              value: 'shown',
              label: W.picking.menu.inRange(rangeLabel),
              testID: 'socialcontent-pick-where-shown',
            },
            { value: 'any', label: W.picking.menu.anyDate, testID: 'socialcontent-pick-where-any' },
          ]}
        />
        <Card className="overflow-hidden p-0">
          {kinds.map((k, i) => (
            <Pressable
              key={k.which}
              role="button"
              disabled={where === 'any' && !online}
              onPress={() =>
                done(() => (where === 'shown' ? onPick(ofKind(k.which)) : onAsk(k.which)))
              }
              className={cn(
                'flex-row items-center gap-3 px-3.5 py-3 active:bg-card-2',
                i > 0 && 'border-t border-border',
              )}
              testID={`socialcontent-pick-${where}-${k.which}`}
            >
              <Text className="min-w-0 flex-1 text-[14px]">{k.label}</Text>
              {where === 'shown' ? (
                <Text className="text-[13px] text-text-3">{ofKind(k.which).length}</Text>
              ) : null}
            </Pressable>
          ))}
        </Card>
        {anyPicked ? (
          <Button variant="ghost" onPress={() => done(onClear)} testID="socialcontent-pick-clear">
            {W.picking.menu.clear}
          </Button>
        ) : null}
      </View>
    </Sheet>
  );
}

type Slot = CalendarView['open'][number];

/** Each day of a week, with its number, a dot for each post, and while picking, whether it's all picked. */
export function WeekStrip({
  from,
  today,
  byDay,
  selecting,
  isPicked,
  onDay,
}: {
  from: string;
  today: string;
  byDay: ReadonlyMap<string, readonly Content[]>;
  selecting: boolean;
  isPicked: (id: string) => boolean;
  onDay: (day: string, posts: readonly Content[]) => void;
}) {
  return (
    <View className="flex-row" testID="socialcontent-week">
      {daysFrom(from, 7).map((day, i) => {
        const posts = byDay.get(day) ?? [];
        const all = selecting && posts.length > 0 && posts.every((p) => isPicked(p.id));
        const some = selecting && posts.some((p) => isPicked(p.id));
        return (
          <Pressable
            key={day}
            role="button"
            accessibilityLabel={
              selecting ? W.picking.pickDay(fmtDateShort(day)) : fmtDateShort(day)
            }
            onPress={() => onDay(day, posts)}
            className="min-w-0 flex-1 items-center gap-1 py-1"
            testID={`socialcontent-week-${day}`}
          >
            <Text className="text-[11px] text-text-3">{W.picking.weekdaysShort[i]}</Text>
            <View
              className={cn(
                'size-8 items-center justify-center rounded-full',
                all ? 'bg-accent' : some ? 'bg-accent-soft' : '',
                day === today && !all && 'border-2 border-accent',
              )}
            >
              <Text
                className={cn(
                  'text-[14px] font-medium',
                  all ? 'text-white' : day === today || some ? 'text-accent' : 'text-text',
                )}
              >
                {parseLocalDate(day).day}
              </Text>
            </View>
            <View className="h-1.5 flex-row gap-0.5">
              {posts.slice(0, 4).map((p) => (
                <View key={p.id} className={cn('size-1.5 rounded-full', dotClass(p))} />
              ))}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A month: 6 weeks from the Monday on or before its first, each day with a dot for each post. */
export function MonthDots({
  from,
  month,
  today,
  byDay,
  openByDay,
  selecting,
  isPicked,
  onDay,
}: {
  from: string;
  month: string;
  today: string;
  byDay: ReadonlyMap<string, readonly Content[]>;
  openByDay: ReadonlyMap<string, readonly Slot[]>;
  selecting: boolean;
  isPicked: (id: string) => boolean;
  /** Picks the day while picking, else opens its week. */
  onDay: (day: string, posts: readonly Content[]) => void;
}) {
  const all = daysFrom(from, 42);
  return (
    <View className="gap-1" testID="socialcontent-month">
      <View className="flex-row">
        {W.picking.weekdaysShort.map((d, i) => (
          <Text key={i} className="min-w-0 flex-1 text-center text-[11px] text-text-3">
            {d}
          </Text>
        ))}
      </View>
      {Array.from({ length: 6 }, (_, w) => all.slice(w * 7, w * 7 + 7)).map((week) => (
        <View key={week[0]} className="flex-row gap-1">
          {week.map((day) => {
            const posts = byDay.get(day) ?? [];
            const picked = selecting && posts.length > 0 && posts.every((p) => isPicked(p.id));
            const inMonth = monthOf(day) === month;
            return (
              <Pressable
                key={day}
                role="button"
                accessibilityLabel={
                  selecting
                    ? W.picking.pickDay(fmtDateShort(day))
                    : W.picking.openWeek(fmtDateShort(day))
                }
                onPress={() => onDay(day, posts)}
                className={cn(
                  'min-h-[48px] min-w-0 flex-1 items-center gap-1 rounded-[9px] py-1',
                  picked && 'bg-accent-soft',
                )}
                testID={`socialcontent-month-${day}`}
              >
                <View
                  className={cn(
                    'size-7 items-center justify-center rounded-full',
                    day === today && 'bg-accent',
                  )}
                >
                  <Text
                    className={cn(
                      'text-[13px]',
                      day === today
                        ? 'font-semibold text-white'
                        : picked
                          ? 'font-medium text-accent'
                          : inMonth
                            ? 'text-text'
                            : 'text-text-3',
                    )}
                  >
                    {parseLocalDate(day).day}
                  </Text>
                </View>
                <View className="h-1.5 flex-row gap-0.5">
                  {posts.slice(0, 4).map((p) => (
                    <View key={p.id} className={cn('size-1.5 rounded-full', dotClass(p))} />
                  ))}
                  {!posts.length && (openByDay.get(day)?.length ?? 0) > 0 && day >= today ? (
                    <View className="size-1.5 rounded-full border border-dashed border-border-strong" />
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      ))}
      <View
        className="mt-1 flex-row flex-wrap gap-x-3 gap-y-1"
        accessibilityLabel={W.picking.legendLabel}
      >
        {(
          [
            ['bg-warning', W.picking.shows.waiting],
            ['bg-success', `${W.picking.shows.okd}, ${W.picking.shows.posted}`],
            ['bg-danger', W.picking.shows.failed],
            ['border border-border-strong', W.picking.shows.hidden],
          ] as const
        ).map(([dot, label]) => (
          <View key={label} className="flex-row items-center gap-1.5">
            <View className={cn('size-2 rounded-full', dot)} />
            <Text className="text-[11.5px] text-text-3">{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** One post in a week's days: its network, title, time and where it stands, compact. */
export function CompactRow({
  post: p,
  timeZone,
  pick,
  onPress,
}: {
  post: Content;
  timeZone: string;
  pick?: { checked: boolean; onPress: () => void };
  onPress: () => void;
}) {
  const tone = p.hidden
    ? 'text-text-3'
    : p.state === 'draft'
      ? 'text-warning-text'
      : p.state === 'failed'
        ? 'text-danger-text'
        : p.state === 'skipped'
          ? 'text-text-3'
          : 'text-success-text';
  return (
    <View
      className={cn(
        'flex-row items-center gap-3 rounded-card border bg-card px-3 py-2.5',
        pick?.checked ? 'border-accent bg-accent-soft' : 'border-border',
        p.hidden && 'border-dashed',
      )}
    >
      {pick ? (
        <Tick
          checked={pick.checked}
          label={W.picking.pickPost(p.title)}
          onPress={pick.onPress}
          testID={`socialcontent-post-${p.id}-pick`}
        />
      ) : null}
      <Pressable
        role="button"
        onPress={onPress}
        accessibilityLabel={p.title}
        className="min-w-0 flex-1 flex-row items-center gap-2.5"
        testID={`socialcontent-post-${p.id}`}
      >
        <View className="rounded-[4px] bg-card-2 px-1.5 py-0.5">
          <Text className="text-[10.5px] font-semibold text-text-2">
            {W.picking.short[p.network] ?? p.network.slice(0, 2).toUpperCase()}
          </Text>
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[14px] font-medium" numberOfLines={1}>
            {p.title}
          </Text>
          <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
            {p.postAt ? `${timeShown(p.postAt, timeZone)} · ` : ''}
            <Text className={cn('text-[12.5px]', tone)}>
              {p.hidden ? W.picking.hiddenBadge : W.post.states[p.state]}
            </Text>
          </Text>
        </View>
      </Pressable>
    </View>
  );
}
