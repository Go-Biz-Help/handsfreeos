'use client';
/**
 * Settings (docs/socialcontent.md, decisions 2, 9, 11 and 12): the networks studied, whose computer reads them,
 * whether the AI watches standout videos (off until someone turns it on, with the notice that it uses a lot more AI,
 * and a way to try it on a few videos first), when it reads on its own, and what that computer was asked to do lately.
 * Owners and admins (`socialcontent.manage`) change the first three; anyone who uses the add-on can stop work that
 * hasn't finished.
 */
import {
  CONTENT_NETWORK_INFO,
  CONTENT_NETWORKS,
  networkName,
  type ContentNetwork,
} from '@hfos/core/addons/socialcontent/networks';
import {
  CALENDAR,
  FACEBOOK_WHERE,
  PLAN_MODES,
  POSTING_NETWORKS,
  type FacebookWhere,
  type NetworkPlan,
  type PostingNetwork,
} from '@hfos/core/addons/socialcontent/calendar';
import type { LearnedShown } from '@hfos/core/addons/socialcontent/schedule';
import {
  SOCIALCONTENT_WORDS as W,
  clockShown,
  daysAgo,
  learnedLine,
} from '@hfos/core/addons/socialcontent/words';
import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { WorkFacts, workWhat } from './activity-card';
import type { Overview, Work } from './types';
import { useAct } from './use-act';

/** The build this web app hands out (apps/extension/scripts/download.mjs); the version only makes browsers fetch anew. */
const EXTENSION_HREF = `/downloads/hfos-social.zip?v=${process.env.HFOS_EXTENSION_VERSION ?? ''}`;

const STATE_BADGE: Record<Work['state'], BadgeVariant> = {
  waiting: 'gray',
  taken: 'pending',
  done: 'ok',
  failed: 'danger',
  stopped: 'gray',
};

