'use client';
/**
 * Round four on the deal page (boards 50, 52 and 54): the contract's values waiting to be confirmed, the contingencies
 * and how each ended, and the linked deal: the client's sale or purchase, or the other side of this home. A linked
 * deal shows only its key dates, health and agent; its duties, documents and messages stay with its own team.
 */
import { fmtMonthDay } from '@hfos/core';
import { DEAL_LINK_KINDS, type DealLinkKind } from '@hfos/core/addons/realestate/words';
import { Link2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { CardHead, dealHref, HEALTH_WORDS, HealthDot, HeadLink, Line } from './bits';
import type { Contingency, ContractReadRow, DealGet, DealLink, DealRow } from './types';
import { useAct } from './use-act';

const thisYear = new Date().getFullYear();
const day = (date: string) => fmtMonthDay(date, thisYear);

/** "The contract: 7 values to confirm", above the deal's risks, while a reading waits on a person. */
export function ReadsCallout({
  workspaceId,
  dealId,
  reads,
}: {
  workspaceId: string;
  dealId: string;
  reads: readonly ContractReadRow[];
}) {
  const waiting = reads.filter((r) => r.state === 'read' && r.waiting > 0);
  const reading = reads.filter((r) => r.state === 'reading');
  if (!waiting.length && !reading.length) return null;
  return (
    <div className="space-y-2" data-testid="deal-reads">
      {waiting.map((r) => (
        <Callout
          key={r.readId}
          tone="info"
          action={
            <Link
              href={dealHref(workspaceId, dealId, `contract/${r.readId}`)}
              className="text-[13px] font-medium text-accent-text hover:underline"
              data-testid="deal-read-open"
            >
              Check them
            </Link>
          }
        >
          <div className="font-medium">
            {r.kind === 'contract' ? 'The contract' : r.documentTitle}: {r.waiting}{' '}
            {r.waiting === 1 ? 'value' : 'values'} to confirm
          </div>
          <div>
            {r.scan ? 'Read from a scan, so check each one closely. ' : ''}Nothing counts until a
            person confirms it; the duties on these dates start then.
          </div>
        </Callout>
      ))}
      {reading.map((r) => (
        <Callout key={r.readId} tone="neutral">
          Reading {r.documentTitle}… Its values show here to confirm in a minute or two.
        </Callout>
      ))}
    </div>
  );
}

const CLOCK_BADGE: Readonly<Record<Contingency['clock'], 'danger' | 'pending' | 'gray'>> = {
  passed: 'danger',
  ending: 'pending',
  open: 'gray',
  unknown: 'gray',
};

/** The deal's contingencies and where each stands; "All" opens their page. */
export function ContingenciesCard({
  workspaceId,
  dealId,
  list,
}: {
  workspaceId: string;
  dealId: string;
  list: readonly Contingency[];
}) {
  const href = dealHref(workspaceId, dealId, 'contingencies');
  return (
    <Card className="p-4 md:p-5" data-testid="deal-contingencies">
      <CardHead title="Contingencies" action={<HeadLink href={href}>All</HeadLink>} />
      {list.length === 0 ? (
        <p className="text-[13px] text-text-2">
          None yet. They come from the accepted offer and the contract, or{' '}
          <Link href={href} className="text-accent-text hover:underline">
            add one
          </Link>
          .
        </p>
      ) : (
        list.map((c) => (
          <Line key={c.id} label={c.label}>
            {c.state === 'open' ? (
              <Badge variant={CLOCK_BADGE[c.clock]}>{c.stateWords}</Badge>
            ) : (
              <span className="text-text-2">{c.stateWords}</span>
            )}
          </Line>
        ))
      )}
    </Card>
  );
}

/** What the linked deal breaks, from this deal's side: what doesn't fit, and what to do. */
export function LinkedProblems({ problems }: { problems: DealGet['linkedProblems'] }) {
  if (!problems.length) return null;
  const [first, ...rest] = problems;
  return (
    <Callout tone="danger" className="mb-4" data-testid="deal-linked-problems">
      <div className="font-medium">{first!.words}</div>
      <div>{[first!.next, ...rest.map((p) => `Also: ${p.words} ${p.next}`)].join(' ')}</div>
    </Callout>
  );
}

/** "their sale", "their purchase", "the other side": what the linked deal is, from here. */
function linkName(l: DealLink): string {
  if (l.kind === 'same_home') return 'the other side';
  return l.side === 'listing' ? 'their sale' : 'their purchase';
}

export function LinkedDealsCard({
  workspaceId,
  deal,
  live,
}: {
  workspaceId: string;
  deal: DealGet;
  live: boolean;
}) {
  const [linking, setLinking] = useState(false);
  const { busy, act } = useAct();
  const dealId = deal.deal.dealId;
  if (!deal.links.length && !live) return null;
  return (
    <Card className="p-4 md:p-5" data-testid="deal-linked">
      {deal.links.length === 0 ? (
        <>
          <CardHead title="Linked deal" />
          <p className="text-[13px] text-text-2">
            The client’s sale or next purchase, or the other side of this home. Linked, each shows
            the other’s key dates, and a slip on one is flagged on both.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => setLinking(true)}
            data-testid="deal-link-open"
          >
            <Link2 className="h-4 w-4" strokeWidth={1.75} />
            Link a deal
          </Button>
        </>
      ) : (
        deal.links.map((l, i) => (
          <div key={l.otherDealId} className={cn(i > 0 && 'mt-4 border-t border-border pt-4')}>
            <CardHead
              title={`Linked: ${linkName(l)}`}
              action={
                live ? (
                  <button
                    type="button"
                    className="text-[13px] text-text-2 hover:text-text"
                    disabled={busy === `unlink-${l.otherDealId}`}
                    onClick={() =>
                      confirm(`Unlink ${l.name}? Neither deal shows the other’s dates after.`) &&
                      void act(
                        `unlink-${l.otherDealId}`,
                        async () =>
                          unwrap(
                            await apiBrowser().POST('/v1/commands/realestate.deal.unlink', {
                              body: {
                                workspaceId,
                                dealId,
                                otherDealId: l.otherDealId,
                                kind: l.kind,
                              },
                            }),
                          ),
                        'Unlinked.',
                      )
                    }
                  >
                    Unlink
                  </button>
                ) : null
              }
            />
            <div className="font-medium">
              {l.canOpen ? (
                <Link
                  href={dealHref(workspaceId, l.otherDealId)}
                  className="hover:underline"
                  data-testid="deal-linked-name"
                >
                  {l.name}
                </Link>
              ) : (
                <span data-testid="deal-linked-name">{l.name}</span>
              )}
            </div>
            <p className="mb-1.5 text-[12.5px] text-text-3">
              {DEAL_LINK_KINDS[l.kind as DealLinkKind]}
              {l.agentName ? ` · ${l.agentName} is the agent` : ''}
            </p>
            <Line label="Stage">{l.stageLabel}</Line>
            {l.keyDates.map((k) => (
              <Line key={k.key} label={k.label}>
                {day(k.date)}
                {!k.confirmed ? <span className="text-text-3"> · not confirmed</span> : null}
              </Line>
            ))}
            <Line label="Health">
              <span className="inline-flex items-center gap-1.5">
                <HealthDot health={l.health} />
                {HEALTH_WORDS[l.health]}
              </span>
            </Line>
            <p className="mt-2 text-[12px] text-text-3">
              You see its dates and health. Its duties, documents and messages stay with
              {l.agentName ? ` ${l.agentName.split(' ')[0]}` : ' its team'}. When a date on either
              deal breaks the pair, both agents are told.
            </p>
          </div>
        ))
      )}
      <LinkDealDialog
        open={linking}
        onOpenChange={setLinking}
        workspaceId={workspaceId}
        deal={deal}
      />
    </Card>
  );
}

