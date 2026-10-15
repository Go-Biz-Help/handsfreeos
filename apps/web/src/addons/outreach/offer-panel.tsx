'use client';
/**
 * Social Outreach's panel on Settings → Main offer (decision 67): how the live version is doing, with the first
 * messages sent with it, the yeses and the calls booked; too new to judge before `JUDGE_AFTER_MESSAGES`; and each
 * version anyone was pitched with. Owners and admins see everyone's counts, anyone else their own. Drawn by
 * <AddonSlot> only while the add-on runs and for people with `outreach.use`; with no offer live, nothing.
 */
import {
  OFFER_PANEL_WORDS as O,
  type OfferVersionsOutput,
} from '@hfos/core/addons/outreach/conversation';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { SlotProps } from '../registry';

export default function OfferPanel({ workspaceId }: SlotProps<'main_offer.panels'>) {
  const [got, setGot] = useState<OfferVersionsOutput | null>(null);
  useEffect(() => {
    let on = true;
    void apiBrowser()
      .POST('/v1/queries/outreach.offer.versions', { body: { workspaceId } })
      .then(unwrap)
      .then((v) => on && setGot(v))
      .catch(() => on && setGot(null));
    return () => {
      on = false;
    };
  }, [workspaceId]);

  if (!got?.live) return null;
  const live = got.versions.find((v) => v.version === got.live) ?? {
    version: got.live,
    messages: 0,
    positive: 0,
    booked: 0,
  };
  const left = Math.max(0, got.judgeAfter - live.messages);
  const versions = got.versions.some((v) => v.version === live.version)
    ? got.versions
    : [live, ...got.versions];
  return (
    <Card className="flex flex-col gap-3.5 p-5" data-testid="outreach-offer-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {O.overline}
          </span>
          <h3 className="text-[16px] font-semibold">{O.title(live.version)}</h3>
        </div>
        <span className="text-[13px] text-text-2">{got.everyone ? O.everyone : O.justYou}</span>
      </div>
      {left > 0 ? (
        <p
          role="status"
          className="flex flex-col gap-0.5 rounded-menu bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text"
          data-testid="outreach-offer-too-new"
        >
          <span className="font-semibold">{O.tooNew}</span>
          <span>{O.giveIt(left)}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2.5">
        {(
          [
            [O.messages, live.messages],
            [O.yes, live.positive],
            [O.booked, live.booked],
          ] as const
        ).map(([label, n]) => (
          <div
            key={label}
            className="flex min-w-[120px] flex-1 flex-col gap-0.5 rounded-menu bg-card-2 px-3.5 py-3"
          >
            <span className="text-[13px] text-text-2">{label}</span>
            <span className="text-[22px] font-semibold tabular-nums">{n.toLocaleString()}</span>
          </div>
        ))}
      </div>
      {left > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between text-[12px] text-text-3">
            <span>{O.judgeAt(got.judgeAfter)}</span>
            <span className="tabular-nums">{O.sofar(live.messages, got.judgeAfter)}</span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-card-2"
            role="progressbar"
            aria-label={O.judgeAt(got.judgeAfter)}
            aria-valuemin={0}
            aria-valuemax={got.judgeAfter}
            aria-valuenow={Math.min(live.messages, got.judgeAfter)}
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.min(100, (live.messages / got.judgeAfter) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
      {versions.length > 1 ? (
        <table className="w-full border-collapse text-[13px]" aria-label={O.each}>
          <thead>
            <tr className="border-b border-border text-left text-text-2">
              <th className="py-2 font-medium">{O.version}</th>
              <th className="py-2 font-medium">{O.messages}</th>
              <th className="py-2 font-medium">{O.yes}</th>
              <th className="py-2 font-medium">{O.booked}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {versions.map((v) => (
              <tr key={v.version} className="border-b border-border">
                <td className="py-2">
                  {v.version}{' '}
                  {v.version === live.version ? <Badge variant="gray">{O.liveBadge}</Badge> : null}
                </td>
                <td className="py-2">{v.messages.toLocaleString()}</td>
                <td className="py-2">{v.positive.toLocaleString()}</td>
                <td className="py-2">{v.booked.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <p className="text-[12px] text-text-3">{O.countsOnly}</p>
    </Card>
  );
}