export function SettingsPage({
  workspaceId,
  overview,
  myUserId,
}: {
  workspaceId: string;
  overview: Overview;
  myUserId: string;
}) {
  useLiveRefresh(['socialcontent_settings', 'socialcontent_work']);
  const { busy, act } = useAct();
  const api = apiBrowser();
  const { settings, mayManage } = overview;

  const save = (
    key: string,
    body: {
      networks?: ContentNetwork[];
      readerUserId?: string | null;
      watchVideos?: boolean;
      plan?: Partial<Record<PostingNetwork, Partial<NetworkPlan>>>;
      facebookPage?: string | null;
      facebookWhere?: FacebookWhere[];
      autoFill?: boolean;
    },
    done: string = W.settings.saved,
  ) =>
    act(
      key,
      () =>
        api
          .POST('/v1/commands/socialcontent.settings.save', { body: { workspaceId, ...body } })
          .then(unwrap),
      done,
    );
  const watchOn = (on: boolean) => {
    // The notice again before it's turned on: it uses a lot more AI.
    if (on && !window.confirm(`${W.watch.on}?\n\n${W.watch.cost}`)) return;
    void save('watch', { watchVideos: on }, W.settings.watchSaved(on));
  };
  const tryWatching = () =>
    act(
      'try',
      () =>
        api.POST('/v1/commands/socialcontent.watch.try', { body: { workspaceId } }).then(unwrap),
      (out) => W.watch.asked(out.asked),
    );
  const toggle = (n: ContentNetwork, on: boolean) => {
    const next = on ? [...settings.networks, n] : settings.networks.filter((x) => x !== n);
    if (next.length) void save(`network:${n}`, { networks: next });
  };
  const stop = (w: Work) =>
    act(
      `stop:${w.id}`,
      () =>
        api
          .POST('/v1/commands/socialcontent.work.stop', { body: { workspaceId, workId: w.id } })
          .then(unwrap),
      W.settings.stopped,
    );

  const reader = overview.readerIsMe
    ? W.settings.readerMine
    : settings.readerUserId
      ? W.settings.readerIs(settings.readerName)
      : W.settings.readerNone;

  return (
    <div data-testid="socialcontent-settings" className="space-y-5">
      <PageHeader title={W.settings.title} />

      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">{W.settings.networks}</h2>
        <p className="mt-1 text-[13px] text-text-2">{W.settings.networksIntro}</p>
        <div className="mt-3 space-y-2.5">
          {CONTENT_NETWORKS.map((n) => {
            const ready = CONTENT_NETWORK_INFO[n].ready;
            const on = settings.networks.includes(n);
            return (
              <div key={n} className="flex items-center gap-2">
                <Checkbox
                  label={networkName(n)}
                  checked={on}
                  disabled={
                    !ready || !mayManage || busy !== null || (on && settings.networks.length === 1)
                  }
                  onChange={(e) => toggle(n, e.target.checked)}
                  className={ready ? undefined : 'text-text-3'}
                  data-testid={`socialcontent-network-${n}`}
                />
                {!ready ? <Badge>{W.settings.coming}</Badge> : null}
              </div>
            );
          })}
        </div>
        {!mayManage ? (
          <p className="mt-3 text-[12.5px] text-text-3">{W.settings.managersOnly}</p>
        ) : null}
      </Card>

      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">{W.settings.reader}</h2>
        <p className="mt-1 text-[13px] text-text-2">{W.settings.readerIntro}</p>
        <p className="mt-3 text-[14px] font-medium" data-testid="socialcontent-reader">
          {reader}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {mayManage && !overview.readerIsMe ? (
            <Button
              size="sm"
              loading={busy === 'reader'}
              onClick={() => void save('reader', { readerUserId: myUserId })}
              data-testid="socialcontent-read-on-mine"
            >
              {W.settings.readOnMine}
            </Button>
          ) : null}
          <a
            href={EXTENSION_HREF}
            download="hfos-social.zip"
            className={buttonClassName({ variant: 'secondary', size: 'sm' })}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {W.settings.getExtension}
          </a>
          {mayManage && settings.readerUserId ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'reader-off'}
              onClick={() => void save('reader-off', { readerUserId: null })}
            >
              {W.settings.readerStop}
            </Button>
          ) : null}
        </div>
        <p className="mt-3 text-[12.5px] text-text-3">{W.settings.extensionHow}</p>
        {!mayManage ? (
          <p className="mt-1 text-[12.5px] text-text-3">{W.settings.managersOnly}</p>
        ) : null}
      </Card>

      <Card className="p-4 md:p-5" data-testid="socialcontent-watch">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{W.watch.title}</h2>
            <p className="mt-1 text-[13px] text-text-2">{W.watch.intro}</p>
          </div>
          <Switch
            checked={settings.watchVideos}
            onChange={watchOn}
            label={W.watch.on}
            disabled={!mayManage || (busy !== null && busy !== 'watch')}
            busy={busy === 'watch'}
            testId="socialcontent-watch-on"
          />
        </div>
        <p className="mt-3 rounded-card bg-warning-soft p-3 text-[13px] leading-[1.5] text-warning-text">
          {W.watch.cost}
        </p>
        {mayManage ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'try'}
              disabled={busy !== null && busy !== 'try'}
              onClick={() => void tryWatching()}
              data-testid="socialcontent-watch-try"
            >
              {W.watch.tryIt}
            </Button>
            <span className="text-[12.5px] text-text-3">{W.watch.tryHint}</span>
          </div>
        ) : (
          <p className="mt-3 text-[12.5px] text-text-3">{W.settings.managersOnly}</p>
        )}
      </Card>

      <Card className="p-4 md:p-5">
        <p className="text-[13.5px] text-text-2">{W.settings.schedule}</p>
      </Card>

      <PostingCard
        settings={settings}
        learned={overview.learned}
        mayManage={mayManage}
        busy={busy}
        onSave={(key, body) =>
          void save(
            key,
            body,
            body.autoFill === undefined
              ? W.settings.saved
              : body.autoFill
                ? W.calendar.fillStarted
                : W.calendar.fillStopped,
          )
        }
      />

      <Card className="p-4 md:p-5" data-testid="socialcontent-work">
        <h2 className="text-[15px] font-semibold">{W.settings.doing}</h2>
        <p className="mt-1 text-[13px] text-text-2">
          {W.settings.waiting(overview.counts.waiting)}
        </p>
        {overview.work.length === 0 ? (
          <p className="mt-3 text-[13.5px] text-text-2">{W.settings.noWork}</p>
        ) : (
          <ul className="mt-2">
            {overview.work.map((w) => (
              <WorkRow
                key={w.id}
                work={w}
                stopping={busy === `stop:${w.id}`}
                onStop={() => void stop(w)}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function WorkRow({
  work: w,
  stopping,
  onStop,
}: {
  work: Work;
  stopping: boolean;
  onStop: () => void;
}) {
  const what = workWhat(w);
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
    <li
      className="flex flex-wrap items-center gap-2 border-b border-border py-2.5 last:border-b-0"
      data-testid={`socialcontent-work-${w.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-text">{what}</div>
        <div className="text-[12.5px] text-text-3">{facts}</div>
        <WorkFacts work={w} />
        {w.state === 'failed' && w.failure ? (
          <div className="mt-0.5 text-[12.5px] text-danger-text">{w.failure}</div>
        ) : null}
      </div>
      <Badge variant={STATE_BADGE[w.state]}>{W.work.states[w.state]}</Badge>
      {w.state === 'waiting' || w.state === 'taken' ? (
        <Button size="sm" variant="ghost" loading={stopping} onClick={onStop}>
          {W.settings.stop}
        </Button>
      ) : null}
    </li>
  );
}

/** Every half hour of the day, as I pick's times are picked (the phone's post screen picks the same). */
const HALF_HOURS = Array.from(
  { length: 48 },
  (_, k) => `${String(Math.floor(k / 2)).padStart(2, '0')}:${k % 2 ? '30' : '00'}`,
);
const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/**
 * One network's plan (decisions 21, 22 and 24): AI picks (how many a week, the most a day, the hours it posts
 * between, and what it learned) or I pick (the times on each weekday, up to 3 a day).
 */
function PlanRow({
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
  const name = networkName(network);
  const S = W.settings;
  const setDay = (d: number, times: string[]) =>
    onChange({ week: plan.week.map((t, k) => (k === d ? [...times].sort() : t)) });
  // More a week than the most a day allows: the most a day goes up with it.
  const setPerWeek = (perWeek: number) =>
    onChange(
      plan.perDay !== null && perWeek > 7 * plan.perDay
        ? { perWeek, perDay: Math.ceil(perWeek / 7) }
        : { perWeek },
    );
  return (
    <div
      className="rounded-[10px] border border-border p-3"
      data-testid={`socialcontent-plan-${network}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13.5px] font-medium">{name}</span>
        <Segmented
          value={plan.mode}
          onChange={(mode) => {
            if (mode !== plan.mode) onChange({ mode });
          }}
          ariaLabel={S.modeFor(name)}
          options={PLAN_MODES.map((m) => ({
            value: m,
            label: S.modes[m],
            disabled: off,
            testId: `socialcontent-plan-${network}-${m}`,
          }))}
        />
      </div>
      <p className="mt-1 text-[12.5px] text-text-3">{S.modeHints[plan.mode]}</p>
      {plan.mode === 'ai' ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Select
              selectSize="sm"
              className="w-[130px]"
              value={plan.perWeek}
              disabled={off}
              aria-label={S.perWeek(name)}
              onChange={(e) => setPerWeek(Number(e.target.value))}
            >
              {Array.from({ length: CALENDAR.perWeekMost + 1 }, (_, k) => (
                <option key={k} value={k}>
                  {S.perWeekOption(k)}
                </option>
              ))}
            </Select>
            {plan.perWeek > 0 ? (
              <>
                <Select
                  selectSize="sm"
                  className="w-[160px]"
                  value={plan.perDay ?? ''}
                  disabled={off}
                  aria-label={S.perDay(name)}
                  onChange={(e) =>
                    onChange({ perDay: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  {plan.perWeek <= 7 * CALENDAR.perDayMost ? (
                    <option value="">{S.perDayOption(null)}</option>
                  ) : null}
                  {Array.from({ length: CALENDAR.perDayMost }, (_, k) => k + 1)
                    .filter((k) => plan.perWeek <= 7 * k)
                    .map((k) => (
                      <option key={k} value={k}>
                        {S.perDayOption(k)}
                      </option>
                    ))}
                </Select>
                <span className="text-[13px] text-text-3">{S.between}</span>
                <Select
                  selectSize="sm"
                  className="w-[110px]"
                  value={plan.from}
                  disabled={off}
                  aria-label={S.fromFor(name)}
                  onChange={(e) => onChange({ from: e.target.value })}
                >
                  {(HOURS.includes(plan.from) ? HOURS : [plan.from, ...HOURS])
                    .filter((h) => h < plan.to)
                    .map((h) => (
                      <option key={h} value={h}>
                        {clockShown(h)}
                      </option>
                    ))}
                </Select>
                <span className="text-[13px] text-text-3">{S.and}</span>
                <Select
                  selectSize="sm"
                  className="w-[110px]"
                  value={plan.to}
                  disabled={off}
                  aria-label={S.toFor(name)}
                  onChange={(e) => onChange({ to: e.target.value })}
                >
                  {(HOURS.includes(plan.to) ? HOURS : [...HOURS, plan.to])
                    .filter((h) => h > plan.from)
                    .map((h) => (
                      <option key={h} value={h}>
                        {clockShown(h)}
                      </option>
                    ))}
                </Select>
              </>
            ) : null}
          </div>
          {plan.perWeek > 0 && learned ? (
            <p
              className="mt-1.5 text-[12.5px] text-text-2"
              data-testid={`socialcontent-learned-${network}`}
            >
              {learnedLine(learned, plan.time)}
            </p>
          ) : null}
        </>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {S.days.map((day, d) => {
            const times = plan.week[d] ?? [];
            return (
              <li key={day} className="flex flex-wrap items-center gap-1.5">
                <span className="w-10 text-[13px] text-text-2">{day}</span>
                {times.length === 0 ? (
                  <span className="text-[12.5px] text-text-3">{S.noTimes}</span>
                ) : null}
                {times.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-card-2 py-0.5 pl-2 pr-1 text-[12.5px]"
                  >
                    {clockShown(t)}
                    <button
                      type="button"
                      className="rounded-full p-0.5 text-text-3 hover:text-text disabled:opacity-50"
                      aria-label={S.removeTime(day, clockShown(t))}
                      disabled={off}
                      onClick={() =>
                        setDay(
                          d,
                          times.filter((x) => x !== t),
                        )
                      }
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                ))}
                {times.length < CALENDAR.perDayMost ? (
                  <Select
                    selectSize="sm"
                    className="w-[130px]"
                    value=""
                    disabled={off}
                    aria-label={S.addTimeFor(day)}
                    onChange={(e) => {
                      if (e.target.value) setDay(d, [...times, e.target.value]);
                    }}
                  >
                    <option value="">{S.addTime}</option>
                    {HALF_HOURS.filter((h) => !times.includes(h)).map((h) => (
                      <option key={h} value={h}>
                        {clockShown(h)}
                      </option>
                    ))}
                  </Select>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Posting (decisions 17, 18 and 21 to 27): the calendar's plan, whether it fills on its own (the owner's switch, 11 Nov), the
 * business's Facebook Page, and where Facebook posts go.
 */
function PostingCard({
  settings,
  learned,
  mayManage,
  busy,
  onSave,
}: {
  settings: Overview['settings'];
  learned: Overview['learned'];
  mayManage: boolean;
  busy: string | null;
  onSave: (
    key: string,
    body: {
      plan?: Partial<Record<PostingNetwork, Partial<NetworkPlan>>>;
      facebookPage?: string | null;
      facebookWhere?: FacebookWhere[];
      autoFill?: boolean;
    },
  ) => void;
}) {
  const [page, setPage] = useState(settings.facebookPage ?? '');
  const off = !mayManage || busy !== null;
  // Only what changes is sent: the server keeps the rest of the network's plan (and checks it).
  const setPlan = (n: PostingNetwork, change: Partial<NetworkPlan>) =>
    onSave(`plan:${n}`, { plan: { [n]: change } });
  const where = (w: FacebookWhere, on: boolean) => {
    const next = on
      ? [...settings.facebookWhere, w]
      : settings.facebookWhere.filter((x) => x !== w);
    if (next.length) onSave(`where:${w}`, { facebookWhere: next });
  };
  return (
    <Card className="p-4 md:p-5" data-testid="socialcontent-posting">
      <h2 className="text-[15px] font-semibold">{W.settings.posting}</h2>
      <p className="mt-1 text-[13px] text-text-2">{W.settings.postingIntro}</p>
      <div className="mt-3 flex items-start gap-3" data-testid="socialcontent-auto-fill-row">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{W.calendar.autoFill}</div>
          <p className="mt-0.5 text-[12.5px] text-text-3">{W.calendar.autoFillHint}</p>
        </div>
        <Switch
          checked={settings.autoFill}
          onChange={(on) => onSave('autoFill', { autoFill: on })}
          label={W.calendar.autoFill}
          disabled={!mayManage || (busy !== null && busy !== 'autoFill')}
          busy={busy === 'autoFill'}
          testId="socialcontent-auto-fill"
        />
      </div>
      <div className="mt-3 space-y-2.5">
        {POSTING_NETWORKS.map((n) => (
          <PlanRow
            key={n}
            network={n}
            plan={settings.plan[n]}
            learned={learned?.[n]}
            off={off}
            onChange={(change) => setPlan(n, change)}
          />
        ))}
      </div>
      <div className="mt-4">
        <div className="text-[13.5px] font-medium">{W.settings.facebookPage}</div>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Input
            inputSize="sm"
            className="min-w-0 flex-1"
            value={page}
            placeholder="https://www.facebook.com/yourpage"
            disabled={!mayManage}
            onChange={(e) => setPage(e.target.value)}
          />
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'page'}
            disabled={off || page.trim() === (settings.facebookPage ?? '')}
            onClick={() => onSave('page', { facebookPage: page.trim() || null })}
          >
            {W.settings.savePage}
          </Button>
        </div>
      </div>
      <div className="mt-4">
        <div className="text-[13.5px] font-medium">{W.settings.facebookWhere}</div>
        <div className="mt-1.5 flex flex-wrap gap-4">
          {FACEBOOK_WHERE.map((w) => (
            <Checkbox
              key={w}
              label={W.post.facebookWhereOptions[w]}
              checked={settings.facebookWhere.includes(w)}
              disabled={
                off || (settings.facebookWhere.includes(w) && settings.facebookWhere.length === 1)
              }
              onChange={(e) => where(w, e.target.checked)}
            />
          ))}
        </div>
      </div>
      {!mayManage ? (
        <p className="mt-3 text-[12.5px] text-text-3">{W.settings.managersOnly}</p>
      ) : null}
    </Card>
  );
}
