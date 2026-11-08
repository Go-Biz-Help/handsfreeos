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
import { SOCIALCONTENT_WORDS as W, daysAgo } from '@hfos/core/addons/socialcontent/words';
import { Download } from 'lucide-react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
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
    body: { networks?: ContentNetwork[]; readerUserId?: string | null; watchVideos?: boolean },
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
  const network = networkName(w.network);
  const what =
    w.kind === 'find'
      ? W.work.kinds.find(w.nicheName ?? '', network)
      : W.work.kinds[w.kind](w.creatorShown ?? '', network);
  const done =
    w.state === 'done' && w.doneCount !== null
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
