'use client';
/**
 * Real Estate's pages in the client's portal (boards 28–30, design/realestate/PortalDeal, PortalHomes and
 * PortalTour): their deals, the homes on their list, their to-do, one deal, a tour's homes to say what they
 * thought of, and an offer's one-page summary. A seller's listing, its questions, sign-offs and offers are in
 * `listing.tsx` (round three). The portal's shell hands it the path; the manifest's `ui.portal`
 * says which paths there are.
 */
import { fmtMonthDay, fmtWhen, money } from '@hfos/core';
import {
  TOUR_INTEREST,
  TOUR_INTEREST_KEYS,
  type TourInterest,
} from '@hfos/core/addons/realestate/tours';
import { Star } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { usePortal, usePortalAct, usePortalQuery } from '@/components/portal/context';
import { PortalCardHead } from '@/components/portal/ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  DealSteps,
  Done,
  feedbackDue,
  firstName,
  HomeCard,
  nextTour,
  street,
  TaskRow,
  tourOf,
  weekday,
  zone,
} from './bits';
import { ListingDealPage, OffersPage, QuestionnairePage, SignOffPage } from './listing';
import type { PortalDeal, PortalDealRow, PortalStop, PortalTour } from './types';

const thisYear = () => new Date().getFullYear();

export default function RealestatePortalPages({ path }: { path: readonly string[] }) {
  const [a, dealId, b, id] = path;
  if (!a) return <DealsPage />;
  if (a === 'homes') return <HomesPage />;
  if (a === 'todo') return <TodoPage />;
  if (a === 'deals' && dealId && !b) return <DealPage dealId={dealId} />;
  if (a === 'deals' && dealId && b === 'tours' && id)
    return <TourPage dealId={dealId} tourId={id} />;
  if (a === 'deals' && dealId && b === 'offers' && id)
    return <OfferPage dealId={dealId} offerId={id} />;
  // Round three: the seller's own pages.
  if (a === 'deals' && dealId && b === 'offers' && !id) return <OffersPage dealId={dealId} />;
  if (a === 'deals' && dealId && b === 'questionnaire')
    return <QuestionnairePage dealId={dealId} />;
  if (a === 'deals' && dealId && b === 'sign-off' && id)
    return <SignOffPage dealId={dealId} taskId={id} />;
  return null;
}

function Back({ to = '', label = 'Home' }: { to?: string; label?: string }) {
  const { href } = usePortal();
  return (
    <Link
      href={href(to)}
      className="mb-3 inline-block text-[13.5px] text-accent-text hover:underline"
    >
      {label}
    </Link>
  );
}

/** Their open deals, for the pages that gather across them (Homes, To do). */
function useOpenDeals() {
  const { data } = usePortalQuery<{ deals: readonly PortalDealRow[] }>('realestate.portal.deals');
  return data ? data.deals.filter((d) => !d.closed) : null;
}

