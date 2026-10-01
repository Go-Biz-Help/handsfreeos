'use client';
/**
 * A buyer deal's tours: each on the calendar with its homes in order, which were seen, and what each client
 * thought. `?plan=1` opens Plan a tour (board 17), with `&home=<id>` to start from one home.
 */
import { fmtMonthDay, localInstant, minutesToClock } from '@hfos/core';
import {
  STOP_STATUSES,
  TOUR_INTEREST,
  TOUR_INTEREST_KEYS,
  TOUR_STATUSES,
  type TourInterest,
} from '@hfos/core/addons/realestate/tours';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { dateOf, fmtWhen, minutesOf, TIME_OPTIONS } from '@/lib/calendar/time';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { DealCrumb, firstNames, street } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import { PlanTourDialog, type CalendarChoice } from './plan-tour';
import type { Home, Tour, TourList, TourStop } from './types';
import { useAct } from './use-act';

export interface DealClientRef {
  readonly personId: string;
  readonly name: string;
}

export function ToursPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  tours,
  homes,
  calendars,
  team,
  clients,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  tours: TourList;
  homes: readonly Home[];
  calendars: readonly CalendarChoice[];
  team: readonly { readonly userId: string; readonly name: string; readonly main: boolean }[];
  clients: readonly DealClientRef[];
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const setPlan = (on: boolean) => {
    const next = new URLSearchParams(params.toString());
    if (on) next.set('plan', '1');
    else {
      next.delete('plan');
      next.delete('home');
    }
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const [showCanceled, setShowCanceled] = useState(false);
  const [moving, setMoving] = useState<Tour | null>(null);
  const [canceling, setCanceling] = useState<Tour | null>(null);
  const [hearing, setHearing] = useState<TourStop | null>(null);
  const { busy, act } = useAct();
  const a = tours.agreement;
  const planned = tours.tours
    .filter((t) => t.status === 'planned')
    .sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  const done = tours.tours
    .filter((t) => t.status === 'done')
    .sort((x, y) => y.startsAt.localeCompare(x.startsAt));
  const canceled = tours.tours.filter((t) => t.status === 'canceled');
  const visit = (stop: TourStop, status: 'visited' | 'skipped') =>
    act(
      `v-${stop.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.tour.record_visit', {
            body: { workspaceId, stopId: stop.id, status },
          }),
        ),
      status === 'visited' ? 'Marked seen.' : 'Marked skipped.',
    );
  const card = (t: Tour) => (
    <TourCard
      key={t.id}
      tour={t}
      timeZone={timeZone}
      live={live}
      busy={busy}
      onVisit={(s, st) => void visit(s, st)}
      onHear={setHearing}
      onMove={() => setMoving(t)}
      onCancel={() => setCanceling(t)}
      hasClients={clients.length > 0}
    />
  );
  return (
    <div data-testid="realestate-tours">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Tours" />
      <PageHeader
        title="Tours"
        description={
          a.ok
            ? `${dealName} · buyer agreement signed${a.endsOn ? `, ends ${fmtMonthDay(a.endsOn, new Date().getFullYear())}` : ''}`
            : dealName
        }
        actions={
          live ? (
            <Button onClick={() => setPlan(true)} data-testid="tours-plan">
              Plan a tour
            </Button>
          ) : null
        }
      />
      {!a.ok ? (
        <Callout
          tone={a.rule === 'buyer_agreement_expired' ? 'danger' : 'warning'}
          className="mb-4"
        >
          {a.words}
        </Callout>
      ) : null}
      <div className="space-y-4">
        {planned.length === 0 && done.length === 0 ? (
          <Card className="p-5 text-[13.5px] text-text-2">
            No tours yet. A tour goes on the calendar as one appointment, with its homes in order,
            and the clients are invited and reminded.
          </Card>
        ) : null}
        {planned.map(card)}
        {done.length ? (
          <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-text-3">Done</h2>
        ) : null}
        {done.map(card)}
        {canceled.length ? (
          <button
            type="button"
            className="text-[13px] text-accent-text hover:underline"
            onClick={() => setShowCanceled(!showCanceled)}
          >
            {showCanceled ? 'Hide canceled tours' : `Show ${canceled.length} canceled`}
          </button>
        ) : null}
        {showCanceled ? canceled.map(card) : null}
      </div>
      <PlanTourDialog
        open={params.get('plan') === '1'}
        onOpenChange={setPlan}
        workspaceId={workspaceId}
        dealId={dealId}
        timeZone={timeZone}
        homes={homes}
        agreement={a}
        canExcept={tours.can.except}
        calendars={calendars}
        team={team}
        clients={firstNames(clients.map((c) => c.name))}
        firstHome={params.get('home')}
      />
      <MoveDialog
        tour={moving}
        onClose={() => setMoving(null)}
        workspaceId={workspaceId}
        timeZone={timeZone}
        canExcept={tours.can.except}
        hasClients={clients.length > 0}
      />
      <ReasonDialog
        open={!!canceling}
        onOpenChange={(o) => !o && setCanceling(null)}
        title="Cancel the tour?"
        description={
          canceling
            ? `${fmtWhen(canceling.startsAt, canceling.endsAt, timeZone)}. Its appointment comes off the calendar${clients.length ? ' and the clients are told' : ''}.`
            : undefined
        }
        submit="Cancel the tour"
        danger
        done="Canceled."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.tour.cancel', {
              body: { workspaceId, tourId: canceling!.id, reason, notifyClient: true },
            }),
          )
        }
      />
      <FeedbackDialog
        stop={hearing}
        onClose={() => setHearing(null)}
        workspaceId={workspaceId}
        clients={clients}
      />
    </div>
  );
}

function TourCard({
  tour: t,
  timeZone,
  live,
  busy,
  onVisit,
  onHear,
  onMove,
  onCancel,
  hasClients,
}: {
  tour: Tour;
  timeZone: string;
  live: boolean;
  busy: string | null;
  onVisit: (s: TourStop, status: 'visited' | 'skipped') => void;
  onHear: (s: TourStop) => void;
  onMove: () => void;
  onCancel: () => void;
  hasClients: boolean;
}) {
  const started = Date.parse(t.startsAt) <= Date.now();
  return (
    <Card className="p-0" id={`tour-${t.id}`} data-testid="tour-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 md:px-5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{fmtWhen(t.startsAt, t.endsAt, timeZone)}</h2>
          <div className="text-[12.5px] text-text-2">
            {[t.agent ? `Led by ${t.agent.fullName}` : null, t.note].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={t.status === 'done' ? 'ok' : t.status === 'canceled' ? 'danger' : 'gray'}>
            {TOUR_STATUSES[t.status]}
          </Badge>
          {live && t.status === 'planned' ? (
            <>
              <Button size="sm" variant="ghost" onClick={onMove}>
                Move
              </Button>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {t.exception ? (
        <Callout tone="neutral" className="mx-4 mt-3 md:mx-5">
          Let through without a current buyer agreement by {t.exception.by?.fullName ?? 'an owner'}:{' '}
          {t.exception.reason}
        </Callout>
      ) : null}
      {t.canceledReason ? (
        <p className="px-4 pt-3 text-[13px] text-text-2 md:px-5">Canceled: {t.canceledReason}</p>
      ) : null}
      <ol>
        {t.stops.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 md:px-5"
          >
            <span className="w-4 pt-0.5 text-[13px] text-text-3">{s.position}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium">{street(s.address)}</div>
              {s.feedback.map((f) => (
                <div key={f.id} className="text-[13px] text-text-2">
                  <span className="font-medium text-text">{firstNames([f.name])}:</span>{' '}
                  {TOUR_INTEREST[f.interest]}
                  {f.rating ? ` · ${f.rating} of 5` : ''}
                  {f.words ? ` · “${f.words}”` : ''}
                  {f.recordedBy ? ` (heard by ${f.recordedBy.fullName})` : ''}
                </div>
              ))}
              {s.note ? <div className="text-[12.5px] text-text-3">{s.note}</div> : null}
            </div>
            <div className="flex flex-none flex-wrap items-center gap-1.5">
              <Badge
                variant={s.status === 'visited' ? 'ok' : s.status === 'skipped' ? 'gray' : 'accent'}
              >
                {STOP_STATUSES[s.status]}
              </Badge>
              {live && t.status !== 'canceled' && s.status === 'planned' && started ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onVisit(s, 'visited')}
                    loading={busy === `v-${s.id}`}
                  >
                    Seen
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onVisit(s, 'skipped')}>
                    Skipped
                  </Button>
                </>
              ) : null}
              {live && hasClients && s.status === 'visited' ? (
                <Button size="sm" variant="ghost" onClick={() => onHear(s)}>
                  Add feedback
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function MoveDialog({
  tour,
  onClose,
  workspaceId,
  timeZone,
  canExcept,
  hasClients,
}: {
  tour: Tour | null;
  onClose: () => void;
  workspaceId: string;
  timeZone: string;
  canExcept: boolean;
  hasClients: boolean;
}) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState(600);
  const [tell, setTell] = useState(true);
  const [reason, setReason] = useState('');
  const [refused, setRefused] = useState(false);
  const { busy, act } = useAct(onClose);
  const [shown, setShown] = useState<string | null>(null);
  if (tour && shown !== tour.id) {
    setShown(tour.id);
    setDate(dateOf(tour.startsAt, timeZone));
    setTime(minutesOf(tour.startsAt, timeZone));
    setReason('');
    setRefused(false);
  }
  return (
    <Dialog open={!!tour} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Move the tour" description="Its appointment moves with it.">
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'move',
              async () => {
                try {
                  return unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.tour.reschedule', {
                      body: {
                        workspaceId,
                        tourId: tour!.id,
                        startsAt: new Date(
                          localInstant(date, minutesToClock(time), timeZone),
                        ).toISOString(),
                        notifyClient: tell,
                        acknowledgeWarnings: true,
                        exception: refused && reason.trim() ? { reason: reason.trim() } : undefined,
                      },
                    }),
                  );
                } catch (err) {
                  const rule = (err as { rule?: string }).rule;
                  if (rule === 'buyer_agreement_needed' || rule === 'buyer_agreement_expired')
                    setRefused(true);
                  throw err;
                }
              },
              'Moved.',
            );
          }}
        >
          <div>
            <Label htmlFor="move-date">Day and start</Label>
            <div className="flex gap-2">
              <Input
                id="move-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="min-w-0 flex-1"
              />
              <Select
                aria-label="Start time"
                value={time}
                onChange={(e) => setTime(Number(e.target.value))}
                className="w-[120px]"
              >
                {TIME_OPTIONS.map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {hasClients ? (
            <label className="flex items-center gap-2.5 text-[13.5px]">
              <Switch checked={tell} onChange={setTell} label="Tell the clients" />
              Tell the clients
            </label>
          ) : null}
          {refused && canExcept ? (
            <Field
              label="Let it through without a current agreement"
              htmlFor="move-reason"
              hint="Kept in the deal’s history with your name."
            >
              <Input id="move-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'move'}>
              Move it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FeedbackDialog({
  stop,
  onClose,
  workspaceId,
  clients,
}: {
  stop: TourStop | null;
  onClose: () => void;
  workspaceId: string;
  clients: readonly DealClientRef[];
}) {
  const [personId, setPersonId] = useState('');
  const [interest, setInterest] = useState<TourInterest>('love');
  const [words, setWords] = useState('');
  const { busy, act } = useAct(onClose);
  const [shown, setShown] = useState<string | null>(null);
  if (stop && shown !== stop.id) {
    setShown(stop.id);
    const heard = new Set(stop.feedback.map((f) => f.personId));
    setPersonId(
      clients.find((c) => !heard.has(c.personId))?.personId ?? clients[0]?.personId ?? '',
    );
    setInterest('love');
    setWords('');
  }
  return (
    <Dialog open={!!stop} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="What did they think?"
        description={
          stop
            ? `${street(stop.address)}. For feedback a client told you; they can also leave it in their portal.`
            : undefined
        }
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'fb',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.tour.feedback', {
                    body: {
                      workspaceId,
                      stopId: stop!.id,
                      personId,
                      interest,
                      words: words.trim() || undefined,
                    },
                  }),
                ),
              'Kept.',
            );
          }}
        >
          {clients.length > 1 ? (
            <Field label="Who" htmlFor="fb-who">
              <Select id="fb-who" value={personId} onChange={(e) => setPersonId(e.target.value)}>
                {clients.map((c) => (
                  <option key={c.personId} value={c.personId}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Segmented
            value={interest}
            onChange={setInterest}
            ariaLabel="What they thought"
            options={TOUR_INTEREST_KEYS.map((k) => ({ value: k, label: TOUR_INTEREST[k] }))}
          />
          <Field label="In their words (optional)" htmlFor="fb-words">
            <Textarea
              id="fb-words"
              rows={3}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              className={cn('min-h-[72px]')}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'fb'} disabled={!personId}>
              Keep it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
