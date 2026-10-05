'use client';
/**
 * A listing's printable flyer (board 38, design/realestate/Flyer.dc.html): letter size, with the first photo, the
 * price, the confirmed facts, the signed-off description, three more photos, the agent and a QR code to the public
 * page. Like everything public it waits for the MLS (Chris, 2026-10-01): until then the page says why, with the way
 * to Marketing. Printing leaves out the app around it.
 */
import { money } from '@hfos/core';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { FileItem } from '@/lib/api/types';
import { usePublicOrigin } from '@/lib/use-origin';
import { dealHref } from './bits';
import { DealCrumb } from './buyer-bits';
import { listingFactsLine, SignedPhoto } from './listing-bits';
import type { Flyer, ListingView } from './types';

export function FlyerPage({
  workspaceId,
  dealId,
  dealName,
  businessName,
  flyer: f,
  refusal,
  listing,
  files,
  brandedOrigin,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  businessName: string;
  /** Null when the flyer was refused: not live on the MLS yet, or no signed-off description. */
  flyer: Flyer | null;
  refusal: string | null;
  listing: ListingView;
  files: readonly FileItem[];
  brandedOrigin: string | null;
}) {
  const origin = usePublicOrigin(brandedOrigin);
  const link = f?.page && origin ? `${origin}${f.page.path}` : null;
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    // Wait for the real origin: a QR code made from a relative path sends whoever scans it nowhere.
    if (!link) return;
    let stale = false;
    void QRCode.toDataURL(link, { margin: 1, width: 512 })
      .then((d) => !stale && setQr(d))
      .catch(() => !stale && setQr(null));
    return () => {
      stale = true;
    };
  }, [link]);
  const fileOf = (id: string) => files.find((x) => x.id === id);
  const [cover, ...more] = f?.photos ?? [];
  const facts = listingFactsLine(listing.facts);

  return (
    <div data-testid="realestate-flyer">
      <style>{'@page { size: letter; margin: 0.4in; }'}</style>
      <div className="print:hidden">
        <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Flyer" />
        <PageHeader
          title="Flyer"
          description="Letter size · the first photo, the confirmed facts and the signed-off description"
          actions={
            <>
              <ButtonLink href={dealHref(workspaceId, dealId, 'marketing')} variant="secondary">
                Back
              </ButtonLink>
              {f ? (
                <Button onClick={() => window.print()} data-testid="flyer-print">
                  Print
                </Button>
              ) : null}
            </>
          }
        />
      </div>
      {!f ? (
        <Callout tone="neutral" data-testid="flyer-refused">
          <div>
            <div>{refusal ?? 'The flyer isn’t ready yet.'}</div>
            <ButtonLink
              href={dealHref(workspaceId, dealId, 'marketing')}
              size="sm"
              variant="secondary"
              className="mt-2"
            >
              Open Marketing
            </ButtonLink>
          </div>
        </Callout>
      ) : (
        <>
          {!f.page ? (
            <Callout tone="neutral" className="mb-4 print:hidden">
              The QR code shows once the public page is up. Put it up from Marketing.
            </Callout>
          ) : null}
          <div className="rounded-card bg-card-2 p-3 md:p-5 print:bg-transparent print:p-0">
            <Card
              className="mx-auto flex w-full max-w-[816px] flex-col gap-4 p-6 md:p-9 print:max-w-none print:border-0 print:p-0 print:shadow-none"
              data-testid="flyer-sheet"
            >
              <SignedPhoto
                file={cover ? fileOf(cover.fileId) : undefined}
                alt={cover?.caption ?? `The front of ${f.street}`}
                className="h-[260px] rounded-control md:h-[320px]"
                label={cover ? (cover.caption ?? 'Photo') : 'No photos marked for the page'}
              />
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[26px] font-bold leading-tight">{f.street}</h2>
                  {f.cityLine ? <div className="text-[14px] text-text-2">{f.cityLine}</div> : null}
                </div>
                {f.priceCents !== null ? (
                  <div className="text-[28px] font-bold tabular-nums">{money(f.priceCents)}</div>
                ) : null}
              </div>
              {facts ? <div className="text-[14.5px] font-medium">{facts}</div> : null}
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{f.description}</p>
              {more.length ? (
                <div className="grid grid-cols-3 gap-3">
                  {more.slice(0, 3).map((p) => (
                    <SignedPhoto
                      key={p.fileId}
                      file={fileOf(p.fileId)}
                      alt={p.caption ?? 'A photo of the home'}
                      className="h-[110px] rounded-control"
                      label={p.caption ?? 'Photo'}
                    />
                  ))}
                </div>
              ) : null}
              <div className="flex items-end justify-between gap-4 border-t border-border pt-4">
                <div className="text-[13.5px]">
                  {f.agentName ? <div className="font-semibold">{f.agentName}</div> : null}
                  <div>{businessName}</div>
                  <div className="text-text-2">MLS #{f.mlsNumber}</div>
                </div>
                {f.page ? (
                  <div className="flex items-end gap-3">
                    <span className="max-w-[120px] text-right text-[12.5px] text-text-2">
                      Photos, open houses and more
                    </span>
                    {qr ? (
                      // A data: URL made in this browser: no loader, no request.
                      <img
                        src={qr}
                        alt="QR code for the listing’s page"
                        className="h-24 w-24"
                        data-testid="flyer-qr"
                      />
                    ) : (
                      <div className="h-24 w-24 bg-card-2" />
                    )}
                  </div>
                ) : null}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
