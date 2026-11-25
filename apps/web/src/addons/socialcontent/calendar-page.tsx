'use client';
/**
 * Calendar (docs/socialcontent.md, "Making posts" and "Picking many posts"; decisions 13 to 20): the business's own
 * posts, written by the AI from the Playbook and saved ideas. Each waits for an OK (decision 15): open one to change
 * it, OK it or skip it, or **OK the week** in one go. Open days in the plan show where a post is still wanted; **Fill
 * the calendar** has the AI write them all, and after the first time it tops up once a week on its own (decision 18),
 * until **Fill on its own** is turned off (the owner, 11 Nov). OK'd posts go up at their times from the reading
 * computer (part 9), and the card says whose computer that is and when it last checked in. **Write a post** asks two
 * things first (the owner, 14 Nov): which networks, and whether the AI writes it on its own or from what the person
 * says it's about. Until the main offer is live, nothing is written, and the page says so (pick 7b, 11 Nov).
 *
 * It looks like a **List** of today and the two weeks after (the default, with what went up or didn't under Lately),
 * a **Week** from Monday or a **Month** (the owner, 15 Nov; the design they OK'd); the look picked is kept for the next
 * visit. The filters above show everything, or one kind; Hidden holds what was hidden. **Select** picks many posts
 * (one, a day, a week, a month, a kind, or any date from Pick), and the bar under them OKs, redoes, checks, marks as
 * posted, hides or deletes them. A post that didn't post has Try again, Check if it posted and Mark as posted.
 */