function DealsPage() {
  const { href } = usePortal();
  const { data } = usePortalQuery<{ deals: readonly PortalDealRow[] }>('realestate.portal.deals');
  return (
    <div className="space-y-3">
      <h1 className="text-[22px] font-semibold">Your deals</h1>
      {(data?.deals ?? []).map((d) => (
        <Link key={d.dealId} href={href(`a/realestate/deals/${d.dealId}`)} className="block">
          <Card className="p-4 hover:bg-card-2">
            <div className="text-[15px] font-semibold">{d.name}</div>
            <div className="text-[13.5px] text-text-2">{d.closed ? 'Closed' : d.stage}</div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

function HomesPage() {
  const deals = useOpenDeals();
  const buying = (deals ?? []).filter((d) => d.side === 'buyer');
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <div data-testid="portal-homes">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold">Homes</h1>
        {buying[0] ? (
          <Button
            variant="secondary"
            onClick={() => setAdding(buying[0]!.dealId)}
            data-testid="portal-home-add"
          >
            Add one you found
          </Button>
        ) : null}
      </div>
      {deals && buying.length === 0 ? (
        <Card className="p-4 text-[14px] text-text-2">No home search yet.</Card>
      ) : null}
      {buying.map((d) => (
        <DealHomes
          key={d.dealId}
          dealId={d.dealId}
          adding={adding === d.dealId}
          onAdded={() => setAdding(null)}
        />
      ))}
    </div>
  );
}

function DealHomes({
  dealId,
  adding,
  onAdded,
}: {
  dealId: string;
  adding: boolean;
  onAdded: () => void;
}) {
  const { data: deal, reload } = usePortalQuery<PortalDeal>('realestate.portal.deal', { dealId });
  if (!deal) return null;
  const shown = deal.homes.filter((h) => h.status !== 'removed');
  return (
    <>
      {shown.length === 0 ? (
        <Card className="p-4 text-[14px] text-text-2">
          No homes yet. Add one you found, and {firstName(deal.deal.agentName)} will take a look.
        </Card>
      ) : (
        <ul className="space-y-3">
          {shown.map((h) => (
            <HomeCard key={h.id} home={h} tour={tourOf(deal, h.id)} onChange={reload} />
          ))}
        </ul>
      )}
      <AddHomeDialog
        open={adding}
        dealId={dealId}
        agent={firstName(deal.deal.agentName)}
        onClose={() => {
          onAdded();
          reload();
        }}
      />
    </>
  );
}

function AddHomeDialog({
  open,
  dealId,
  agent,
  onClose,
}: {
  open: boolean;
  dealId: string;
  agent: string;
  onClose: () => void;
}) {
  const { op } = usePortal();
  const [address, setAddress] = useState('');
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const { busy, act } = usePortalAct(() => {
    setAddress('');
    setLink('');
    setNote('');
    onClose();
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Add a home you found"
        description={`${agent} will see it on your list.`}
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'add',
              () =>
                op('realestate.portal.home.add', {
                  dealId,
                  address,
                  link: link.trim() || undefined,
                  note: note.trim() || undefined,
                }),
              'Added to your list.',
            );
          }}
        >
          <Field label="Address" htmlFor="ph-address">
            <Input
              id="ph-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Link to the listing (optional)" htmlFor="ph-link">
            <Input
              id="ph-link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://"
            />
          </Field>
          <Field label={`A note for ${agent} (optional)`} htmlFor="ph-note">
            <Input id="ph-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy === 'add'} disabled={address.trim().length < 3}>
              Add it
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TodoPage() {
  const deals = useOpenDeals();
  return (
    <div className="space-y-4" data-testid="portal-todo">
      <h1 className="text-[22px] font-semibold">To do</h1>
      {deals && deals.length === 0 ? (
        <Card className="p-4 text-[14px] text-text-2">Nothing to do right now.</Card>
      ) : null}
      {(deals ?? []).map((d) => (
        <DealTodo key={d.dealId} dealId={d.dealId} titled={(deals ?? []).length > 1} />
      ))}
    </div>
  );
}

function DealTodo({ dealId, titled }: { dealId: string; titled: boolean }) {
  const { href } = usePortal();
  const { data: deal, reload } = usePortalQuery<PortalDeal>('realestate.portal.deal', { dealId });
  if (!deal) return null;
  const feedback = feedbackDue(deal.tours);
  const tasks = deal.tasks.filter((t) => t.status !== 'canceled');
  return (
    <Card className="p-4">
      {titled ? <PortalCardHead>{deal.deal.name}</PortalCardHead> : null}
      {tasks.length === 0 && feedback.length === 0 ? (
        <p className="text-[14px] text-text-2">Nothing to do right now.</p>
      ) : (
        <ul className="divide-y divide-border">
          {feedback.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 text-[14px]">
              <span>Leave feedback on {weekday(t.startsAt)}’s homes</span>
              <Link
                href={href(`a/realestate/deals/${dealId}/tours/${t.id}`)}
                className="text-[13px] text-accent-text hover:underline"
                data-testid="portal-feedback-open"
              >
                Open
              </Link>
            </li>
          ))}
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} dealId={dealId} onDone={reload} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DealPage({ dealId }: { dealId: string }) {
  const { href } = usePortal();
  const { data: deal, reload } = usePortalQuery<PortalDeal>('realestate.portal.deal', { dealId });
  if (!deal) return null;
  if (deal.deal.side === 'listing')
    return <ListingDealPage dealId={dealId} deal={deal} reload={reload} />;
  const d = deal.deal;
  const agent = firstName(d.agentName);
  const tour = nextTour(deal.tours);
  const today = new Date().toISOString().slice(0, 10);
  const dates = deal.keyDates.filter((k) => k.date >= today);
  const feedback = feedbackDue(deal.tours);
  return (
    <div className="space-y-4" data-testid="portal-deal">
      <Back />
      <h1 className="text-[24px] font-semibold">
        {d.side === 'buyer' ? 'Buying a home' : 'Selling your home'}
      </h1>
      <Card className="p-4">
        <DealSteps deal={d} />
      </Card>
      <Card className="p-4">
        <PortalCardHead>What happens next</PortalCardHead>
        <p className="text-[14px]">
          {tour
            ? `${weekday(tour.startsAt)} you’ll see ${tour.stops.length} ${tour.stops.length === 1 ? 'home' : 'homes'} with ${agent}. Afterwards, tell ${agent} what you thought of each one here.`
            : feedback.length
              ? `Tell ${agent} what you thought of the homes you saw.`
              : dates[0]
                ? `${dates[0].label}: ${fmtMonthDay(dates[0].date, thisYear())}.`
                : `${agent} will let you know what’s next. Message ${agent} any time.`}
        </p>
        {tour ? (
          <Link
            href={href(`a/realestate/deals/${dealId}/tours/${tour.id}`)}
            className="mt-1 inline-block text-[13.5px] text-accent-text hover:underline"
          >
            {fmtWhen(tour.startsAt, tour.endsAt, zone())}
          </Link>
        ) : null}
      </Card>
      {deal.tasks.length || feedback.length ? (
        <Card className="p-4">
          <PortalCardHead>Your to-do</PortalCardHead>
          <ul className="divide-y divide-border">
            {feedback.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2.5 text-[14px]">
                <span>Leave feedback on {weekday(t.startsAt)}’s homes</span>
                <Link
                  href={href(`a/realestate/deals/${dealId}/tours/${t.id}`)}
                  className="text-[13px] text-accent-text hover:underline"
                >
                  Open
                </Link>
              </li>
            ))}
            {deal.tasks
              .filter((t) => t.status !== 'canceled')
              .map((t) => (
                <TaskRow key={t.id} task={t} dealId={dealId} onDone={reload} />
              ))}
          </ul>
        </Card>
      ) : null}
      {dates.length ? (
        <Card className="p-4">
          <PortalCardHead>Key dates</PortalCardHead>
          <ul className="space-y-1.5 text-[14px]">
            {dates.map((k) => (
              <li key={k.key} className="flex justify-between gap-3">
                <span className="text-text-2">{k.label}</span>
                <span>{fmtMonthDay(k.date, thisYear())}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {deal.offers.length || deal.cmas.length ? (
        <Card className="p-4">
          <PortalCardHead>Shared with you</PortalCardHead>
          <ul className="space-y-2 text-[14px]">
            {deal.offers.map((o) => (
              <li key={o.id}>
                <Link
                  href={href(`a/realestate/deals/${dealId}/offers/${o.id}`)}
                  className="text-accent-text hover:underline"
                >
                  {o.summary.title}
                </Link>
              </li>
            ))}
            {deal.cmas.map((c) => (
              <li key={c.id}>
                <div className="font-medium">
                  What {street(c.address)} is worth: {money(c.lowCents)}–{money(c.highCents)}
                </div>
                {c.summary ? (
                  <p className="mt-1 whitespace-pre-wrap text-[13.5px] text-text-2">{c.summary}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {deal.financing.some((f) => f.status !== 'not_started') ? (
        <Card className="p-4">
          <PortalCardHead>Your loan</PortalCardHead>
          <ul className="space-y-1.5 text-[14px]">
            {deal.financing.map((f) => (
              <li key={f.step} className="flex justify-between gap-3">
                <span className={f.status === 'done' ? '' : 'text-text-2'}>{f.label}</span>
                <span className="text-text-2">
                  {f.status === 'done'
                    ? 'Done'
                    : f.status === 'in_progress'
                      ? f.date
                        ? `Expected ${fmtMonthDay(f.date, thisYear())}`
                        : 'Under way'
                      : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function TourPage({ dealId, tourId }: { dealId: string; tourId: string }) {
  const { data: deal, reload } = usePortalQuery<PortalDeal>('realestate.portal.deal', { dealId });
  const [openStop, setOpenStop] = useState<string | null>(null);
  const tour: PortalTour | undefined = deal?.tours.find((t) => t.id === tourId);
  if (!deal) return null;
  if (!tour)
    return (
      <Card className="p-4 text-[14px]">
        That tour isn’t on your deal anymore.{' '}
        <Back to={`a/realestate/deals/${dealId}`} label="Back to your deal" />
      </Card>
    );
  const agent = firstName(deal.deal.agentName);
  const first = tour.stops.find((s) => s.status === 'visited' && !s.myFeedback)?.id ?? null;
  const shown = openStop ?? first;
  return (
    <div className="space-y-3" data-testid="portal-tour">
      <Back to={`a/realestate/deals/${dealId}`} label="Your deal" />
      <h1 className="text-[24px] font-semibold">{weekday(tour.startsAt)}’s tour</h1>
      <p className="text-[13.5px] text-text-2">
        {fmtWhen(tour.startsAt, tour.endsAt, zone())} with {agent} · {tour.stops.length}{' '}
        {tour.stops.length === 1 ? 'home' : 'homes'}
      </p>
      <ul className="space-y-2">
        {tour.stops.map((s) =>
          shown === s.id && s.status === 'visited' ? (
            <FeedbackForm
              key={s.id}
              stop={s}
              agent={agent}
              onSent={() => {
                setOpenStop(null);
                reload();
              }}
            />
          ) : (
            <li key={s.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-menu px-1 py-2 text-left hover:bg-card-2"
                onClick={() => s.status === 'visited' && setOpenStop(s.id)}
                disabled={s.status !== 'visited'}
              >
                {s.myFeedback ? (
                  <Done />
                ) : (
                  <span className="h-6 w-6 flex-none rounded-full border border-border-strong" />
                )}
                <span className="flex-1 text-[14px]">
                  {s.position} · {street(s.address)}
                </span>
                <span className="text-[13px] text-text-2">
                  {s.myFeedback
                    ? (TOUR_INTEREST[s.myFeedback.interest as TourInterest] ?? 'Sent')
                    : s.status === 'visited'
                      ? 'Tell us'
                      : s.status === 'skipped'
                        ? 'Skipped'
                        : 'Not yet'}
                </span>
              </button>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function FeedbackForm({
  stop,
  agent,
  onSent,
}: {
  stop: PortalStop;
  agent: string;
  onSent: () => void;
}) {
  const { op } = usePortal();
  const [rating, setRating] = useState<number | null>(null);
  const [liked, setLiked] = useState('');
  const [didnt, setDidnt] = useState('');
  const [interest, setInterest] = useState<TourInterest | null>(null);
  const { busy, act } = usePortalAct(onSent);
  const words = [
    liked.trim() ? `Liked: ${liked.trim()}` : null,
    didnt.trim() ? `Didn’t like: ${didnt.trim()}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <li>
      <Card className="p-4" data-testid="portal-feedback">
        <div className="text-[15px] font-semibold">
          {stop.position} · {street(stop.address)}
        </div>
        <div className="mt-2 flex gap-1" role="radiogroup" aria-label="How many stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
              onClick={() => setRating(n)}
              className="text-warning"
            >
              <Star
                className={cn('h-6 w-6', rating !== null && n <= rating && 'fill-current')}
                strokeWidth={1.5}
              />
            </button>
          ))}
        </div>
        <Field label="What you liked" htmlFor={`fb-liked-${stop.id}`} className="mt-3">
          <Input
            id={`fb-liked-${stop.id}`}
            value={liked}
            onChange={(e) => setLiked(e.target.value)}
          />
        </Field>
        <Field label="What you didn’t" htmlFor={`fb-didnt-${stop.id}`} className="mt-3">
          <Textarea
            id={`fb-didnt-${stop.id}`}
            rows={2}
            value={didnt}
            onChange={(e) => setDidnt(e.target.value)}
            className="min-h-[52px]"
          />
        </Field>
        <div className="mt-3 flex flex-wrap gap-2">
          {TOUR_INTEREST_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={interest === k}
              onClick={() => setInterest(k)}
              className={cn(
                'h-8 rounded-full border px-3 text-[13px]',
                interest === k
                  ? 'border-accent-soft bg-accent-soft text-accent-text'
                  : 'border-border-strong text-text-2',
              )}
              data-testid={`portal-interest-${k}`}
            >
              {TOUR_INTEREST[k]}
            </button>
          ))}
        </div>
        <Button
          size="lg"
          className="mt-4 w-full"
          disabled={!interest}
          loading={busy === 'send'}
          onClick={() =>
            void act(
              'send',
              () =>
                op('realestate.portal.tour.feedback', {
                  stopId: stop.id,
                  interest,
                  rating,
                  words: words || undefined,
                }),
              `Sent to ${agent}.`,
            )
          }
          data-testid="portal-feedback-send"
        >
          Send to {agent}
        </Button>
      </Card>
    </li>
  );
}

function OfferPage({ dealId, offerId }: { dealId: string; offerId: string }) {
  const { home } = usePortal();
  const { data: deal } = usePortalQuery<PortalDeal>('realestate.portal.deal', { dealId });
  const offer = deal?.offers.find((o) => o.id === offerId);
  if (!deal) return null;
  if (!offer)
    return (
      <Card className="p-4 text-[14px]">
        That offer isn’t shared with you anymore.{' '}
        <Back to={`a/realestate/deals/${dealId}`} label="Back to your deal" />
      </Card>
    );
  const s = offer.summary;
  return (
    <div className="space-y-3" data-testid="portal-offer">
      <Back to={`a/realestate/deals/${dealId}`} label="Your deal" />
      <Card className="p-5">
        <h1 className="text-[18px] font-semibold">{s.title}</h1>
        <p className="mt-1 text-[12.5px] text-text-2">{home.business.name}</p>
        <p className="mt-3 text-[13.5px] text-text-2">{s.note}</p>
        <dl className="mt-3 divide-y divide-border">
          {s.lines.map((l) => (
            <div key={l.label} className="flex justify-between gap-3 py-2 text-[14px]">
              <dt className="text-text-2">{l.label}</dt>
              <dd className={cn('text-right', l.label === 'Price' && 'font-semibold')}>
                {l.value}
              </dd>
            </div>
          ))}
        </dl>
        <h2 className="mt-4 text-[14px] font-semibold">What happens next</h2>
        <p className="mt-1 text-[14px] text-text-2">{s.next}</p>
      </Card>
    </div>
  );
}
