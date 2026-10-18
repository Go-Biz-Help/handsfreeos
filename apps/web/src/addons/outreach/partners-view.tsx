'use client';
/**
 * Social Outreach's Partners list, under People (docs/outreach.md, decision 81; HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md,
 * "Screens"): everyone the AI found could send the business its customers. A chip for each stage with how many are
 * at it, and a row for each person: their kind, network and audience, when they reached their stage, why they fit,
 * the AI's first warm-up while they're still to be asked, and the marks their stage offers (`partnerMarksFor`):
 * Interested, Call booked, Make partner, Not now, Back on the list, and Not a partner when the AI was wrong. The best
 * fits with the biggest audiences first, a page at a time; the stage, the network and the page are in the address
 * (./address.ts), so the page asks HandsFreeOS for them. The words are core's (`PARTNER_WORDS`).
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import {
  PARTNER_FITS,
  PARTNER_KINDS,
  PARTNER_MARKS,
  PARTNER_STAGE_KEYS,
  PARTNER_VIEW_KEYS,
  PARTNER_VIEWS,
  PARTNER_WORDS as P,
  partnerMarksFor,
  type PartnerMark,
  type PartnerView,
} from '@hfos/core/addons/outreach/partners';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { NetworkFilterControl, NetworkName } from './network-ui';
import type { PartnerListRow, Partners } from './types';
import { useAct } from './use-act';

export function PartnersView({
  workspaceId,
  partners,
  show,
  net = null,
  page,
}: {
  workspaceId: string;
  partners: Partners;
  show: PartnerView;
  /** The network it's narrowed to: null for every network. */
  net?: Platform | null;
  page: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = (to: { partners?: PartnerView; net?: Platform | null; page?: number }) => {
    const href = outreachHref(workspaceId, {
      view: 'partners',
      partners: to.partners ?? show,
      net: to.net === undefined ? net : to.net,
      page: to.page ?? 1,
    });
    startTransition(() => router.replace(href, { scroll: false }));
  };
  const everyone = PARTNER_STAGE_KEYS.reduce((n, s) => n + partners.counts[s], 0);
  return (
    <div data-testid="outreach-partners">
      <p className="mb-3 max-w-3xl text-[13px] text-text-2">{P.about}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <Segmented
            ariaLabel="Which partners"
            value={show}
            onChange={(v) => go({ partners: v })}
            options={PARTNER_VIEW_KEYS.map((k) => ({
              value: k,
              label: (
                <>
                  {PARTNER_VIEWS[k]}
                  <span className="tabular-nums text-text-3">
                    {(k === 'all' ? everyone : partners.counts[k]).toLocaleString()}
                  </span>
                </>
              ),
              testId: `partners-show-${k}`,
            }))}
          />
        </div>
        <NetworkFilterControl value={net} onChange={(n) => go({ net: n })} />
      </div>
      <div
        className={cn('transition-opacity', pending && 'opacity-60')}
        aria-busy={pending || undefined}
      >
        {partners.partners.length ? (
          <Card className="p-0" data-testid="partners-list">
            <ul>
              {partners.partners.map((p, i) => (
                <PartnerItem
                  key={p.partnerId}
                  workspaceId={workspaceId}
                  partner={p}
                  first={i === 0}
                />
              ))}
            </ul>
            {page > 1 || partners.more ? (
              <nav
                aria-label="Pages"
                className="flex items-center justify-between gap-3 border-t border-border px-5 py-3"
              >
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => go({ page: page - 1 })}
                  data-testid="partners-page-previous"
                >
                  Previous
                </Button>
                <span className="text-[12.5px] tabular-nums text-text-2">
                  Page {page.toLocaleString()}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!partners.more}
                  onClick={() => go({ page: page + 1 })}
                  data-testid="partners-page-next"
                >
                  Next
                </Button>
              </nav>
            ) : null}
          </Card>
        ) : (
          <Card data-testid="partners-empty">
            {show === 'all' ? (
              <EmptyState title={P.emptyTitle}>{P.empty}</EmptyState>
            ) : (
              <EmptyState title={P.emptyStage(show)} />
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

/** Someone on the list: who they are and their audience, why they fit, and the marks their stage offers. */
function PartnerItem({
  workspaceId,
  partner: p,
  first,
}: {
  workspaceId: string;
  partner: PartnerListRow;
  first: boolean;
}) {
  const { busy, act } = useAct();
  const audience = P.audienceLine(p);
  const mark = (m: PartnerMark) =>
    act(
      m,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.partner.mark', {
            body: { workspaceId, partnerId: p.partnerId, mark: m },
          }),
        ),
      P.marked(m, p.name),
    );
  const marks = partnerMarksFor(p.stage);
  return (
    <li className={cn('px-5 py-4', !first && 'border-t border-border')} data-testid="partner">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-[13.5px]">
          <a
            href={p.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent-text hover:underline"
          >
            {p.name}
          </a>{' '}
          <NetworkName platform={p.platform} />
          <div className="text-[12.5px] text-text-3">
            {[PARTNER_KINDS[p.kind], audience].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span className="flex items-center gap-1.5">
          {p.fit === 'maybe' ? <Badge variant="gray">{PARTNER_FITS.maybe}</Badge> : null}
          <span className="text-[12.5px] text-text-2" data-testid="partner-stage">
            {P.since(p.stage, p.stageAt)}
          </span>
        </span>
      </div>
      {p.why.length ? (
        <p className="mt-1.5 text-[13px] text-text" data-testid="partner-why">
          <span className="sr-only">{P.whyTitle}: </span>
          {p.why.join(' · ')}
        </p>
      ) : null}
      {p.nextStep && (p.stage === 'found' || p.stage === 'warming') ? (
        <p className="mt-1 text-[12.5px] text-text-2">{P.next(p.nextStep)}</p>
      ) : null}
      {marks.length ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {marks.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={m === 'not_partner' ? 'ghost' : 'secondary'}
              disabled={busy !== null}
              onClick={() => void mark(m)}
              data-testid={`partner-mark-${m}`}
            >
              {PARTNER_MARKS[m]}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