import { addDays, fmtDateShort, localDateOf } from '@hfos/core';
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
  monthMoved,
  monthName,
  monthOf,
  monthShown,
  shows,
  weekShown,
  weekShownShort,
  type CalendarLook,
  type ShowFilter,
} from '@hfos/core/addons/socialcontent/calendar-looks';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import {
  SOCIALCONTENT_WORDS as W,
  dayShown,
  filledLine,
  numbersLines,
  planShown,
  postingLines,
} from '@hfos/core/addons/socialcontent/words';
import {
  CalendarCheck,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Loader2,
  PenLine,
  Plus,
  SquareCheck,
  Trash2,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { useCan } from '@/components/shell/workspace-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { RadioCard } from '@/components/ui/radio-card';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { Legend, MonthGrid, WeekGrid } from './calendar-grids';
import { DidntPost, itemOf, PickBar, PickMenu, placedOf, usePicked } from './calendar-picking';
import { rememberLook } from './looks';
import { OfferNotLive } from './offer-notice';
import { PostPicture, PostSheet, RemovePostDialog, STATE_BADGE, timeIn } from './post-sheet';
import type { CalendarView, Content } from './types';
import { useAct } from './use-act';

const WRITE = '/v1/addons/socialcontent/actions/socialcontent.content.write';
const FILL = '/v1/addons/socialcontent/actions/socialcontent.calendar.fill';

type Slot = CalendarView['open'][number];

export function CalendarPage({
  workspaceId,
  calendar: c,
  openPostId,
  look,
  day,
}: {
  workspaceId: string;
  calendar: CalendarView;
  openPostId: string | null;
  look: CalendarLook;
  /** A day in the week or month shown (today on List). */
  day: string;
}) {
  useLiveRefresh(['custom_record', 'socialcontent_settings', 'socialcontent_idea']);
  const { busy, act } = useAct();
  const router = useRouter();
  const pathname = usePathname();
  const api = apiBrowser();
  const [openId, setOpenId] = useState<string | null>(openPostId);
  const [fetched, setFetched] = useState<Content | null>(null);
  const [removing, setRemoving] = useState<Content | null>(null);
  // Write a post's two questions are up (the owner, 14 Nov).
  const [asking, setAsking] = useState(false);
  // Picking many posts, and which kind of post shows (the owner, 15 Nov).
  const [selecting, setSelecting] = useState(false);
  const [filter, setFilter] = useState<ShowFilter>('all');
  const { picked, pick, clear } = usePicked();
  // Deleting a post is archiving its record: owners and admins (records.archive). One going up waits till it's done.
  const canRemove = useCan('records.archive');
  const removable = (p: Content) =>
    canRemove && p.state !== 'posting' && !selecting ? () => setRemoving(p) : undefined;

  const all = useMemo(
    () => [...c.posts, ...c.undated, ...c.recent],
    [c.posts, c.undated, c.recent],
  );
  const open = all.find((p) => p.id === openId) ?? (fetched?.id === openId ? fetched : null);

  // What's picked, as it stands now on the page (one may have gone up since it was picked).
  const byId = new Map(all.map((p) => [p.id, p]));
  const items = [...picked.values()].map((p) => {
    const now = byId.get(p.id);
    return now ? itemOf(now) : p;
  });
  const isPicked = (id: string) => picked.has(id);
  const pickPosts = (posts: readonly Content[], on: boolean) => pick(posts.map(itemOf), on);
  const stopSelecting = () => {
    setSelecting(false);
    clear();
  };

  // A post asked for that isn't on the page (an older one, or one further ahead) is read on its own.
  useEffect(() => {
    if (!openId || all.some((p) => p.id === openId)) return;
    let gone = false;
    api
      .POST('/v1/queries/socialcontent.content.get', { body: { workspaceId, postId: openId } })
      .then(unwrap)
      .then((p) => !gone && setFetched(p))
      .catch(() => !gone && setOpenId(null));
    return () => {
      gone = true;
    };
  }, [openId, all, api, workspaceId]);

  // The address keeps the look and the day, so a post opened and closed comes back to the same place.
  const addressOf = (l: CalendarLook, d: string | null, post: string | null) => {
    const q = new URLSearchParams();
    if (l !== 'list') q.set('look', l);
    if (l !== 'list' && d) q.set('day', d);
    if (post) q.set('post', post);
    return q.size ? `${pathname}?${q}` : pathname;
  };
  const show = (id: string | null) => {
    setOpenId(id);
    router.replace(addressOf(look, day, id), { scroll: false });
  };
  const go = (l: CalendarLook, d: string | null) => {
    rememberLook(l);
    router.push(l === 'list' ? `${pathname}?look=list` : addressOf(l, d, null), { scroll: false });
  };

  const end = addDays(c.from, c.days);
  const month = monthOf(day);
  // Moving between looks keeps today when it's shown, else the week or month being looked at.
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
  const step = (by: -1 | 1) =>
    look === 'week' ? go('week', addDays(c.from, by * 7)) : go('month', monthMoved(month, by));

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
  const openByDay = new Map<string, Slot[]>();
  if (filter === 'all')
    for (const o of c.open) openByDay.set(o.date, [...(openByDay.get(o.date) ?? []), o]);
  const undated = c.undated.filter(shown);
  const recent = c.recent.filter(shown);
  // What "Pick the whole week / all of November / everything shown" picks.
  const scope =
    look === 'list'
      ? [...days.flatMap((d) => byDay.get(d) ?? []), ...undated, ...recent]
      : look === 'month'
        ? days.filter((d) => monthOf(d) === month).flatMap((d) => byDay.get(d) ?? [])
        : days.flatMap((d) => byDay.get(d) ?? []);
  const scopeAll = scope.length > 0 && scope.every((p) => isPicked(p.id));
  const scopeLabel =
    look === 'week'
      ? W.picking.pickWeek
      : look === 'month'
        ? W.picking.pickMonth(monthName(month))
        : W.picking.pickShown;

  const fill = () =>
    act(
      'fill',
      () => workerPost<{ open: number }>(FILL, { workspaceId, input: {} }),
      (out) => (out.open ? W.calendar.fillAsked : W.calendar.fillNothing),
    );
  const autoFill = (on: boolean) =>
    act(
      'autoFill',
      () =>
        api
          .POST('/v1/commands/socialcontent.settings.save', {
            body: { workspaceId, autoFill: on },
          })
          .then(unwrap),
      on ? W.calendar.fillStarted : W.calendar.fillStopped,
    );
  const okWeek = () =>
    act(
      'week',
      () =>
        api
          .POST('/v1/commands/socialcontent.content.approve_week', { body: { workspaceId } })
          .then(unwrap),
      (out) => W.calendar.approvedWeek(out.approved, out.notReady.length),
    );
  const write = (network: PostingNetwork | null, postAt: string | null, key: string) =>
    act(
      key,
      () =>
        workerPost<{ postId: string }>(WRITE, {
          workspaceId,
          input: { ...(network ? { network } : {}), ...(postAt ? { postAt } : {}) },
        }),
      W.calendar.written,
    ).then((out) => {
      if (out?.postId) show(out.postId);
    });
  const writeOpen = (o: Slot) => void write(o.network, o.at, `open:${o.network}:${o.at}`);
  // Write a post: one post for each network picked, about the same thing (the owner, 14 Nov).
  const writeFor = (networks: readonly PostingNetwork[], ask: string | null) =>
    act(
      'write',
      () =>
        workerPost<{ postId: string; postIds?: string[]; missed?: PostingNetwork[] }>(WRITE, {
          workspaceId,
          input: { networks, ...(ask ? { ask } : {}) },
        }),
      (out) =>
        networks.length > 1
          ? W.calendar.writtenMany(out.postIds?.length ?? 1, (out.missed ?? []).map(networkName))
          : W.calendar.written,
    ).then((out) => {
      // One post opens; several show on their days.
      if (out?.postId && networks.length === 1) show(out.postId);
      return out;
    });

  const filled = filledLine(c);
  const drafts = c.posts.filter((p) => p.state === 'draft').length;
  const row = (p: Content, withDay = false) => (
    <PostRow
      key={p.id}
      workspaceId={workspaceId}
      post={p}
      timeZone={c.timeZone}
      withDay={withDay}
      onOpen={() => (selecting ? pickPosts([p], !isPicked(p.id)) : show(p.id))}
      onRemove={removable(p)}
      pick={
        selecting ? { checked: isPicked(p.id), onChange: (on) => pickPosts([p], on) } : undefined
      }
    />
  );
  const grid = {
    today: c.today,
    timeZone: c.timeZone,
    byDay,
    openByDay,
    selecting,
    isPicked,
    onPick: pickPosts,
    onOpen: (p: Content) => show(p.id),
  };

  return (
    <div data-testid="socialcontent-calendar" className="space-y-5">
      <PageHeader
        title={W.calendar.title}
        description={W.calendar.intro}
        actions={
          <div className="flex flex-wrap gap-2">
            {c.autoFill && c.offerLive ? (
              <Button
                loading={busy === 'fill'}
                disabled={busy !== null && busy !== 'fill'}
                onClick={() => void fill()}
                data-testid="socialcontent-calendar-fill"
              >
                <CalendarPlus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                {busy === 'fill' ? W.calendar.filling : W.calendar.fill}
              </Button>
            ) : null}
            {drafts && look === 'list' ? (
              <Button
                variant="secondary"
                loading={busy === 'week'}
                disabled={busy !== null && busy !== 'week'}
                onClick={() => void okWeek()}
                data-testid="socialcontent-calendar-ok-week"
              >
                <CalendarCheck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                {W.calendar.approveWeek}
              </Button>
            ) : null}
            {c.offerLive ? (
              <Button
                variant="secondary"
                loading={busy === 'write'}
                disabled={busy !== null && busy !== 'write'}
                onClick={() => setAsking(true)}
                data-testid="socialcontent-calendar-write"
              >
                <PenLine className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                {busy === 'write' ? W.calendar.writing : W.calendar.write}
              </Button>
            ) : null}
          </div>
        }
      />

      {/* No posts are written until the main offer is live (pick 7b). */}
      {c.offerLive ? null : <OfferNotLive workspaceId={workspaceId} />}

      <Card className="p-4 md:p-5">
        <div className="flex items-start gap-3">
          <p
            className="min-w-0 flex-1 text-[13.5px] text-text-2"
            data-testid="socialcontent-calendar-filled"
          >
            {filled}
            {!c.autoFill && !c.mayManage ? ` ${W.calendar.fillOffWho}` : null}
          </p>
          <span className="flex flex-none items-center gap-2 text-[13px] text-text-2">
            {W.calendar.autoFill}
            <Switch
              checked={c.autoFill}
              onChange={(on) => void autoFill(on)}
              label={W.calendar.autoFill}
              disabled={!c.mayManage || (busy !== null && busy !== 'autoFill')}
              busy={busy === 'autoFill'}
              testId="socialcontent-calendar-auto-fill"
            />
          </span>
        </div>
        <p className="mt-2 text-[12.5px] text-text-3">
          {planShown(c.plan, POSTING_NETWORKS, (n) => networkName(n as PostingNetwork))}
        </p>
        {postingLines(c, (n) => networkName(n as PostingNetwork)).map((l) => (
          <p
            key={l.text}
            className={
              l.warn ? 'mt-2 text-[12.5px] text-warning-text' : 'mt-2 text-[12.5px] text-text-3'
            }
            data-testid="socialcontent-calendar-posting"
          >
            {l.text}
          </p>
        ))}
      </Card>

      <Card className="space-y-4 p-4 md:p-5" data-testid={`socialcontent-look-${look}-shown`}>
        <div className="flex flex-wrap items-center gap-2.5">
          {look === 'list' ? null : (
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label={W.picking.back[look]}
                title={W.picking.back[look]}
                onClick={() => step(-1)}
                data-testid="socialcontent-calendar-back"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => go(look, null)}
                data-testid="socialcontent-calendar-today"
              >
                {W.picking.today}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={W.picking.ahead[look]}
                title={W.picking.ahead[look]}
                onClick={() => step(1)}
                data-testid="socialcontent-calendar-ahead"
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          )}
          <h2
            className="mr-auto text-[17px] font-semibold text-text"
            data-testid="socialcontent-calendar-range"
          >
            {title}
          </h2>
          <Segmented
            value={look}
            onChange={(l) => (l === look ? undefined : go(l, anchor))}
            ariaLabel={W.picking.looksLabel}
            options={CALENDAR_LOOKS.map((l) => ({
              value: l,
              label: W.picking.looks[l],
              testId: `socialcontent-look-${l}`,
            }))}
          />
          <Button
            size="sm"
            variant={selecting ? 'primary' : 'secondary'}
            aria-pressed={selecting}
            onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            data-testid="socialcontent-calendar-select"
          >
            <SquareCheck className="h-3.5 w-3.5" aria-hidden />
            {W.picking.select}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-card bg-card-2 p-2.5">
          {selecting ? (
            <PickMenu
              workspaceId={workspaceId}
              look={look}
              today={c.today}
              from={c.from}
              days={c.days}
              month={month}
              rangeLabel={rangeLabel}
              inRange={c.posts.map((p) => placedOf(p, c.timeZone))}
              onPick={(list) => pick(list, true)}
              onClear={clear}
              anyPicked={picked.size > 0}
            />
          ) : null}
          <div
            role="group"
            aria-label={W.picking.showsLabel}
            className="flex flex-wrap items-center gap-1.5"
          >
            {SHOW_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                data-testid={`socialcontent-show-${f}`}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                  filter === f
                    ? 'border-accent bg-accent-soft text-text'
                    : 'border-border bg-card text-text-2 hover:bg-card-2',
                )}
              >
                {W.picking.shows[f]}
                <span className="text-[12px] tabular-nums text-text-3">{counts[f]}</span>
              </button>
            ))}
          </div>
          {selecting && scope.length ? (
            <Checkbox
              label={scopeLabel}
              checked={scopeAll}
              onChange={(e) => pickPosts(scope, e.currentTarget.checked)}
              className="ml-auto text-[13px]"
              data-testid="socialcontent-pick-scope"
            />
          ) : null}
        </div>

        {look === 'week' ? (
          <WeekGrid {...grid} from={c.from} onWrite={writeOpen} busy={busy} />
        ) : look === 'month' ? (
          <>
            <MonthGrid
              {...grid}
              from={c.from}
              month={month}
              onOpenWeek={(d) => go('week', d)}
              onWrite={writeOpen}
              busy={busy}
            />
            <Legend hint={selecting ? W.picking.monthHint : null} />
          </>
        ) : (
          <div className="space-y-4">
            {!c.posts.length && !c.undated.length && !c.open.length ? (
              <p className="text-[13.5px] text-text-2">{W.calendar.empty}</p>
            ) : !scope.length && !openByDay.size ? (
              <p className="text-[13.5px] text-text-2">{W.picking.nothingShown}</p>
            ) : null}
            {days.map((d) => {
              const posts = byDay.get(d) ?? [];
              const free = openByDay.get(d) ?? [];
              if (!posts.length && !free.length) return null;
              const n = posts.filter((p) => isPicked(p.id)).length;
              return (
                <section key={d} data-testid={`socialcontent-day-${d}`}>
                  <div className="mb-2 flex items-center gap-2.5">
                    {selecting && posts.length ? (
                      <Checkbox
                        label={
                          <span className="sr-only">{W.picking.pickDay(fmtDateShort(d))}</span>
                        }
                        checked={n === posts.length}
                        onChange={(e) => pickPosts(posts, e.currentTarget.checked)}
                        className="flex-none gap-0"
                        data-testid={`socialcontent-pick-day-${d}`}
                      />
                    ) : null}
                    <h2 className="text-[13px] font-semibold text-text-2">
                      {dayShown(d, c.today)}
                      {d === c.today || d === addDays(c.today, 1) ? (
                        <span className="ml-2 font-normal text-text-3">{fmtDateShort(d)}</span>
                      ) : null}
                    </h2>
                    {selecting && posts.length ? (
                      <span
                        className={cn(
                          'ml-auto text-[12.5px] tabular-nums',
                          n ? 'text-accent' : 'text-text-3',
                        )}
                      >
                        {W.picking.dayPicked(n, posts.length)}
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    {posts.map((p) => row(p))}
                    {/* An open place: pressing anywhere on it writes its post (the owner, 15 Nov). */}
                    {free.map((o) => {
                      const key = `open:${o.network}:${o.at}`;
                      return (
                        <button
                          key={`${o.network}:${o.at}`}
                          type="button"
                          disabled={selecting || busy !== null}
                          onClick={() => writeOpen(o)}
                          aria-label={W.calendar.writeOpen(
                            networkName(o.network),
                            timeIn(o.at, c.timeZone),
                          )}
                          className={cn(
                            'flex w-full flex-wrap items-center gap-3 rounded-card border border-dashed border-border-strong px-4 py-3 text-left transition-colors',
                            selecting
                              ? 'ml-[30px] w-[calc(100%-30px)] cursor-default'
                              : 'hover:border-accent hover:bg-accent-soft disabled:opacity-60',
                          )}
                          data-testid={`socialcontent-open-${o.network}-${o.date}`}
                        >
                          <span className="text-[13px] text-text-3">{W.calendar.open}</span>
                          <span className="text-[13.5px] text-text-2">
                            {W.calendar.openHint(networkName(o.network), timeIn(o.at, c.timeZone))}
                          </span>
                          {selecting ? (
                            <span className="text-[12.5px] text-text-3">
                              {W.picking.openNoPick}
                            </span>
                          ) : o.trying ? (
                            <span className="text-[12.5px] text-text-3">{W.calendar.trying}</span>
                          ) : null}
                          {selecting ? null : (
                            <span className="ml-auto inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
                              {busy === key ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                              ) : (
                                <Plus className="h-3.5 w-3.5" aria-hidden />
                              )}
                              {busy === key ? W.calendar.writing : W.calendar.writeFor}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}

            {undated.length ? (
              <section data-testid="socialcontent-undated">
                <h2 className="mb-2 text-[13px] font-semibold text-text-2">{W.calendar.undated}</h2>
                <div className="space-y-2">{undated.map((p) => row(p))}</div>
              </section>
            ) : null}

            {recent.length ? (
              <section data-testid="socialcontent-recent">
                <div className="mb-2 flex items-center gap-2.5">
                  {selecting ? (
                    <Checkbox
                      label={<span className="sr-only">{W.picking.pickLately}</span>}
                      checked={recent.every((p) => isPicked(p.id))}
                      onChange={(e) => pickPosts(recent, e.currentTarget.checked)}
                      className="flex-none gap-0"
                      data-testid="socialcontent-pick-recent"
                    />
                  ) : null}
                  <h2 className="text-[13px] font-semibold text-text-2">
                    {W.calendar.recent}
                    <span className="ml-2 font-normal text-text-3">{W.picking.latelyHint}</span>
                  </h2>
                  {selecting ? (
                    <span className="ml-auto text-[12.5px] tabular-nums text-text-3">
                      {W.picking.pickedOfShown(
                        recent.filter((p) => isPicked(p.id)).length,
                        recent.length,
                      )}
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">{recent.map((p) => row(p, true))}</div>
                {selecting ? (
                  <p className="mt-2 text-[12.5px] text-text-3">{W.picking.olderHint}</p>
                ) : null}
              </section>
            ) : null}
          </div>
        )}
      </Card>

      {selecting ? (
        <PickBar
          workspaceId={workspaceId}
          items={items}
          canRemove={canRemove}
          onDone={clear}
          onCancel={stopSelecting}
        />
      ) : null}

      {open ? (
        <PostSheet
          key={open.id}
          workspaceId={workspaceId}
          post={open}
          timeZone={c.timeZone}
          facebookPage={c.facebookPage}
          link={c.link}
          onClose={() => show(null)}
        />
      ) : null}
      <RemovePostDialog
        workspaceId={workspaceId}
        post={removing}
        onClose={() => setRemoving(null)}
      />
      {asking ? (
        <WritePostDialog
          plan={c.plan}
          busy={busy === 'write'}
          onClose={() => setAsking(false)}
          onWrite={(networks, ask) =>
            void writeFor(networks, ask).then((out) => {
              // Written, it opens; refused, the questions stay up to change.
              if (out) setAsking(false);
            })
          }
        />
      ) : null}
    </div>
  );
}

/**
 * Write a post's two questions (the owner, 14 Nov): which networks, one or more, starting on the first with posts in
 * the plan, and whether the AI writes it on its own (the same mix Fill the calendar uses) or from what the person says
 * it's about. Each network gets its own post, written to fit it.
 */
function WritePostDialog({
  plan,
  busy,
  onClose,
  onWrite,
}: {
  plan: CalendarView['plan'];
  busy: boolean;
  onClose: () => void;
  onWrite: (networks: readonly PostingNetwork[], ask: string | null) => void;
}) {
  const [networks, setNetworks] = useState<readonly PostingNetwork[]>(() => [
    firstPlannedNetwork(plan),
  ]);
  const [how, setHow] = useState<'auto' | 'mine'>('auto');
  const [about, setAbout] = useState('');
  const ready = networks.length > 0 && (how === 'auto' || about.trim().length > 0);
  const flip = (n: PostingNetwork) =>
    setNetworks((now) =>
      now.includes(n)
        ? now.filter((x) => x !== n)
        : POSTING_NETWORKS.filter((x) => x === n || now.includes(x)),
    );
  return (
    <Dialog open onOpenChange={(open) => (open || busy ? null : onClose())}>
      <DialogContent title={W.calendar.write} description={W.calendar.writeAsk}>
        <div data-testid="socialcontent-write-dialog">
          <p
            id="socialcontent-write-network"
            className="mb-1.5 mt-4 text-[13px] font-medium text-text"
          >
            {W.calendar.writeNetwork}
          </p>
          <div
            role="group"
            aria-labelledby="socialcontent-write-network"
            className="flex flex-wrap gap-1.5"
          >
            {POSTING_NETWORKS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={networks.includes(n)}
                disabled={busy}
                onClick={() => flip(n)}
                data-testid={`socialcontent-write-network-${n}`}
                className={cn(
                  'h-8 rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                  networks.includes(n)
                    ? 'border-accent bg-accent-soft text-text'
                    : 'border-border bg-card text-text-2 hover:bg-card-2',
                )}
              >
                {networkName(n)}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[12.5px] text-text-3">{W.calendar.writeNetworkHint}</p>

          <p id="socialcontent-write-how" className="mb-1.5 mt-4 text-[13px] font-medium text-text">
            {W.calendar.writeHow}
          </p>
          <div
            role="radiogroup"
            aria-labelledby="socialcontent-write-how"
            className="flex flex-col gap-2"
          >
            <RadioCard
              selected={how === 'auto'}
              onSelect={() => setHow('auto')}
              title={W.calendar.writeAuto}
              description={W.calendar.writeAutoHint}
              testId="socialcontent-write-auto"
            />
            <RadioCard
              selected={how === 'mine'}
              onSelect={() => setHow('mine')}
              title={W.calendar.writeMine}
              description={W.calendar.writeMineHint}
              testId="socialcontent-write-mine"
            />
          </div>
          {how === 'mine' ? (
            <Field
              label={W.calendar.writeAbout}
              htmlFor="socialcontent-write-about"
              className="mt-3.5"
            >
              <Textarea
                id="socialcontent-write-about"
                value={about}
                rows={3}
                maxLength={CALENDAR.askMost}
                placeholder={W.calendar.writeAboutPlaceholder}
                disabled={busy}
                autoFocus
                onChange={(e) => setAbout(e.target.value)}
                data-testid="socialcontent-write-about"
              />
            </Field>
          ) : null}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              {W.calendar.writeCancel}
            </Button>
            <Button
              loading={busy}
              disabled={!ready}
              onClick={() => onWrite(networks, how === 'mine' ? about.trim() : null)}
              data-testid="socialcontent-write-go"
            >
              <PenLine className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              {busy ? W.calendar.writing : W.calendar.writeGo(networks.length)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PostRow({
  workspaceId,
  post: p,
  timeZone,
  withDay,
  onOpen,
  onRemove,
  pick,
}: {
  workspaceId: string;
  post: Content;
  timeZone: string;
  /** Lately's posts say their day too. */
  withDay: boolean;
  /** Opens it, or while picking, picks it. */
  onOpen: () => void;
  /** Takes it off the calendar, after asking; absent for those who can't, one going up, or while picking. */
  onRemove?: () => void;
  /** Picking many posts (the owner, 15 Nov): its tick. */
  pick?: { checked: boolean; onChange: (on: boolean) => void };
}) {
  const first = p.pictures[0];
  // A post that went up: its latest numbers, or that it did well, in one line.
  const numbers = numbersLines(p, (n) => networkName(n as PostingNetwork)).at(-1);
  const picked = pick?.checked ?? false;
  return (
    <div className="relative flex items-start gap-3">
      {pick ? (
        <Checkbox
          label={<span className="sr-only">{W.picking.pickPost(p.title)}</span>}
          checked={pick.checked}
          onChange={(e) => pick.onChange(e.currentTarget.checked)}
          className="mt-5 flex-none gap-0"
          data-testid={`socialcontent-post-${p.id}-pick`}
        />
      ) : null}
      <div
        className={cn(
          'min-w-0 flex-1 rounded-card border bg-card transition-colors',
          picked ? 'border-accent bg-accent-soft' : 'border-border',
          p.hidden && 'border-dashed',
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          aria-pressed={pick ? picked : undefined}
          className={cn(
            'flex w-full min-w-0 items-start gap-3 rounded-card px-4 py-3 text-left hover:bg-card-2/60',
            (p.state === 'skipped' || p.hidden) && 'opacity-60',
            onRemove && 'pr-12',
          )}
          data-testid={`socialcontent-post-${p.id}`}
        >
          <div className="h-[60px] w-12 flex-none overflow-hidden rounded-md bg-card-2">
            {first ? <PostPicture picture={first} className="h-full w-full object-cover" /> : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-text-3">
              <span>{networkName(p.network)}</span>
              {p.postAt ? <span>{timeIn(p.postAt, timeZone, withDay)}</span> : null}
              <span>{W.post.formats[p.format]}</span>
              <Badge variant={STATE_BADGE[p.state]}>{W.post.states[p.state]}</Badge>
              {p.hidden ? <Badge variant="gray">{W.picking.hiddenBadge}</Badge> : null}
              {p.pictureState === 'waiting' || p.pictureState === 'making' ? (
                <span>{W.post.pictureStates.making}</span>
              ) : null}
            </div>
            <div className="mt-1 truncate text-[14px] font-medium text-text">{p.title}</div>
            <div className="mt-0.5 line-clamp-2 text-[13px] text-text-2">
              {p.hook ?? p.words.split('\n')[0]}
            </div>
            {p.state === 'draft' && p.stillNeeds ? (
              <div className="mt-1 text-[12.5px] text-warning-text">{p.stillNeeds}</div>
            ) : null}
            {p.state === 'failed' && p.failure ? (
              <div className="mt-1 line-clamp-2 text-[12.5px] text-danger-text">{p.failure}</div>
            ) : null}
            {numbers ? (
              <div
                className={`mt-1 text-[12.5px] ${numbers.well ? 'text-success-text' : 'text-text-3'}`}
                data-testid={`socialcontent-post-${p.id}-numbers`}
              >
                {numbers.text}
              </div>
            ) : null}
          </div>
        </button>
        {/* A post that didn't post: Try again, Check if it posted, Mark as posted (the owner, 15 Nov). */}
        {pick ? null : (
          <DidntPost
            workspaceId={workspaceId}
            post={p}
            timeZone={timeZone}
            className="-mt-1 px-4 pb-3 pl-[76px]"
          />
        )}
      </div>
      {onRemove ? (
        <Button
          size="icon"
          variant="ghost"
          className="absolute right-2 top-2"
          onClick={onRemove}
          aria-label={W.post.removeLabel(p.title)}
          title={W.post.remove}
          data-testid={`socialcontent-post-${p.id}-remove`}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}
