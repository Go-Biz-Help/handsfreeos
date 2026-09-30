'use client';
/**
 * Real Estate Agent's panel on core's pages (board 10, design/realestate/Panels.dc.html): a customer's, a company's,
 * a Pipeline lead's or a property's deals, the ones this person sees, and Start a buyer deal or a listing from what
 * the page is about. Drawn by <AddonSlot> only while the add-on runs and for people with `realestate.use`.
 */
import { STAGE_LABELS, type DealStage } from '@hfos/core/addons/realestate/states';
import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { dealHref, HealthDot } from './bits';
import { StartDealDialog, type StartDealDefaults } from './start-deal-dialog';
import type { DealRow } from './types';

export type PanelFor =
  | { readonly personId: string }
  | { readonly companyId: string }
  | { readonly leadId: string; readonly personId: string | null }
  | { readonly propertyId: string };

export function DealsPanel({
  workspaceId,
  of,
  defaults,
  lead,
}: {
  workspaceId: string;
  /** Whose deals: exactly one customer, company, lead or property. */
  of: PanelFor;
  /** What a new deal starts from; fetched when Start is pressed. */
  defaults: () => Promise<StartDealDefaults>;
  /** On a lead's page: the lead keeps its place on the Pipeline, linked to the deal. */
  lead?: boolean;
}) {
  const [deals, setDeals] = useState<DealRow[] | null>(null);
  const [starting, setStarting] = useState<{
    side: 'buyer' | 'listing';
    defaults: StartDealDefaults;
  } | null>(null);
  const changes = useLiveVersion(['custom_record']);
  const key = JSON.stringify(of);
  const load = useCallback(async () => {
    const of = JSON.parse(key) as Record<string, string | null>;
    // One of them only: a lead's own deals, not its customer's.
    const which = of.leadId
      ? { leadId: of.leadId }
      : of.personId
        ? { personId: of.personId }
        : of.companyId
          ? { companyId: of.companyId }
          : { propertyId: of.propertyId! };
    const out = unwrap(
      await apiBrowser().POST('/v1/queries/realestate.deal.for', {
        body: { workspaceId, ...which },
      }),
    );
    setDeals(out.deals);
  }, [workspaceId, key]);
  useEffect(() => {
    load().catch(() => setDeals([]));
  }, [load, changes]);

  async function start(side: 'buyer' | 'listing') {
    setStarting({ side, defaults: await defaults().catch(() => ({})) });
  }

  if (deals === null) return null;
  const open = deals.filter((d) => !d.outcome && !d.archived);
  const shown = [...open, ...deals.filter((d) => d.outcome && !d.archived)].slice(0, 5);
  return (
    <Card className="p-4 md:p-5" data-testid="realestate-panel">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <KeyRound className="h-4 w-4 text-accent-text" strokeWidth={1.75} />
          {lead ? 'Real estate deal' : 'Real estate'}
        </h3>
      </div>
      {shown.length ? (
        <ul className="space-y-2">
          {shown.map((d) => (
            <li key={d.dealId}>
              <Link
                href={dealHref(workspaceId, d.dealId)}
                className="group flex items-start gap-2.5"
              >
                <HealthDot health={d.health} className="mt-1.5" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] group-hover:underline">{d.name}</span>
                  <span className="block truncate text-[12.5px] text-text-2">
                    {[
                      d.side === 'buyer' ? 'Buyer' : 'Listing',
                      d.outcome ? 'Closed' : (STAGE_LABELS[d.stage as DealStage] ?? d.stageLabel),
                      d.mainAgent?.name,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-text-2">
          {lead
            ? 'No deal from this lead yet. Starting one keeps the lead on the Pipeline, linked to the deal; when it closes you’ll be asked whether to mark the lead won.'
            : 'No deals you can see yet.'}
        </p>
      )}
      {lead && shown.length ? (
        <p className="mt-2 text-[12.5px] text-text-3">
          When the deal closes, you’ll be asked whether to mark this lead won.
        </p>
      ) : null}
      {!lead || !open.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void start('buyer')}
            data-testid="panel-start-buyer"
          >
            Start a buyer deal
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void start('listing')}
            data-testid="panel-start-listing"
          >
            Start a listing
          </Button>
        </div>
      ) : null}
      <StartDealDialog
        workspaceId={workspaceId}
        side={starting?.side ?? 'buyer'}
        open={starting !== null}
        onOpenChange={(o) => !o && setStarting(null)}
        defaults={starting?.defaults}
      />
    </Card>
  );
}

/** A customer as a new deal's client. */
export async function personDefaults(
  workspaceId: string,
  personId: string,
): Promise<StartDealDefaults> {
  const out = unwrap(
    await apiBrowser().POST('/v1/queries/person.get', { body: { workspaceId, personId } }),
  );
  return { client: { personId, name: out.person.fullName } };
}
