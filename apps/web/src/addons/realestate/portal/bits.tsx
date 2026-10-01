'use client';
/**
 * Pieces Real Estate's portal pages share: a task the client does (upload, sign off, or mark done), a home to save
 * or pass on, and the words for days and homes. In the client's words, never the office's.
 */
import { fmtDateLong, fmtDateShort, localDayOf, money } from '@hfos/core';
import { Check, Circle, ExternalLink, Heart, Home as HomeIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { usePortal, usePortalAct } from '@/components/portal/context';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PortalDeal, PortalHome, PortalTask, PortalTour } from './types';

/** Times in the portal read in the client's own zone. */
export const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const street = (address: string) => address.split(',')[0]!.trim() || address;
export const firstName = (name: string | null) => (name ?? 'your agent').split(/\s+/)[0]!;

/** "Saturday", for "Saturday’s tour". */
export const weekday = (at: string) => fmtDateLong(localDayOf(at, zone())).split(',')[0]!;

/** "$409,000 · 3 bd · 2 ba · 1,780 sq ft": what's known. */
export function factsLine(f: Readonly<Record<string, unknown>>): string {
  const n = (k: string) => (typeof f[k] === 'number' ? (f[k] as number) : null);
  return [
    n('price_cents') !== null ? money(n('price_cents')!) : null,
    n('beds') !== null ? `${n('beds')} bd` : null,
    n('baths') !== null ? `${n('baths')} ba` : null,
    n('sqft') !== null ? `${n('sqft')!.toLocaleString('en-US')} sq ft` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Tours whose homes they saw and haven't said anything about yet: a to-do each. */
export function feedbackDue(tours: readonly PortalTour[]): PortalTour[] {
  return tours.filter((t) => t.stops.some((s) => s.status === 'visited' && !s.myFeedback));
}

/** The next planned tour, if there is one. */
export const nextTour = (tours: readonly PortalTour[]) =>
  [...tours]
    .filter((t) => t.status === 'planned' && Date.parse(t.endsAt) > Date.now())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];

export function Done() {
  return (
    <span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-success text-on-solid">
      <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
    </span>
  );
}

/** One thing the client does: upload a file, sign off on exact words, or mark it done. */
export function TaskRow({
  task: t,
  dealId,
  onDone,
}: {
  task: PortalTask;
  dealId: string;
  onDone: () => void;
}) {
  const { op, upload } = usePortal();
  const { busy, act } = usePortalAct(onDone);
  const [reading, setReading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const finished = t.status === 'done' || t.mine;
  const send = (f: File) =>
    act(
      'upload',
      async () => {
        const up = await upload(f, dealId);
        if (!up.accepted)
          throw new Error(up.refusal ?? 'That file can’t be added. Try a PDF or a photo.');
        await op('realestate.portal.task.attach', { taskId: t.id, fileId: up.fileId });
      },
      'Uploaded. Your agent can see it now.',
    );
  return (
    <li className="py-2.5" data-testid="portal-task">
      <div className="flex items-start gap-3">
        {finished ? (
          <Done />
        ) : (
          <Circle className="h-6 w-6 flex-none text-border-strong" strokeWidth={1.5} />
        )}
        <div className="min-w-0 flex-1">
          <div className={cn('text-[14px]', finished && 'text-text-2')}>{t.title}</div>
          {!finished && t.detail ? (
            <div className="text-[12.5px] text-text-2">{t.detail}</div>
          ) : null}
          {t.mine && t.status === 'open' && t.waiting ? (
            <div className="text-[12.5px] text-text-3">You signed off. {t.waiting}.</div>
          ) : null}
        </div>
        {!finished ? (
          t.kind === 'upload' ? (
            <>
              <input
                ref={file}
                type="file"
                accept="application/pdf,image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void send(f);
                }}
                data-testid="portal-task-file"
              />
              <Button
                size="sm"
                variant="secondary"
                loading={busy === 'upload'}
                onClick={() => file.current?.click()}
              >
                Upload
              </Button>
            </>
          ) : t.kind === 'sign_off' ? (
            <Button size="sm" variant="secondary" onClick={() => setReading(!reading)}>
              {reading ? 'Close' : 'Read and sign'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'do'}
              onClick={() =>
                void act(
                  'do',
                  () => op('realestate.portal.task.complete', { taskId: t.id }),
                  'Done. Your agent can see it.',
                )
              }
            >
              Mark done
            </Button>
          )
        ) : null}
      </div>
      {reading && t.signOffWords ? (
        <div className="ml-9 mt-2 rounded-menu bg-card-2 p-3">
          <p className="whitespace-pre-wrap text-[14px]">{t.signOffWords}</p>
          <Button
            size="sm"
            className="mt-3"
            loading={busy === 'sign'}
            onClick={() =>
              void act(
                'sign',
                () =>
                  op('realestate.portal.task.complete', {
                    taskId: t.id,
                    signedWords: t.signOffWords,
                  }),
                'Signed off. Your agent can see it.',
              )
            }
            data-testid="portal-sign-off"
          >
            I agree
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** A home on their list (board 29): its facts, and their save or pass. */
export function HomeCard({
  home: h,
  tour,
  onChange,
}: {
  home: PortalHome;
  tour?: PortalTour;
  onChange: () => void;
}) {
  const { op } = usePortal();
  const { busy, act } = usePortalAct(onChange);
  const react = (reaction: 'saved' | 'passed') =>
    act(reaction, () => op('realestate.portal.home.react', { homeId: h.id, reaction }));
  return (
    <li
      className="rounded-card border border-border bg-card p-3.5"
      data-testid={`portal-home-${street(h.address)}`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-14 w-14 flex-none items-center justify-center rounded-control bg-card-2 text-text-3">
          <HomeIcon className="h-5 w-5" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{street(h.address)}</div>
          <div className="text-[13px] text-text-2">{factsLine(h.facts) || h.address}</div>
          {h.link ? (
            <a
              href={h.link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-[12.5px] text-accent-text hover:underline"
            >
              See the listing <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
            </a>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          variant={h.mine === 'saved' ? 'primary' : 'secondary'}
          loading={busy === 'saved'}
          onClick={() => void react('saved')}
          aria-pressed={h.mine === 'saved'}
          data-testid="portal-home-save"
        >
          <Heart
            className={cn('h-4 w-4', h.mine === 'saved' && 'fill-current')}
            strokeWidth={1.75}
          />
          {h.mine === 'saved' ? 'Saved' : 'Save'}
        </Button>
        <Button
          variant={h.mine === 'passed' ? 'primary' : 'secondary'}
          loading={busy === 'passed'}
          onClick={() => void react('passed')}
          aria-pressed={h.mine === 'passed'}
          data-testid="portal-home-pass"
        >
          {h.mine === 'passed' ? 'Passed' : 'Pass'}
        </Button>
      </div>
      {tour || h.others.length || h.addedByMe ? (
        <p className="mt-2 text-[12.5px] text-text-2">
          {[
            tour ? `On ${weekday(tour.startsAt)}’s tour` : null,
            h.addedByMe ? 'You added it' : null,
            ...h.others.map((o) => `${o.name} ${o.reaction === 'saved' ? 'saved it' : 'passed'}`),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
    </li>
  );
}

/** Which planned tour a home is on. */
export const tourOf = (deal: PortalDeal, homeId: string) =>
  deal.tours.find((t) => t.status === 'planned' && t.stops.some((s) => s.homeId === homeId));

export { fmtDateShort };
