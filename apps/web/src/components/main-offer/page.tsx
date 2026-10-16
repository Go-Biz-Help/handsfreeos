'use client';
import {
  clearsBar,
  formatDate,
  MAIN_OFFER_TRY_WORDS as TW,
  MAIN_OFFER_WORDS as W,
  offerChecks,
  partSays,
  SCORED_PART_LABELS,
  SCORED_PARTS,
  timeOfDay,
} from '@hfos/core';
import { Check, CircleAlert, Compass, Megaphone, Pencil } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AddonSlot } from '@/components/addons/slot';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorMessage } from '@/lib/api/errors';
import type { MainOfferGet, MainOfferVersions } from '@/lib/api/types';
import { discardOfferDraft } from '@/lib/main-offer/actions';
import { cn } from '@/lib/utils';
import { WithDirection } from './review';

type Live = NonNullable<MainOfferGet['live']>;

/**
 * Settings → Main offer (docs/main-offer.md): the live version with its score and parts, what's working and what's
 * holding each back, the owner's direction, the draft someone is working on, and every version published. Shown only while an add-on that uses the offer is on; owners and admins
 * build and change it, and everyone in the business can read it.
 */
export function MainOfferPage({
  workspaceId,
  offer,
  versions,
  canManage,
}: {
  workspaceId: string;
  offer: MainOfferGet;
  versions: MainOfferVersions;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const build = `/app/w/${workspaceId}/main-offer/build`;
  const { live, draft } = offer;

  async function throwAway() {
    if (!window.confirm(W.throwAwayAsk)) return;
    setBusy(true);
    try {
      await discardOfferDraft(workspaceId);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-[980px] flex-col gap-5" data-testid="main-offer-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex max-w-[600px] flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">{W.title}</h2>
          <p className="text-[13.5px] text-text-2">{W.pageHint}</p>
        </div>
        {live && canManage ? (
          <ButtonLink href={build} variant="primary" data-testid="main-offer-change">
            <Pencil className="h-4 w-4" strokeWidth={1.5} />
            {W.changeOffer}
          </ButtonLink>
        ) : null}
      </div>

      {!live && !draft ? (
        <Card className="flex flex-col gap-5 p-6 sm:p-8" data-testid="main-offer-start">
          <div className="flex max-w-[620px] flex-col gap-1.5">
            <h3 className="text-lg font-semibold">{W.startTitle}</h3>
            <p className="text-text-2">{canManage ? W.startHint : W.askOwner}</p>
          </div>
          {canManage ? (
            <>
              <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {W.startSteps.map(([name, about], i) => (
                  <li key={name} className="flex flex-col gap-1 rounded-menu bg-card-2 p-3.5">
                    <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                      {i + 1}
                    </span>
                    <span className="font-medium">{name}</span>
                    <span className="text-[13px] text-text-2">{about}</span>
                  </li>
                ))}
              </ol>
              <div className="flex flex-wrap items-center gap-3">
                <ButtonLink href={build} variant="primary" data-testid="main-offer-start-building">
                  {W.start}
                </ButtonLink>
                <span className="text-[13px] text-text-3">{W.startNote}</span>
              </div>
            </>
          ) : null}
        </Card>
      ) : null}

      {draft ? (
        <div
          className="flex flex-wrap items-start gap-3 rounded-menu bg-accent-soft px-4 py-3.5"
          data-testid="main-offer-draft"
        >
          <Pencil className="mt-0.5 h-4 w-4 flex-none text-accent-text" strokeWidth={1.75} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium">{W.draftBy(draft.by?.name ?? 'Someone')}</span>
            <span className="text-[13px] text-text-2" suppressHydrationWarning>
              {W.draftAbout(
                draft.at ? timeOfDay(draft.at) : '',
                !!draft.score,
                live?.version ?? null,
              )}
            </span>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <ButtonLink href={build} size="sm" data-testid="main-offer-open-draft">
                {W.openDraft}
              </ButtonLink>
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void throwAway()}>
                {W.throwAway}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {live ? (
        <Tabs defaultValue="live">
          <TabsList>
            <TabsTrigger value="live">{W.tabLive}</TabsTrigger>
            <TabsTrigger value="versions">{W.tabVersions}</TabsTrigger>
          </TabsList>
          <TabsContent value="live" className="mt-5 flex flex-col gap-5">
            <LiveVersion
              live={live}
              comesWith={offer.comesWith}
              direction={offer.direction}
              editDirection={canManage ? `${build}?step=score` : null}
            />
            {/* How it's doing in the add-ons that use it (Social Outreach's first messages, yeses and calls). */}
            <AddonSlot name="main_offer.panels" workspaceId={workspaceId} />
          </TabsContent>
          <TabsContent value="versions" className="mt-5">
            <Card data-testid="main-offer-versions">
              {versions.map((v, i) => (
                <div
                  key={v.version}
                  className={cn(
                    'grid grid-cols-[96px_minmax(0,1fr)_auto] items-start gap-4 px-4 py-3.5',
                    i > 0 && 'border-t border-border',
                  )}
                >
                  <span className="text-[13px] font-medium">{W.versionName(v.version)}</span>
                  <span className="flex min-w-0 flex-col gap-0.5 text-[13px]">
                    <span>{v.line}</span>
                    <span className="text-xs text-text-3" suppressHydrationWarning>
                      {W.versionMeta(
                        v.lowest,
                        formatDate(v.publishedAt),
                        v.publishedBy?.name ?? null,
                      )}
                      {v.anyway ? ` · ${W.wentLiveAnyway(v.anyway)}` : ''}
                    </span>
                  </span>
                  {v.version === live.version ? (
                    <Badge variant="ok">{W.liveBadge}</Badge>
                  ) : v.anyway ? (
                    <Badge variant="pending">{W.underBarBadge}</Badge>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
            </Card>
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}

function LiveVersion({
  live,
  comesWith,
  direction,
  editDirection,
}: {
  live: Live;
  comesWith: readonly string[];
  direction: string | null;
  editDirection: string | null;
}) {
  const clears = clearsBar(live.score);
  return (
    <>
      <Card className="flex flex-col gap-3.5 px-5 py-5" data-testid="main-offer-live">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3"
            suppressHydrationWarning
          >
            {W.liveLine(live.version, formatDate(live.publishedAt), live.publishedBy?.name ?? null)}
          </span>
          <Badge variant={clears ? 'ok' : 'pending'}>
            {clears ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : null}
            {clears ? W.allClearBadge : W.underBarBadge}
          </Badge>
        </div>
        <p className="text-[18px] font-medium leading-[1.45] tracking-[-0.005em]">{live.line}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-text-3">{W.inMessages}</span>
          {live.parts.inAFewWords.outcome ? <Badge>{live.parts.inAFewWords.outcome}</Badge> : null}
          {live.parts.inAFewWords.guarantee ? (
            <Badge>{live.parts.inAFewWords.guarantee}</Badge>
          ) : null}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <div className="px-4 py-3.5 font-semibold">{W.byPart}</div>
          {SCORED_PARTS.map((p) => {
            const part = live.score.parts[p];
            const s = part.score;
            return (
              <div
                key={p}
                className="grid grid-cols-[100px_minmax(0,1fr)_auto] items-start gap-4 border-t border-border px-4 py-3.5"
                data-testid={`main-offer-part-${p}`}
              >
                <span className="text-[13px] font-medium">{SCORED_PART_LABELS[p]}</span>
                <span className="flex min-w-0 flex-col gap-1.5 text-[13px]">
                  <span>{partSays(live.parts, p)}</span>
                  {part.good?.map((g) => (
                    <span key={g} className="flex items-start gap-1.5 text-[12.5px] text-text-2">
                      <Check
                        className="mt-px h-3.5 w-3.5 flex-none text-success"
                        strokeWidth={2}
                        aria-label={TW.working}
                      />
                      {g}
                    </span>
                  ))}
                  {part.holding?.map((h) => (
                    <span key={h} className="flex items-start gap-1.5 text-[12.5px] text-text-2">
                      <CircleAlert
                        className="mt-px h-3.5 w-3.5 flex-none text-warning"
                        strokeWidth={1.75}
                        aria-label={TW.holding}
                      />
                      {h}
                    </span>
                  ))}
                  {part.followedDirection ? (
                    <span>
                      <WithDirection />
                    </span>
                  ) : null}
                </span>
                <Badge variant={s >= 7 ? 'ok' : 'pending'} className="tabular-nums">
                  {s}
                </Badge>
              </div>
            );
          })}
          {live.parts.proof.length ? (
            <div className="grid grid-cols-[100px_minmax(0,1fr)] items-start gap-4 border-t border-border px-4 py-3.5">
              <span className="text-[13px] font-medium">Proof</span>
              <span className="text-[13px]">{live.parts.proof.join(' · ')}</span>
            </div>
          ) : null}
        </Card>
        <div className="flex flex-col gap-5">
          <Card className="flex flex-col gap-3 p-4">
            <span className="font-semibold">{W.howScored}</span>
            {offerChecks(live.score).map(({ text, ok }) => (
              <div key={text} className="flex items-center gap-2 text-[13px]">
                <Badge variant={ok ? 'ok' : 'pending'}>{ok ? W.yes : W.notYet}</Badge>
                {text}
              </div>
            ))}
            <p className="text-[13px] text-text-2">
              {W.weakest(SCORED_PART_LABELS[live.score.weakest], live.score.fix)}
            </p>
          </Card>
          {direction || editDirection ? (
            <Card className="flex flex-col gap-2 p-4" data-testid="main-offer-direction">
              <span className="flex items-center gap-2 font-semibold">
                <Compass className="h-4 w-4 text-accent-text" strokeWidth={1.75} />
                {direction ? TW.directionKept : TW.directionTitle}
              </span>
              <p className="whitespace-pre-line text-[13px]">{direction ?? TW.directionHint}</p>
              {direction ? <p className="text-xs text-text-3">{TW.directionKeptHint}</p> : null}
              {editDirection ? (
                <span>
                  <ButtonLink href={editDirection} size="sm" variant="ghost" className="-ml-2.5">
                    {TW.editDirection}
                  </ButtonLink>
                </span>
              ) : null}
            </Card>
          ) : null}
          <Card className="flex flex-col gap-2.5 p-4">
            <span className="font-semibold">{W.usedBy}</span>
            {comesWith.map((name) => (
              <div key={name} className="flex items-center gap-2 text-[13px]">
                <Megaphone className="h-4 w-4 flex-none text-text-2" strokeWidth={1.5} />
                <span className="font-medium">{name}</span>
              </div>
            ))}
            <p className="text-xs text-text-3">{W.whoChanges}</p>
          </Card>
        </div>
      </div>
    </>
  );
}
