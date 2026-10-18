'use client';
/**
 * The Partner card on a customer's page (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2d): whether they're one
 * of the business's partners (Make them a partner, `partner.add`, when they aren't), and which partner sent them
 * (`partner.referral_set` to mark it by hand). Only while partners are on here, and only for whoever holds Manage
 * partners; the card stays out of the way while it loads or can't.
 */
import {
  ADDON_CATALOG,
  coreFeatureRunning,
  formatDate,
  money,
  PARTNERS_WORDS as W,
} from '@hfos/core';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useCan, useWorkspaceShell } from '@/components/shell/workspace-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PartnerOfPersonOut, PartnerRow } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';

export function PartnerCard({
  workspaceId,
  personId,
  name,
  archived,
}: {
  workspaceId: string;
  personId: string;
  name: string;
  archived: boolean;
}) {
  const { addons } = useWorkspaceShell();
  const on = coreFeatureRunning(ADDON_CATALOG, addons, 'partners');
  const manages = useCan('partners.manage');
  const live = useLiveVersion(['partner', 'person'], 300);
  const [got, setGot] = useState<PartnerOfPersonOut | null>(null);
  const [partners, setPartners] = useState<readonly PartnerRow[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!on || !manages) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/partner.of_person', { body: { workspaceId, personId } })
      .then((r) => {
        if (!cancelled) setGot(unwrap(r));
      })
      .catch(() => {
        if (!cancelled) setGot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, personId, on, manages, live, version]);

  // The partners to pick from, once someone asks to change who sent them.
  useEffect(() => {
    if (!picking || partners) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/partner.list', { body: { workspaceId } })
      .then((r) => {
        if (!cancelled) setPartners(unwrap(r).partners);
      })
      .catch((e) => {
        if (!cancelled) toast.error(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [picking, partners, workspaceId]);

  if (!on || !manages || !got?.inUse) return null;

  async function act(run: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await run();
      toast.success(done);
      setPicking(false);
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const base = `/app/w/${workspaceId}/settings/partners`;
  const sentBy = got.referredBy;
  // Anyone but them, and nobody whose partnership has ended, unless they're the one who sent them.
  const choices = (partners ?? []).filter(
    (p) => p.personId !== personId && (p.status !== 'ended' || p.partnerId === sentBy?.partnerId),
  );
  return (
    <Card className="px-5 py-[18px]" data-testid="partner-card">
      <h3 className="mb-2 text-[15px] font-semibold">{W.card.title}</h3>
      {got.partner ? (
        <p className="text-[13px] text-text-2" data-testid="partner-card-is">
          {W.card.isPartner(got.partner.status)}{' '}
          <Link
            href={`${base}/${got.partner.partnerId}`}
            className="font-medium text-accent-text hover:underline"
          >
            {W.card.open}
          </Link>
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-text-2">{W.card.makeHint}</p>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={archived}
            loading={busy && !picking}
            onClick={() =>
              void act(
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/partner.add', {
                      body: { workspaceId, personId },
                    }),
                  ),
                W.card.made(name),
              )
            }
            data-testid="partner-card-make"
          >
            {W.card.make}
          </Button>
        </div>
      )}

      <div className="mt-3 border-t border-border pt-3">
        <div className="flex items-start justify-between gap-2 text-[13px]">
          <span className="text-text-3">{W.card.sentBy}</span>
          {archived || picking ? null : (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="text-accent-text hover:underline"
              data-testid="partner-card-change"
            >
              {W.card.change}
            </button>
          )}
        </div>
        {picking ? (
          <Select
            selectSize="sm"
            className="mt-1.5 w-full"
            aria-label={W.card.pick}
            disabled={busy || !partners}
            value={sentBy?.partnerId ?? ''}
            onChange={(e) =>
              void act(
                async () =>
                  unwrap(
                    await apiBrowser().POST('/v1/commands/partner.referral_set', {
                      body: { workspaceId, personId, partnerId: e.target.value || null },
                    }),
                  ),
                W.card.saved,
              )
            }
            data-testid="partner-card-pick"
          >
            <option value="">{W.card.nobody}</option>
            {choices.map((p) => (
              <option key={p.partnerId} value={p.partnerId}>
                {p.name}
              </option>
            ))}
          </Select>
        ) : sentBy ? (
          <div className="mt-0.5" data-testid="partner-card-sent-by">
            <Link
              href={`${base}/${sentBy.partnerId}`}
              className="text-[13.5px] font-medium hover:underline"
            >
              {sentBy.name}
            </Link>
            <p className="text-[12.5px] text-text-2">
              {W.card.how[sentBy.how]} · {formatDate(sentBy.referredAt)}
            </p>
            {sentBy.earnedCents ? (
              <p className="text-[12.5px] text-text-2">
                {W.card.earnedThem(money(sentBy.earnedCents))}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-0.5 text-[13.5px] text-text-2" data-testid="partner-card-sent-by">
            {W.card.nobody}
          </p>
        )}
        {picking && partners && !choices.length ? (
          <p className="mt-1.5 text-[12.5px] text-text-3">{W.card.noPartners}</p>
        ) : null}
      </div>
    </Card>
  );
}
