'use client';
/**
 * Pieces Real Estate's portal pages share: a task the client does (upload, mark done, or open its page to sign off or
 * answer the seller's questions), a home to save or pass on, the steps of their deal, their contingencies, and the
 * words for days and homes. In the client's words, never the office's.
 */
import { fmtDateLong, fmtDateShort, localDayOf, money } from '@hfos/core';
import { Check, Circle, ExternalLink, Heart, Home as HomeIcon } from 'lucide-react';
import Link from 'next/link';
import { useRef } from 'react';
import { usePortal, usePortalAct } from '@/components/portal/context';
import { PortalCardHead } from '@/components/portal/ui';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
  const { op, upload, href } = usePortal();
  const { busy, act } = usePortalAct(onDone);
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
          ) : t.kind === 'sign_off' || t.kind === 'questionnaire' ? (
            // Each has its own page: the exact words to read and approve, or the questions about their home.
            <Link
              href={href(
                `a/realestate/deals/${dealId}/${t.kind === 'sign_off' ? `sign-off/${t.id}` : 'questionnaire'}`,
              )}
              className={buttonClassName({ variant: 'secondary', size: 'sm' })}
              data-testid={
                t.kind === 'sign_off' ? 'portal-sign-off-open' : 'portal-questionnaire-open'
              }
            >
              {t.kind === 'sign_off' ? 'Read and sign' : 'Open'}
            </Link>
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
    </li>
  );
}

/** Where their deal is: each step, the one they're on with its stage, the ones before ticked. */
export function DealSteps({ deal: d }: { deal: PortalDeal['deal'] }) {
  return (
    <ol className="space-y-2.5">
      {d.steps.map((s, i) => (
        <li key={s} className="flex items-center gap-3 text-[14px]">
          {i < d.step ? (
            <Done />
          ) : (
            <span
              className={cn(
                'h-6 w-6 flex-none rounded-full border',
                i === d.step ? 'border-accent bg-accent-soft' : 'border-border-strong',
              )}
            />
          )}
          <span className={cn(i === d.step && 'font-semibold', i > d.step && 'text-text-2')}>
            {s}
            {i === d.step ? ` · ${d.stage}` : ''}
          </span>
        </li>
      ))}
    </ol>
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

/**
 * Their contingencies (round four, board 61): the ways the buyer can still step back, when each ends, and how each
 * ended. Told as what each is for, never as advice.
 */
export function ContingenciesCard({ deal }: { deal: PortalDeal }) {
  const list = deal.contingencies;
  if (!list.length) return null;
  const buying = deal.deal.side === 'buyer';
  return (
    <Card className="p-4" data-testid="portal-contingencies">
      <PortalCardHead>{buying ? 'Your contingencies' : 'The buyers’ contingencies'}</PortalCardHead>
      <p className="-mt-1 mb-2.5 text-[13px] text-text-2">
        {buying
          ? 'The ways you can still step back from buying, and when each ends.'
          : 'The ways the buyers can still step back, and when each ends.'}
      </p>
      <ul className="divide-y divide-border text-[14px]">
        {list.map((c) => (
          <li key={c.id} className="py-2.5 first:pt-0 last:pb-0" data-testid="portal-contingency">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{c.label}</span>
              <Badge variant={c.state === 'open' ? 'pending' : 'ok'}>
                {c.state === 'open' ? 'Open' : 'Done'}
              </Badge>
            </div>
            <div className="text-[13px] text-text-2">{c.words}</div>
            <div className="text-[13px] text-text-3">{c.meaning}</div>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[12.5px] text-text-3">
        Questions? Message {firstName(deal.deal.agentName)}. Nothing here changes your contract.
      </p>
    </Card>
  );
}
