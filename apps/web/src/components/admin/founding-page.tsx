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
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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

const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

const price = (cents: number): string => (cents === 0 ? 'Free' : `$${(cents / 100).toFixed(0)}`);

export function FoundingPage({ queue }: { queue: Queue }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [approving, setApproving] = useState<Application | null>(null);
  const [revoking, setRevoking] = useState<Grant | null>(null);

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

  const pending = queue.applications.filter(
    (a) => a.status === 'pending' || a.status === 'waitlisted',
  );
  const held = queue.grants.filter((g) => g.status === 'reserved' || g.status === 'active');
  const gone = queue.grants.filter((g) => g.status === 'revoked' || g.status === 'expired');

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="text-xl font-semibold md:text-2xl">Founding offers</h1>
      {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {queue.offers.map((offer) => (
          <OfferCard
            key={offer.offerId}
            offer={offer}
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
        Waiting on you{pending.length ? ` · ${pending.length}` : ''}
      </h2>
      {pending.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">Nothing to read. Applications land here.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {pending.map((a) => (
            <li key={a.applicationId} className="px-4 py-3.5">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {a.businessName}
                    {a.status === 'waitlisted' ? (
                      <span className="text-text-3"> · waitlisted</span>
                    ) : null}
                  </p>
                  <p className="truncate text-[13px] text-text-3">
                    {a.contactName} · {a.email}
                    {a.phone ? ` · ${a.phone}` : ''}
                    {a.industry ? ` · ${a.industry}` : ''} · {when(a.createdAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setApproving(a)}>
                    Approve
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
                    Decline
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

      <h2 className="mt-8 text-base font-semibold">
        Seats out{held.length ? ` · ${held.length}` : ''}
      </h2>
      {held.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">Nobody holds a seat yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {held.map((g) => (
            <li key={g.grantId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {g.organizationName ?? g.organizationId}
                </p>
                <p className="truncate text-[13px] text-text-3">
                  {g.offerId} ·{' '}
                  {g.status === 'reserved'
                    ? `approved ${when(g.reservedAt)}, not taken up — expires ${when(g.expiresAt)}`
                    : `using it since ${when(g.activatedAt)}`}
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setRevoking(g)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      {gone.length > 0 ? (
        <>
          <h2 className="mt-8 text-base font-semibold">Seats given back</h2>
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
                  <p className="truncate text-[13px] text-text-3">
                    {g.status === 'expired'
                      ? `never taken up · expired ${when(g.expiresAt)}`
                      : `revoked ${when(g.revokedAt)} · ${g.revokeReason}`}
                    {g.graceEndsAt ? ` · still working until ${when(g.graceEndsAt)}` : ''}
                  </p>
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
                    Undo
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
          busy={busy === `approve:${approving.applicationId}`}
          onClose={() => setApproving(null)}
          onApprove={async (organizationId, note) => {
            const ok = await run(`approve:${approving.applicationId}`, () =>
              call('/v1/commands/founding.approve', {
                applicationId: approving.applicationId,
                organizationId,
                note,
              }),
            );
            if (ok) setApproving(null);
          }}
        />
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
  busy,
  onCap,
  onStatus,
}: {
  offer: Offer;
  busy: string | null;
  onCap: (seatCap: number) => void;
  onStatus: (status: 'draft' | 'open' | 'closed') => void;
}) {
  const [cap, setCap] = useState(String(offer.seatCap));
  const pct = offer.seatCap > 0 ? Math.min(100, (offer.claimed / offer.seatCap) * 100) : 0;
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{offer.name}</h2>
        <span className="text-[13px] text-text-3">
          {price(offer.priceCents)} · {offer.status}
        </span>
      </div>

      <p className="mt-3 text-2xl font-semibold">
        {offer.remaining}
        <span className="text-base font-normal text-text-3"> of {offer.seatCap} left</span>
      </p>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-card-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Field label="Seats" htmlFor={`cap-${offer.offerId}`} className="w-24">
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
          Save
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy === `status:${offer.offerId}`}
          onClick={() => onStatus(offer.status === 'open' ? 'closed' : 'open')}
        >
          {offer.status === 'open' ? 'Close' : 'Open'}
        </Button>
      </div>
      <p className="mt-2 text-[12px] text-text-3">
        Raising this opens seats at once. It cannot go below the {offer.claimed} already out.
      </p>
    </Card>
  );
}

function ApproveDialog({
  application,
  busy,
  onClose,
  onApprove,
}: {
  application: Application;
  busy: boolean;
  onClose: () => void;
  onApprove: (organizationId: string, note: string) => void;
}) {
  const [organizationId, setOrganizationId] = useState('');
  const [note, setNote] = useState('');
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        title={`Approve ${application.businessName}`}
        description="This takes a seat straight away and holds it for them. You get a claim link back — it is shown once and never again, so send it before you close this."
      >
        <div className="mt-4 flex flex-col gap-3">
          <Field
            label="Their business id"
            htmlFor="founding-approve-org"
            hint="The organization this seat belongs to. They must have signed up first."
          >
            <Input
              id="founding-approve-org"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Field>
          <Field label="Why them" htmlFor="founding-approve-note" hint="Only we ever see this.">
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
            Cancel
          </Button>
          <Button
            disabled={busy || organizationId.trim() === ''}
            onClick={() => onApprove(organizationId.trim(), note)}
          >
            {busy ? 'Taking a seat…' : 'Approve and hold a seat'}
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
        title={`Take the seat back from ${grant.organizationName ?? 'this business'}`}
        description="The seat frees up immediately and you can approve somebody else today. They keep working normally through their notice period, and are told when it ends."
      >
        <div className="mt-4">
          <Field
            label="Why"
            htmlFor="founding-revoke-reason"
            hint="Kept forever. Write it for whoever has to explain this later."
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
            Cancel
          </Button>
          <Button disabled={busy || reason.trim() === ''} onClick={() => onRevoke(reason.trim())}>
            {busy ? 'Revoking…' : 'Revoke the seat'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
