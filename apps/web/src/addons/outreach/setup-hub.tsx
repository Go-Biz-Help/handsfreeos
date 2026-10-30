'use client';
/**
 * Social Outreach's Set up page (docs/outreach.md, decision 129): the "Next: …" line while a step is left, every step of
 * the setup where it stands (each opening the setup at that step, ./setup-view.tsx), and Get ready on each network the
 * person works (./get-ready.tsx), which was on Today. It's first in the side menu while anything's left
 * (./setup-row.tsx), and Settings → You opens it after. Everything ticks as it's done, here, in another tab or on the
 * person's computer.
 */
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { adviceLeft } from '@hfos/core/addons/outreach/readiness';
import { SET_UP_PAGE_WORDS as U, setupDoneOf } from '@hfos/core/addons/outreach/set-up-page';
import { outreachSetupPath, SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { CircleCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { GetReadyCard } from './get-ready';
import { laidOut } from './setup-api';
import { RailList, SetupBanner } from './setup-view';
import type { Asks, Readiness, Setup } from './types';

export function SetupHub({
  workspaceId,
  setup: start,
  readiness,
  asks,
}: {
  workspaceId: string;
  setup: Setup;
  /** Get ready on each network the person works: those that could be had. */
  readiness: readonly { readonly platform: Platform; readonly readiness: Readiness }[];
  /** Their profile's read and bio, asked of their computer: null when they couldn't be had. */
  asks: Asks | null;
}) {
  // A step done in another tab, on the computer or the phone, or the business's part changed: it ticks.
  useLiveRefresh([
    'outreach_setup',
    'outreach_automation',
    'outreach_playbook',
    'outreach_computer',
    'outreach_day',
    'main_offer',
    'addon',
  ]);
  const router = useRouter();
  const [setup, setSetup] = useState(start);
  useEffect(() => setSetup(start), [start]);
  const { done, of } = setupDoneOf(laidOut(setup));
  return (
    <div className="space-y-5" data-testid="outreach-set-up">
      <SetupBanner
        workspaceId={workspaceId}
        setup={setup}
        onHidden={(kept) => {
          setSetup(kept);
          router.refresh();
        }}
      />
      {setup.next ? null : (
        <p
          className="flex items-center gap-2 rounded-menu bg-success-soft px-3.5 py-2.5 text-[13.5px] text-success-text"
          data-testid="outreach-set-up-done"
        >
          <CircleCheck className="h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden />
          {U.allDone}
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="space-y-3 self-start p-4" data-testid="outreach-set-up-steps">
          <div className="px-2.5">
            <h2 className="text-[15px] font-semibold">{U.stepsTitle}</h2>
            <p className="mt-0.5 text-[12.5px] text-text-3">{U.stepsAbout}</p>
          </div>
          <RailList workspaceId={workspaceId} setup={setup} at="done" />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-2.5 pt-3">
            <span
              className="text-[12.5px] tabular-nums text-text-2"
              data-testid="outreach-set-up-count"
            >
              {SETUP_WORDS.progress(done, of)}
            </span>
            <ButtonLink
              size="sm"
              variant="ghost"
              href={outreachSetupPath(workspaceId, { again: true })}
              data-testid="outreach-set-up-again"
            >
              {SETUP_WORDS.again}
            </ButtonLink>
          </div>
        </Card>
        <section className="min-w-0 space-y-4" aria-labelledby="outreach-set-up-ready-title">
          <div>
            <h2 id="outreach-set-up-ready-title" className="text-[15px] font-semibold">
              {U.getReadyTitle}
            </h2>
            <p className="mt-0.5 text-[13px] text-text-2">{U.getReadyAbout}</p>
          </div>
          {readiness.length ? (
            readiness.map(({ platform, readiness: r }) => {
              const name = PLATFORMS[platform];
              return (
                <div
                  key={platform}
                  className="space-y-2"
                  data-testid={`outreach-set-up-ready-${platform}`}
                >
                  <h3 className="text-[13px] font-semibold text-text-2">{name}</h3>
                  {r.ready && !adviceLeft(r.items).length ? (
                    <p
                      className="flex items-center gap-2 rounded-card border border-border bg-card px-4 py-3 text-[13.5px] text-text-2"
                      data-testid={`outreach-set-up-ready-${platform}-done`}
                    >
                      <CircleCheck
                        className="h-4 w-4 flex-none text-success"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      {U.readyOn(name)}
                    </p>
                  ) : (
                    <GetReadyCard workspaceId={workspaceId} readiness={r} asks={asks} />
                  )}
                </div>
              );
            })
          ) : (
            <p className="text-[13px] text-text-2" data-testid="outreach-set-up-no-networks">
              {U.noNetworks}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