/** Pick the other deal by name, and how the two are linked. */
function LinkDealDialog({
  open,
  onOpenChange,
  workspaceId,
  deal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  deal: DealGet;
}) {
  const dealId = deal.deal.dealId;
  const [kind, setKind] = useState<DealLinkKind>('sale_and_purchase');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<readonly DealRow[] | null>(null);
  const [pick, setPick] = useState('');
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { busy, act } = useAct(close);
  useEffect(() => {
    if (!open) return;
    setPick('');
    let gone = false;
    const t = setTimeout(() => {
      void apiBrowser()
        .POST('/v1/queries/realestate.deal.list', {
          body: {
            workspaceId,
            status: 'open',
            mine: false,
            limit: 20,
            ...(search.trim() ? { search: search.trim() } : {}),
          },
        })
        .then(unwrap)
        .then((d) => !gone && setFound(d.deals.filter((x) => x.dealId !== dealId)))
        .catch(() => !gone && setFound([]));
    }, 250);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [open, search, workspaceId, dealId]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Link a deal"
        description="Each shows the other’s key dates and health, and a slip on one is flagged on both."
      >
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'link',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.deal.link', {
                    body: { workspaceId, dealId, otherDealId: pick, kind },
                  }),
                ),
              'Linked.',
            );
          }}
        >
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium">How they’re linked</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['sale_and_purchase', 'Sale and purchase'],
                  ['same_home', 'Same home'],
                ] as const
              ).map(([k, label]) => (
                <label
                  key={k}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-2 rounded-control border px-3 py-1.5 text-[13px]',
                    kind === k
                      ? 'border-accent bg-accent-soft text-accent-text'
                      : 'border-border text-text-2',
                  )}
                >
                  <input
                    type="radio"
                    name="link-kind"
                    className="sr-only"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[12.5px] text-text-3">
              {kind === 'sale_and_purchase'
                ? 'The client’s sale and the home they’re buying next.'
                : 'Your listing and the buyer’s side of the same home, both in this business.'}
            </p>
          </fieldset>
          <Field label="The other deal" htmlFor="link-search">
            <Input
              id="link-search"
              value={search}
              placeholder="Search by name or address"
              onChange={(e) => setSearch(e.target.value)}
              data-testid="deal-link-search"
            />
          </Field>
          <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-menu border border-border">
            {found === null ? (
              <li className="px-3 py-2 text-[13px] text-text-3">Looking…</li>
            ) : found.length === 0 ? (
              <li className="px-3 py-2 text-[13px] text-text-3">
                No open deal matches. Try part of the client’s name or the street.
              </li>
            ) : (
              found.map((d) => (
                <li key={d.dealId}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13.5px] hover:bg-card-2',
                      pick === d.dealId && 'bg-accent-soft',
                    )}
                    onClick={() => setPick(d.dealId)}
                    data-testid="deal-link-pick"
                  >
                    <span className="min-w-0 truncate">
                      {d.name}
                      {d.property && !d.name.includes(d.property.address)
                        ? ` · ${d.property.address}`
                        : ''}
                    </span>
                    <span className="flex-none text-[12px] text-text-3">
                      {d.side === 'listing' ? 'Listing' : 'Buyer'} · {d.stageLabel}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!pick}
              loading={busy === 'link'}
              data-testid="deal-link-save"
            >
              Link
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
