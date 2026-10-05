'use client';
/**
 * A duty's vendor (board 75): every approved vendor that does what the duty needs, those working where the home is
 * first, each with its disclosure; the one picked, with its quote and appointment; and taking one off. Drawn inside
 * the duty drawer for duties that need a vendor ("Schedule inspections"), or that have one.
 */
import { money } from '@hfos/core';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { parseMoney } from '@/lib/format';
import { cn, relativeTime } from '@/lib/utils';
import type { DutyVendors as DutyVendorsData } from './types';

type Act = (key: string, run: () => Promise<unknown>, done?: string) => Promise<unknown>;

export function DutyVendors({
  workspaceId,
  dutyId,
  dutyTitle,
  open,
  busy,
  act,
  version,
}: {
  workspaceId: string;
  dutyId: string;
  dutyTitle: string;
  /** The duty is still to do, so a vendor can be picked. */
  open: boolean;
  busy: string | null;
  act: Act;
  /** Changes whenever the drawer's duty is read again, so this is too. */
  version: unknown;
}) {
  const [data, setData] = useState<DutyVendorsData | null>(null);
  const [quote, setQuote] = useState<Record<string, string>>({});
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    let live = true;
    void apiBrowser()
      .POST('/v1/queries/realestate.duty.vendors', { body: { workspaceId, dutyId } })
      .then(unwrap)
      .then((d) => live && setData(d))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [workspaceId, dutyId, version, turn]);
  if (!data) return null;
  const picks = data.picks.filter((p) => !p.removedAt);
  if (!data.service && !picks.length) return null;
  const again = () => setTurn((n) => n + 1);
  const run = (key: string, fn: () => Promise<unknown>, done: string) =>
    void act(
      key,
      async () => {
        await fn();
        again();
      },
      done,
    );
  const pickedIds = new Set(picks.map((p) => p.vendor.id));
  return (
    <section data-testid="duty-vendors">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-3">
        {picks.length ? 'Vendor' : `Pick a vendor on “${dutyTitle}”`}
      </h3>
      {picks.map((p) => (
        <div
          key={p.pickId}
          className="mb-2 rounded-card border border-border p-3 text-[13.5px]"
          data-testid="duty-vendor-picked"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold">{p.vendor.name}</div>
              <div className="text-[12.5px] text-text-2">
                {p.serviceLabel}
                {p.pickedByName ? ` · picked by ${p.pickedByName}` : ''} {relativeTime(p.pickedAt)}
              </div>
              <div
                className={cn(
                  'text-[12.5px]',
                  p.vendor.disclosure ? 'text-warning-text' : 'text-text-3',
                )}
              >
                {p.vendor.disclosureWords}
              </div>
            </div>
            <Badge variant="ok">Picked</Badge>
          </div>
          <dl className="mt-2 grid grid-cols-[90px_minmax(0,1fr)] gap-y-1 text-[13px]">
            <dt className="text-text-3">Quote</dt>
            <dd>
              {p.quoteCents !== null ? (
                <>
                  {money(p.quoteCents)}
                  {p.quoteDocument ? ` · ${p.quoteDocument.title}` : ''}
                </>
              ) : open ? (
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const cents = parseMoney(quote[p.pickId] ?? '');
                    if (cents === null) return;
                    run(
                      `quote:${p.pickId}`,
                      async () =>
                        unwrap(
                          await apiBrowser().POST('/v1/commands/realestate.duty.vendor_quote', {
                            body: { workspaceId, pickId: p.pickId, cents },
                          }),
                        ),
                      'Quote saved.',
                    );
                  }}
                >
                  <Input
                    aria-label="Quote"
                    placeholder="$"
                    inputSize="sm"
                    className="w-28"
                    value={quote[p.pickId] ?? ''}
                    onChange={(e) => setQuote({ ...quote, [p.pickId]: e.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    type="submit"
                    loading={busy === `quote:${p.pickId}`}
                  >
                    Save
                  </Button>
                </form>
              ) : (
                <span className="text-text-3">None</span>
              )}
            </dd>
            <dt className="text-text-3">Appointment</dt>
            <dd>
              {p.appointment
                ? `${new Date(p.appointment.startsAt).toLocaleString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })} · on the calendar`
                : 'Not booked yet. Book it on the calendar, on the deal.'}
            </dd>
          </dl>
          {open ? (
            <button
              type="button"
              className="mt-2 text-[12.5px] text-text-3 hover:text-danger-text hover:underline"
              onClick={() => {
                const why = window.prompt(`Why take ${p.vendor.name} off this duty?`);
                if (why?.trim())
                  run(
                    `unpick:${p.pickId}`,
                    async () =>
                      unwrap(
                        await apiBrowser().POST('/v1/commands/realestate.duty.unpick_vendor', {
                          body: { workspaceId, pickId: p.pickId, reason: why.trim() },
                        }),
                      ),
                    'Taken off.',
                  );
              }}
            >
              Take them off
            </button>
          ) : null}
        </div>
      ))}
      {open && data.service ? (
        data.fits.filter((f) => !pickedIds.has(f.id)).length ? (
          <ul className="divide-y divide-border rounded-card border border-border">
            {data.fits
              .filter((f) => !pickedIds.has(f.id))
              .map((f) => (
                <li
                  key={f.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-[13.5px]"
                  data-testid="duty-vendor-fit"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{f.name}</div>
                    <div className="text-[12.5px] text-text-2">
                      {[
                        f.servicesWords,
                        f.areas.join(', ') || 'anywhere',
                        f.inArea === false ? 'not listed for this area' : null,
                        f.lastUsedAt ? `last used ${relativeTime(f.lastUsedAt)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div
                      className={cn(
                        'text-[12.5px]',
                        f.disclosure ? 'text-warning-text' : 'text-text-3',
                      )}
                    >
                      {f.disclosureWords}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `pick:${f.id}`}
                    onClick={() =>
                      run(
                        `pick:${f.id}`,
                        async () =>
                          unwrap(
                            await apiBrowser().POST('/v1/commands/realestate.duty.pick_vendor', {
                              body: { workspaceId, dutyId, vendorId: f.id },
                            }),
                          ),
                        `${f.name} picked.`,
                      )
                    }
                    data-testid="duty-vendor-pick"
                  >
                    Pick
                  </Button>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-[13px] text-text-2">
            No approved vendor does {data.serviceLabel?.toLowerCase() ?? 'this'} yet. Add one in
            Vendors; an owner or admin approves them.
          </p>
        )
      ) : null}
      {data.service ? (
        <p className="mt-2 text-[12.5px] text-text-3">
          Give the client every vendor that fits, not only one, and say any disclosure. The report
          comes back as the duty’s proof.
        </p>
      ) : null}
    </section>
  );
}
