'use client';
/**
 * A network on Social Outreach's screens (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Words and the AI"): on
 * every row as its name, never a logo (Chris), and the filter that narrows a long list to one network. The words and
 * the networks are core's (`@hfos/core/addons/outreach/network-words`).
 */
import {
  NETWORK_FILTERS,
  NETWORK_WORDS as NW,
  type NetworkFilter,
} from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';

/** The network something is on, by its name, quietly beside it. */
export function NetworkName({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <span
      className={cn('whitespace-nowrap text-[12px] font-medium text-text-3', className)}
      data-testid="network-name"
    >
      {PLATFORMS[platform]}
    </span>
  );
}

/** Every network, or one: narrows a long list (`?net=`). */
export function NetworkFilterControl({
  value,
  onChange,
}: {
  value: Platform | null;
  onChange: (next: Platform | null) => void;
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <Segmented<NetworkFilter>
        ariaLabel={NW.filter}
        value={value ?? 'all'}
        onChange={(v) => onChange(v === 'all' ? null : v)}
        options={NETWORK_FILTERS.map((k) => ({
          value: k,
          label: k === 'all' ? NW.all : PLATFORMS[k],
          testId: `network-filter-${k}`,
        }))}
      />
    </div>
  );
}
