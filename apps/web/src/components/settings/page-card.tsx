'use client';
/**
 * Settings → Workspace's "Your page" (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "A simple page"):
 * the booking page grown into a one-page site, on or off, with its address. It's the same switch as the setup's "Use
 * this page" (`booking_site.set_page`), and what the page says comes from the business profile and the open hours.
 * On their own domain, once one is serving, the page is the domain's start page.
 */
import { BUSINESS_PAGE_SETTINGS_WORDS as W } from '@hfos/core';
import { ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { CopyField } from '@/components/ui/copy-field';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';

export function PageCard({
  workspaceId,
  site,
  brandedOrigin,
  canChange,
}: {
  workspaceId: string;
  /** The booking site, which the page is; null until the business has one (turning the page on makes it). */
  site: { path: string; page: boolean } | null;
  /** Their own domain when one is serving: the page is its start page. */
  brandedOrigin: string | null;
  /** `calendars.manage`, which the switch needs. */
  canChange: boolean;
}) {
  const router = useRouter();
  const origin = usePublicOrigin(brandedOrigin);
  useLiveRefresh(['booking_site']);
  const [on, setOn] = useState(!!site?.page);
  const [busy, setBusy] = useState(false);

  async function flip(next: boolean) {
    setOn(next);
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/booking_site.set_page', {
          body: { workspaceId, on: next },
        }),
      );
      toast.success(next ? W.turnedOn : W.turnedOff);
      router.refresh();
    } catch (e) {
      setOn(!next);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const link = !on || !site ? null : (brandedOrigin ?? (origin ? `${origin}${site.path}` : null));
  return (
    <Card className="flex flex-col gap-4 p-6" id="your-page" data-testid="page-card">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-tight">{W.title}</h2>
          <p className="mt-1 text-[13px] text-text-2">{W.hint}</p>
        </div>
        <Switch
          checked={on}
          disabled={busy || !canChange}
          onChange={(next) => void flip(next)}
          label={W.label}
          className="mt-1"
          testId="page-card-on"
        />
      </div>
      {link ? (
        <div className="flex flex-col gap-2" data-testid="page-card-link">
          <span className="text-[13px] font-medium">{W.at}</span>
          <div className="flex flex-wrap items-center gap-2">
            <CopyField
              value={link}
              label="Copy the link"
              copied={W.copied}
              className="min-w-0 flex-1"
            />
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-accent-text hover:underline"
            >
              {W.open}
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
            </a>
          </div>
          <p className="text-[12.5px] text-text-3">{W.fill}</p>
        </div>
      ) : null}
      {canChange ? null : <p className="text-[12.5px] text-text-3">{W.cantChange}</p>}
    </Card>
  );
}
