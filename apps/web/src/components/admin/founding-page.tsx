'use client';

/**
 * The founding offers, the queue and the seats (0091).
 *
 * The page is built around one fact that is easy to lose: **the cap is enforced by the database, not here.**
 * Nothing on this page decides whether an approval will work — the button is offered, pressed, and the
 * answer comes back from Postgres. That is why "seats left" is shown rather than used to disable anything:
 * a disabled button that disagrees with the database is worse than an enabled one that gets refused with a
 * sentence saying why.
 *
 * Revoking asks for a reason and will not proceed without one, because the reason is kept forever and a
 * revocation nobody explained cannot be defended a year later when the business asks.
 *
 * A free seat is on the moment it is approved or given, to any business, applied or not, and stays on until it
 * is revoked. Only a paid seat is held behind a claim link. A seat still held from before, or one that lapsed,
 * can be turned on from its row.
 *
 * The offers open one after another by themselves (0092): each card says what it is waiting for, and the
 * earlier offer says when a later one has taken its place on the website. The page only reports this — the
 * switch happens in the database, in the same transaction as the approval that crossed the line.
 */
import {
  deskCountHeading,
  FOUNDING_ANOTHER,
  FOUNDING_WORDS,
  foundingApplicationLine,
  foundingOfferIsPaid,
  foundingBusinessLabel,
  foundingClaimPath,
  foundingFirstChoice,
  foundingFirstOffer,
  foundingGivableOffers,
  foundingGivenBackLine,
  foundingOfferCard,
  foundingOfferPriceLine,
  foundingQueueParts,
  foundingSeatLine,
  foundingSeatProblem,
  foundingTheirBusinesses,
  type FoundingPickable,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyField } from '@/components/ui/copy-field';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type Queue = Ok<'/v1/queries/platform.founding'>;
type Offer = Queue['offers'][number];
type Application = Queue['applications'][number];
type Grant = Queue['grants'][number];

