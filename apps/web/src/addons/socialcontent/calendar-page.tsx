'use client';
/**
 * Calendar (docs/socialcontent.md, "Making posts"; decisions 13 to 20): the business's own posts for today and the
 * two weeks after, day by day, written by the AI from the Playbook and saved ideas. Each waits for an OK (decision
 * 15): open one to change it, OK it or skip it, or **OK the week** in one go. Open days in the plan show where a post
 * is still wanted; **Fill the calendar** has the AI write them all, and after the first time it tops up once a week
 * on its own (decision 18), until **Fill on its own** is turned off (the owner, 11 Nov). OK'd posts go up at their
 * times from the reading computer (part 9), and the card says whose computer that is and when it last checked in.
 * Until the main offer is live, nothing is written, and the page says so (pick 7b, 11 Nov).
 */
import { addDays, localDateOf } from '@hfos/core';
import { POSTING_NETWORKS, type PostingNetwork } from '@hfos/core/addons/socialcontent/calendar';
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import {
  SOCIALCONTENT_WORDS as W,
  dayShown,
  filledLine,
  numbersLines,
  planShown,
  postingLines,
} from '@hfos/core/addons/socialcontent/words';
import { CalendarCheck, CalendarPlus, PenLine } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { OfferNotLive } from './offer-notice';
import { PostPicture, PostSheet, STATE_BADGE, timeIn } from './post-sheet';
import type { CalendarView, Content } from './types';
import { useAct } from './use-act';

const WRITE = '/v1/addons/socialcontent/actions/socialcontent.content.write';
const FILL = '/v1/addons/socialcontent/actions/socialcontent.calendar.fill';

export function CalendarPage({
  workspaceId,
  calendar: c,
  openPostId,
}: {
  workspaceId: string;
  calendar: CalendarView;
  openPostId: string | null;
}) {
  useLiveRefresh(['custom_record', 'socialcontent_settings', 'socialcontent_idea']);
  const { busy, act } = useAct();
  const router = useRouter();
  const pathname = usePathname();
  const api = apiBrowser();
  const [openId, setOpenId] = useState<string | null>(openPostId);
  const [fetched, setFetched] = useState<Content | null>(null);

  const all = useMemo(
    () => [...c.posts, ...c.undated, ...c.recent],
    [c.posts, c.undated, c.recent],
  );
  const open = all.find((p) => p.id === openId) ?? (fetched?.id === openId ? fetched : null);

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

  const show = (id: string | null) => {
    setOpenId(id);
    router.replace(id ? `${pathname}?post=${id}` : pathname, { scroll: false });
  };

  const days = Array.from({ length: c.days }, (_, i) => addDays(c.from, i));
  const byDay = new Map<string, Content[]>();
  for (const p of c.posts) {
    if (!p.postAt) continue;
    const day = localDateOf(Date.parse(p.postAt), c.timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), p]);
  }
  const openByDay = new Map<string, CalendarView['open']>();
  for (const o of c.open) openByDay.set(o.date, [...(openByDay.get(o.date) ?? []), o]);

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

  const filled = filledLine(c);
  const drafts = c.posts.filter((p) => p.state === 'draft').length;

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
            {drafts ? (
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
                onClick={() => void write(null, null, 'write')}
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

      {!c.posts.length && !c.undated.length && !c.open.length ? (
        <p className="text-[13.5px] text-text-2">{W.calendar.empty}</p>
      ) : null}

      <div className="space-y-4">
        {days.map((day) => {
          const posts = byDay.get(day) ?? [];
          const free = openByDay.get(day) ?? [];
          if (!posts.length && !free.length) return null;
          return (
            <section key={day} data-testid={`socialcontent-day-${day}`}>
              <h2 className="mb-2 text-[13px] font-semibold text-text-2">
                {dayShown(day, c.today)}
              </h2>
              <div className="space-y-2">
                {posts.map((p) => (
                  <PostRow key={p.id} post={p} timeZone={c.timeZone} onOpen={() => show(p.id)} />
                ))}
                {free.map((o) => (
                  <div
                    key={`${o.network}:${o.date}`}
                    className="flex flex-wrap items-center gap-3 rounded-card border border-dashed border-border-strong px-4 py-3"
                    data-testid={`socialcontent-open-${o.network}-${o.date}`}
                  >
                    <span className="text-[13px] text-text-3">{W.calendar.open}</span>
                    <span className="text-[13.5px] text-text-2">
                      {W.calendar.openHint(networkName(o.network), timeIn(o.at, c.timeZone))}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      loading={busy === `open:${o.network}:${o.date}`}
                      disabled={busy !== null && busy !== `open:${o.network}:${o.date}`}
                      onClick={() => void write(o.network, o.at, `open:${o.network}:${o.date}`)}
                    >
                      {W.calendar.writeFor}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {c.undated.length ? (
        <section data-testid="socialcontent-undated">
          <h2 className="mb-2 text-[13px] font-semibold text-text-2">{W.calendar.undated}</h2>
          <div className="space-y-2">
            {c.undated.map((p) => (
              <PostRow key={p.id} post={p} timeZone={c.timeZone} onOpen={() => show(p.id)} />
            ))}
          </div>
        </section>
      ) : null}

      {c.recent.length ? (
        <section data-testid="socialcontent-recent">
          <h2 className="mb-2 text-[13px] font-semibold text-text-2">{W.calendar.recent}</h2>
          <div className="space-y-2">
            {c.recent.map((p) => (
              <PostRow key={p.id} post={p} timeZone={c.timeZone} onOpen={() => show(p.id)} />
            ))}
          </div>
        </section>
      ) : null}

      {open ? (
        <PostSheet
          key={open.id}
          workspaceId={workspaceId}
          post={open}
          timeZone={c.timeZone}
          facebookPage={c.facebookPage}
          onClose={() => show(null)}
        />
      ) : null}
    </div>
  );
}

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
  const numbers = numbersLines(p, (n) => networkName(n as PostingNetwork)).at(-1);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full items-start gap-3 rounded-card border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-card-2 ${p.state === 'skipped' ? 'opacity-60' : ''}`}
      data-testid={`socialcontent-post-${p.id}`}
    >
      <div className="h-[60px] w-12 flex-none overflow-hidden rounded-md bg-card-2">
        {first ? <PostPicture picture={first} className="h-full w-full object-cover" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-text-3">
          <span>{networkName(p.network)}</span>
          {p.postAt ? <span>{timeIn(p.postAt, timeZone)}</span> : null}
          <span>{W.post.formats[p.format]}</span>
          <Badge variant={STATE_BADGE[p.state]}>{W.post.states[p.state]}</Badge>
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
  );
}
