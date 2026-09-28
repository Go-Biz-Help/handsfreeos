'use client';
import {
  ADDON_MOVE_WORDS,
  ADDON_PAGE_WORDS as W,
  ADDON_STATE_WORDS,
  addonCheckWords,
  type AddonManifest,
  type AddonStateWords,
  type InstallationState,
  type LifecycleAction,
} from '@hfos/core';
import { Blocks } from 'lucide-react';
import { ADDON_UI } from '@/addons/registry';
import { Callout } from '@/components/crm/chips';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button, ButtonLink, type ButtonVariant } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { InstalledAddon } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { needsOf } from './words';

/** Which list an add-on is in: this business has it, it could add it, or it's coming. */
export type AddonPlace = 'installed' | 'available' | 'planned';

/** Something an add-on lets a business do, as its card lists it. */
export interface CardCapability {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

const TONE: Readonly<Record<AddonStateWords['tone'], BadgeVariant>> = {
  on: 'ok',
  off: 'gray',
  busy: 'pending',
  gone: 'member',
};

/** A move's button: the one that gives back, strongest; the ones that take away, quieter. */
const MOVE_VARIANT: Readonly<Record<LifecycleAction, ButtonVariant>> = {
  install: 'primary',
  enable: 'primary',
  disable: 'secondary',
  uninstall: 'ghost',
  purge: 'secondary',
};

/** An add-on's state in words, with a spinner while it's on its way somewhere. */
export function StateBadge({ state }: { state: InstallationState }) {
  const words = ADDON_STATE_WORDS[state];
  return (
    <Badge variant={TONE[words.tone]} data-testid="addon-state" data-tone={words.tone}>
      {words.tone === 'busy' ? (
        <span
          className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
          aria-hidden
        />
      ) : null}
      {words.label}
    </Badge>
  );
}

/**
 * One add-on on the Add-ons page: its name and what it's for, where it stands here, what it lets the business do
 * and what it needs, and the moves open to this person from where it stands. A state on its way somewhere shows
 * progress and offers no move (the worker finishes it within seconds and the page follows).
 */
export function AddonCard({
  addonId,
  name,
  summary,
  manifest,
  capabilities,
  place,
  installed,
  moves,
  pending,
  running,
  highlight,
  open,
  onMove,
  onSettings,
  note,
}: {
  addonId: string;
  name: string;
  summary: string;
  /** Its manifest, from the catalogue this build has; absent for one HandsFreeOS no longer has. */
  manifest: AddonManifest | undefined;
  capabilities: readonly CardCapability[];
  place: AddonPlace;
  installed: InstalledAddon | null;
  /** The moves this person can make on it from where it stands, in order. */
  moves: readonly LifecycleAction[];
  /** The move on its way for it, if any. */
  pending: LifecycleAction | null;
  /** Whether it runs here now (on, and not switched off by HandsFreeOS). */
  running: boolean;
  highlight: boolean;
  /** Where its first page is, when it runs and this person may open it. */
  open: string | null;
  onMove: (action: LifecycleAction) => void;
  /** Opens its settings; absent when it has none to show. */
  onSettings?: () => void;
  /** One line in place of the moves: why it can't be added, or who can turn it on. */
  note?: string | null;
}) {
  const Icon = ADDON_UI[addonId]?.icon ?? Blocks;
  const state = installed?.state ?? null;
  const words = state ? ADDON_STATE_WORDS[state] : null;
  const busy = words?.tone === 'busy';
  const needs = needsOf(manifest);
  const required = needs.filter((n) => n.required);
  const optional = needs.filter((n) => !n.required);
  const planned = place === 'planned';
  const failedChecks = installed?.failedChecks ?? [];
  // Checks are only reported while there's trouble (`lastError`), never the last move's.
  const trouble = !!installed && installed.lastError !== null;
  // On here, but not running: HandsFreeOS has switched it off everywhere for now.
  const paused = state === 'enabled' && !running && !installed?.retired;
  const titleId = `addon-${addonId}-name`;
  const description =
    manifest && manifest.description.trim() !== manifest.summary.trim()
      ? manifest.description
      : null;

  return (
    <Card
      id={`addon-${addonId}`}
      className={cn('scroll-mt-4 p-5 transition-shadow', highlight && 'ring-2 ring-accent')}
      role="group"
      aria-labelledby={titleId}
      data-testid={`addon-${addonId}`}
      data-place={place}
      data-state={state ?? undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-[260px] items-start gap-3">
          <span
            aria-hidden
            className="flex h-9 w-9 flex-none items-center justify-center rounded-menu bg-accent-soft text-accent-text"
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 id={titleId} className="text-[15px] font-semibold tracking-tight">
                {name}
              </h3>
              {state ? (
                <span aria-live="polite">
                  <StateBadge state={state} />
                </span>
              ) : null}
              {planned ? (
                <Badge variant="accent" data-testid="addon-coming-soon">
                  {W.comingSoon}
                </Badge>
              ) : null}
            </div>
            {summary ? <p className="mt-0.5 text-[13px] text-text-2">{summary}</p> : null}
            {words && !paused && !installed?.retired ? (
              <p className="mt-1 text-xs text-text-3" data-testid="addon-state-detail">
                {words.detail}
              </p>
            ) : null}
            {note ? (
              <p className="mt-1.5 text-[13px] font-medium" data-testid="addon-note">
                {note}
              </p>
            ) : null}
          </div>
        </div>
        {!busy && (moves.length || open || onSettings) ? (
          <div className="flex flex-wrap items-center gap-2">
            {open ? (
              <ButtonLink href={open} size="sm" data-testid={`addon-open-${addonId}`}>
                Open
              </ButtonLink>
            ) : null}
            {onSettings ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onSettings}
                aria-label={`Settings for ${name}`}
                data-testid={`addon-settings-open-${addonId}`}
              >
                {W.settings}
              </Button>
            ) : null}
            {moves.map((action) => (
              <Button
                key={action}
                variant={MOVE_VARIANT[action]}
                size="sm"
                className={action === 'purge' ? 'text-danger-text' : undefined}
                loading={pending === action}
                disabled={pending !== null && pending !== action}
                onClick={() => onMove(action)}
                aria-label={`${ADDON_MOVE_WORDS[action].button} ${name}`}
                data-testid={`addon-${action}-${addonId}`}
              >
                {ADDON_MOVE_WORDS[action].button}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {paused ? (
        <Callout tone="neutral" className="mt-4" data-testid={`addon-paused-${addonId}`}>
          {W.paused(name)}
        </Callout>
      ) : null}
      {installed?.retired ? (
        <Callout tone="neutral" className="mt-4" data-testid={`addon-retired-${addonId}`}>
          {W.retired}
        </Callout>
      ) : null}
      {trouble ? (
        <Callout className="mt-4" data-testid={`addon-trouble-${addonId}`}>
          {failedChecks.length ? (
            <>
              {W.troubleChecks}
              <ul className="mt-1 list-disc pl-5">
                {failedChecks.map((check) => (
                  <li key={check}>{addonCheckWords(check)}</li>
                ))}
              </ul>
            </>
          ) : (
            W.trouble
          )}
        </Callout>
      ) : null}

      {description || capabilities.length || manifest ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4 sm:pl-12">
          {description ? <p className="text-[13px] text-text-2">{description}</p> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            {capabilities.length ? (
              <div>
                <h4 className="text-xs font-medium text-text-3">{planned ? W.willDo : W.does}</h4>
                <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="addon-capabilities">
                  {capabilities.map((c) => (
                    <li key={c.id} className="text-[13px]">
                      <span className="font-medium">{c.label}</span>
                      <span className="block text-xs text-text-3">{c.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {manifest ? (
              <div>
                <h4 className="text-xs font-medium text-text-3">
                  {planned ? W.willNeed : W.needs}
                </h4>
                {required.length ? (
                  <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="addon-needs">
                    {required.map((n) => (
                      <li key={n.addonId} className="text-[13px]">
                        <span className="font-medium">{n.name}</span>
                        <span className="block text-xs text-text-3">{n.why}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-[13px] text-text-2">{W.needsNothing}</p>
                )}
                {optional.length ? (
                  <>
                    <h4 className="mt-3 text-xs font-medium text-text-3">{W.worksWith}</h4>
                    <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="addon-works-with">
                      {optional.map((n) => (
                        <li key={n.addonId} className="text-[13px]">
                          <span className="font-medium">{n.name}</span>
                          <span className="block text-xs text-text-3">{n.why}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