export function FoundingPage({ queue }: { queue: Queue }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [approving, setApproving] = useState<Application | null>(null);
  const [giving, setGiving] = useState(false);
  const [revoking, setRevoking] = useState<Grant | null>(null);
  /** The claim link just made. Shown once: only its hash is kept, so closing this is the last chance to copy it. */
  const [issued, setIssued] = useState<{ business: string; link: string; until: string } | null>(
    null,
  );

  const call = (path: string, body: object) =>
    (apiBrowser().POST as (p: string, o: { body: unknown }) => Promise<never>)(path, {
      body,
    }).then(unwrap);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      router.refresh();
      return true;
    } catch (e) {
      // The database's refusals arrive here as sentences: "Every seat in this offer is taken", and so on.
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const { pending, held, gone } = foundingQueueParts(queue);

  /** A seat held but not on, or one that lapsed: on their only workspace now, for good. */
  const turnOn = (g: Grant) =>
    run(`on:${g.grantId}`, () =>
      call('/v1/commands/founding.give', {
        offerId: g.offerId,
        organizationId: g.organizationId,
      }),
    );

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="text-xl font-semibold md:text-2xl">{FOUNDING_WORDS.title}</h1>
      {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {queue.offers.map((offer) => (
          <OfferCard
            key={offer.offerId}
            offer={offer}
            offers={queue.offers}
            busy={busy}
            onCap={(seatCap) =>
              run(`cap:${offer.offerId}`, () =>
                call('/v1/commands/founding.set_cap', { offerId: offer.offerId, seatCap }),
              )
            }
            onStatus={(status) =>
              run(`status:${offer.offerId}`, () =>
                call('/v1/commands/founding.set_status', { offerId: offer.offerId, status }),
              )
            }
          />
        ))}
      </div>

      <h2 className="mt-8 text-base font-semibold">
        {deskCountHeading(FOUNDING_WORDS.waiting, pending.length)}
      </h2>
      {pending.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">{FOUNDING_WORDS.noneWaiting}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {pending.map((a) => (
            <li key={a.applicationId} className="px-4 py-3.5">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {a.businessName}
                    {a.status === 'waitlisted' ? (
                      <span className="text-text-3">{FOUNDING_WORDS.waitlistedTag}</span>
                    ) : null}
                  </p>
                  <p className="truncate text-[13px] text-text-3">{foundingApplicationLine(a)}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setApproving(a)}>
                    {FOUNDING_WORDS.approve}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === `decline:${a.applicationId}`}
                    onClick={() =>
                      run(`decline:${a.applicationId}`, () =>
                        call('/v1/commands/founding.decline', { applicationId: a.applicationId }),
                      )
                    }
                  >
                    {FOUNDING_WORDS.decline}
                  </Button>
                </div>
              </div>
              {/* Their own words, in full. This is what Phase 1 is for; truncating it defeats the point. */}
              {a.note ? (
                <p className="mt-2 whitespace-pre-wrap rounded-[10px] bg-card-2 px-3 py-2 text-[13px] text-text-2">
                  {a.note}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {deskCountHeading(FOUNDING_WORDS.seatsOut, held.length)}
        </h2>
        <Button size="sm" onClick={() => setGiving(true)}>
          {FOUNDING_WORDS.give}
        </Button>
      </div>
      {held.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">{FOUNDING_WORDS.noSeatsOut}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {held.map((g) => (
            <li key={g.grantId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {g.organizationName ?? g.organizationId}
                </p>
                <p className="truncate text-[13px] text-text-3">{foundingSeatLine(g)}</p>
                {foundingSeatProblem(g) ? (
                  // Money in, no seat on: somebody has to refund it at Stripe or find them a seat.
                  <p className="mt-1 text-[13px] text-danger-text">{foundingSeatProblem(g)}</p>
                ) : null}
              </div>
              <div className="flex gap-2">
                {g.status === 'reserved' && !foundingOfferIsPaid(g.offerId, queue.offers) ? (
                  <Button size="sm" disabled={busy === `on:${g.grantId}`} onClick={() => turnOn(g)}>
                    {FOUNDING_WORDS.turnOn}
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => setRevoking(g)}>
                  {FOUNDING_WORDS.revoke}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {gone.length > 0 ? (
        <>
          <h2 className="mt-8 text-base font-semibold">{FOUNDING_WORDS.givenBack}</h2>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
            {gone.map((g) => (
              <li
                key={g.grantId}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {g.organizationName ?? g.organizationId}
                  </p>
                  <p className="truncate text-[13px] text-text-3">{foundingGivenBackLine(g)}</p>
                  {foundingSeatProblem(g) ? (
                    <p className="mt-1 text-[13px] text-danger-text">{foundingSeatProblem(g)}</p>
                  ) : null}
                </div>
                {g.status === 'revoked' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === `restore:${g.grantId}`}
                    onClick={() =>
                      run(`restore:${g.grantId}`, () =>
                        call('/v1/commands/founding.restore', { grantId: g.grantId }),
                      )
                    }
                  >
                    {FOUNDING_WORDS.undo}
                  </Button>
                ) : !foundingOfferIsPaid(g.offerId, queue.offers) ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === `on:${g.grantId}`}
                    onClick={() => turnOn(g)}
                  >
                    {FOUNDING_WORDS.turnOn}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {approving ? (
        <ApproveDialog
          application={approving}
          paid={foundingOfferIsPaid(approving.offerId, queue.offers)}
          busy={busy === `approve:${approving.applicationId}`}
          onClose={() => setApproving(null)}
          onApprove={async (organizationId, workspaceId, note) => {
            type Made = { claimToken: string | null; expiresAt: string | null };
            let out: Made | null = null;
            const ok = await run(`approve:${approving.applicationId}`, async () => {
              out = (await call('/v1/commands/founding.approve', {
                applicationId: approving.applicationId,
                organizationId,
                workspaceId,
                note,
              })) as Made;
            });
            if (!ok || !out) return;
            const made: Made = out;
            setApproving(null);
            // A free seat is simply on. Only a paid one comes back with a link to send.
            if (made.claimToken && made.expiresAt)
              setIssued({
                business: approving.businessName,
                link: `${window.location.origin}${foundingClaimPath(made.claimToken)}`,
                until: made.expiresAt,
              });
          }}
        />
      ) : null}

      {giving ? (
        <GiveDialog
          offers={foundingGivableOffers(queue.offers)}
          busy={busy === 'give'}
          onClose={() => setGiving(false)}
          onGive={async (input) => {
            const ok = await run('give', () => call('/v1/commands/founding.give', input));
            if (ok) setGiving(false);
          }}
        />
      ) : null}

      {issued ? (
        <Dialog open onOpenChange={() => setIssued(null)}>
          <DialogContent
            title={FOUNDING_WORDS.issuedTitle(issued.business)}
            description={FOUNDING_WORDS.issuedDescription}
          >
            <CopyField
              className="mt-4"
              value={issued.link}
              label={FOUNDING_WORDS.copyLink}
              copied={FOUNDING_WORDS.copiedLink}
            />
            <p className="mt-3 text-[13px] text-text-3">{FOUNDING_WORDS.linkWorks(issued.until)}</p>
            <div className="mt-5 flex justify-end">
              <Button onClick={() => setIssued(null)}>{FOUNDING_WORDS.sentIt}</Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {revoking ? (
        <RevokeDialog
          grant={revoking}
          busy={busy === `revoke:${revoking.grantId}`}
          onClose={() => setRevoking(null)}
          onRevoke={async (reason) => {
            const ok = await run(`revoke:${revoking.grantId}`, () =>
              call('/v1/commands/founding.revoke', { grantId: revoking.grantId, reason }),
            );
            if (ok) setRevoking(null);
          }}
        />
      ) : null}
    </div>
  );
}

function OfferCard({
  offer,
  offers,
  busy,
  onCap,
  onStatus,
}: {
  offer: Offer;
  offers: readonly Offer[];
  busy: string | null;
  onCap: (seatCap: number) => void;
  onStatus: (status: 'draft' | 'open' | 'closed') => void;
}) {
  const [cap, setCap] = useState(String(offer.seatCap));
  const { pct, opens, opened, replaced, paid, renews, action } = foundingOfferCard(offer, offers);

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{offer.name}</h2>
        <span className="text-[13px] text-text-3">{foundingOfferPriceLine(offer)}</span>
      </div>

      <p className="mt-3 text-2xl font-semibold">
        {offer.remaining}
        <span className="text-base font-normal text-text-3">
          {FOUNDING_WORDS.ofLeft(offer.seatCap)}
        </span>
      </p>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-card-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>

      {opens ? (
        <p className="mt-3 text-[13px] text-text-2">{opens}</p>
      ) : opened ? (
        <p className="mt-3 text-[13px] text-text-3">{opened}</p>
      ) : null}

      {replaced ? <p className="mt-2 text-[13px] text-text-3">{replaced}</p> : null}

      {paid ? <p className="mt-2 text-[13px] text-text-3">{FOUNDING_WORDS.paidNote}</p> : null}

      {renews ? <p className="mt-2 text-[13px] text-text-3">{renews}</p> : null}

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Field label={FOUNDING_WORDS.seats} htmlFor={`cap-${offer.offerId}`} className="w-24">
          <Input
            id={`cap-${offer.offerId}`}
            value={cap}
            inputMode="numeric"
            onChange={(e) => setCap(e.target.value)}
          />
        </Field>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy === `cap:${offer.offerId}` || cap === String(offer.seatCap)}
          onClick={() => {
            const n = Number(cap);
            if (Number.isInteger(n) && n >= 0) onCap(n);
          }}
        >
          {FOUNDING_WORDS.save}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy === `status:${offer.offerId}`}
          onClick={() => onStatus(action.status)}
        >
          {action.label}
        </Button>
      </div>
      <p className="mt-2 text-[12px] text-text-3">{FOUNDING_WORDS.capHint(offer.claimed)}</p>
    </Card>
  );
}

/** Businesses whose name has `term` in it, a moment after typing stops. Null until there's something to look for. */
function useBusinessSearch(term: string, on: boolean): FoundingPickable[] | null {
  const [found, setFound] = useState<FoundingPickable[] | null>(null);
  useEffect(() => {
    const search = term.trim();
    if (!on || search.length < 2) {
      setFound(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/platform.business.list', {
            body: { search, sort: 'name', limit: 20 },
          }),
        );
        if (cancelled) return;
        setFound(
          out.businesses.map((b) => ({
            workspaceId: b.workspaceId,
            organizationId: b.organizationId,
            label: foundingBusinessLabel(b.name, b.organizationName),
          })),
        );
      } catch {
        if (!cancelled) setFound([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [on, term]);
  return found;
}

function ApproveDialog({
  application,
  paid,
  busy,
  onClose,
  onApprove,
}: {
  application: Application;
  /** A paid seat is held behind a link; a free one is on at once. */
  paid: boolean;
  busy: boolean;
  onClose: () => void;
  onApprove: (organizationId: string, workspaceId: string, note: string) => void;
}) {
  // Matched on the email they applied with, owners and admins only: the people who can take the seat up.
  const theirs = foundingTheirBusinesses(application);
  // A founder with one business is the usual case, so that one is picked for you.
  const [choice, setChoice] = useState(foundingFirstChoice(theirs));
  const [term, setTerm] = useState('');
  const found = useBusinessSearch(term, choice === FOUNDING_ANOTHER);
  const [foundChoice, setFoundChoice] = useState('');
  const [note, setNote] = useState('');
  // A pick from an earlier search doesn't carry over to this one.
  const chosen = found?.some((b) => b.workspaceId === foundChoice) ? foundChoice : '';

  const picked =
    choice === FOUNDING_ANOTHER
      ? found?.find((b) => b.workspaceId === chosen)
      : theirs.find((b) => b.workspaceId === choice);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        title={FOUNDING_WORDS.approveTitle(application.businessName)}
        description={
          paid ? FOUNDING_WORDS.approveDescription : FOUNDING_WORDS.approveFreeDescription
        }
      >
        <div className="mt-4 flex flex-col gap-3">
          <Field
            label={FOUNDING_WORDS.theirBusiness}
            htmlFor="founding-approve-business"
            hint={
              theirs.length
                ? FOUNDING_WORDS.theirsHint(application.email)
                : FOUNDING_WORDS.noneTheirsHint(application.email)
            }
          >
            <select
              id="founding-approve-business"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="h-10 rounded-control border border-border bg-card px-2.5 text-sm"
            >
              {theirs.length > 1 ? (
                <option value="" disabled>
                  {FOUNDING_WORDS.pickOne}
                </option>
              ) : null}
              {theirs.map((b) => (
                <option key={b.workspaceId} value={b.workspaceId}>
                  {b.label}
                </option>
              ))}
              <option value={FOUNDING_ANOTHER}>{FOUNDING_WORDS.another}</option>
            </select>
          </Field>
          {choice === FOUNDING_ANOTHER ? (
            <>
              <Field label={FOUNDING_WORDS.searchBusinesses} htmlFor="founding-approve-search">
                <Input
                  id="founding-approve-search"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder={FOUNDING_WORDS.searchPlaceholder}
                  autoComplete="off"
                />
              </Field>
              {found === null ? null : found.length === 0 ? (
                <p className="text-[13px] text-text-3">{FOUNDING_WORDS.noBusiness}</p>
              ) : (
                <Field
                  label={FOUNDING_WORDS.business}
                  htmlFor="founding-approve-found"
                  hint={
                    theirs.some((b) => b.workspaceId === chosen)
                      ? undefined
                      : FOUNDING_WORDS.notTheirsHint(application.email)
                  }
                >
                  <select
                    id="founding-approve-found"
                    value={chosen}
                    onChange={(e) => setFoundChoice(e.target.value)}
                    className="h-10 rounded-control border border-border bg-card px-2.5 text-sm"
                  >
                    <option value="" disabled>
                      {FOUNDING_WORDS.pickOne}
                    </option>
                    {found.map((b) => (
                      <option key={b.workspaceId} value={b.workspaceId}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          ) : null}
          <Field
            label={FOUNDING_WORDS.whyThem}
            htmlFor="founding-approve-note"
            hint={FOUNDING_WORDS.whyThemHint}
          >
            <Textarea
              id="founding-approve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {FOUNDING_WORDS.cancel}
          </Button>
          <Button
            disabled={busy || !picked}
            onClick={() => picked && onApprove(picked.organizationId, picked.workspaceId, note)}
          >
            {busy
              ? paid
                ? FOUNDING_WORDS.approving
                : FOUNDING_WORDS.giving
              : paid
                ? FOUNDING_WORDS.approveAndHold
                : FOUNDING_WORDS.approveAndTurnOn}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A seat for any business, applied or not: found by name, on its workspace at once, kept until revoked. */
function GiveDialog({
  offers,
  busy,
  onClose,
  onGive,
}: {
  offers: readonly Offer[];
  busy: boolean;
  onClose: () => void;
  onGive: (input: {
    offerId: string;
    organizationId: string;
    workspaceId: string;
    note: string;
  }) => void;
}) {
  const [term, setTerm] = useState('');
  const found = useBusinessSearch(term, true);
  const [foundChoice, setFoundChoice] = useState('');
  const [offerId, setOfferId] = useState(foundingFirstOffer(offers));
  const [note, setNote] = useState('');
  // A pick from an earlier search doesn't carry over to this one.
  const chosen = found?.some((b) => b.workspaceId === foundChoice) ? foundChoice : '';
  const picked = found?.find((b) => b.workspaceId === chosen);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent title={FOUNDING_WORDS.giveTitle} description={FOUNDING_WORDS.giveDescription}>
        <div className="mt-4 flex flex-col gap-3">
          <Field label={FOUNDING_WORDS.searchBusinesses} htmlFor="founding-give-search">
            <Input
              id="founding-give-search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={FOUNDING_WORDS.searchPlaceholder}
              autoComplete="off"
              autoFocus
            />
          </Field>
          {found === null ? null : found.length === 0 ? (
            <p className="text-[13px] text-text-3">{FOUNDING_WORDS.noBusiness}</p>
          ) : (
            <Field label={FOUNDING_WORDS.business} htmlFor="founding-give-found">
              <select
                id="founding-give-found"
                value={chosen}
                onChange={(e) => setFoundChoice(e.target.value)}
                className="h-10 rounded-control border border-border bg-card px-2.5 text-sm"
              >
                <option value="" disabled>
                  {FOUNDING_WORDS.pickOne}
                </option>
                {found.map((b) => (
                  <option key={b.workspaceId} value={b.workspaceId}>
                    {b.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {offers.length === 0 ? (
            <p className="text-[13px] text-text-3">{FOUNDING_WORDS.noOfferOpen}</p>
          ) : offers.length > 1 ? (
            <Field label={FOUNDING_WORDS.offer} htmlFor="founding-give-offer">
              <select
                id="founding-give-offer"
                value={offerId}
                onChange={(e) => setOfferId(e.target.value)}
                className="h-10 rounded-control border border-border bg-card px-2.5 text-sm"
              >
                {offers.map((o) => (
                  <option key={o.offerId} value={o.offerId}>
                    {o.name} · {foundingOfferPriceLine(o)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field
            label={FOUNDING_WORDS.whyThem}
            htmlFor="founding-give-note"
            hint={FOUNDING_WORDS.whyThemHint}
          >
            <Textarea
              id="founding-give-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {FOUNDING_WORDS.cancel}
          </Button>
          <Button
            disabled={busy || !picked || !offerId}
            onClick={() =>
              picked &&
              onGive({
                offerId,
                organizationId: picked.organizationId,
                workspaceId: picked.workspaceId,
                note,
              })
            }
          >
            {busy ? FOUNDING_WORDS.giving : FOUNDING_WORDS.giveSeat}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  grant,
  busy,
  onClose,
  onRevoke,
}: {
  grant: Grant;
  busy: boolean;
  onClose: () => void;
  onRevoke: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        title={FOUNDING_WORDS.revokeTitle(grant.organizationName)}
        description={FOUNDING_WORDS.revokeDescription}
      >
        <div className="mt-4">
          <Field
            label={FOUNDING_WORDS.why}
            htmlFor="founding-revoke-reason"
            hint={FOUNDING_WORDS.whyHint}
          >
            <Textarea
              id="founding-revoke-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </Field>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {FOUNDING_WORDS.cancel}
          </Button>
          <Button disabled={busy || reason.trim() === ''} onClick={() => onRevoke(reason.trim())}>
            {busy ? FOUNDING_WORDS.revoking : FOUNDING_WORDS.revokeSeat}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
