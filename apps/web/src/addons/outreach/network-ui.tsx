'use client';
/**
 * A network on Social Outreach's screens (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "Words and the AI"): on
 * every row as its name, never a logo (Chris), and the picker at the top of a page that narrows it to one network. The
 * words and the networks are core's (`@hfos/core/addons/outreach/network-words`).
 */
import { NETWORK_WORDS as NW, readNetwork } from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { netCookie } from './address';

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

/** Keeps the network picked for the pages to come (`netCookie`): `all` for every one. */
export function rememberNetwork(workspaceId: string, net: Platform | null) {
  document.cookie = `${netCookie(workspaceId)}=${net ?? 'all'}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * The network picker at the top of a page (decision 127): every network or one on People's lists, the networks the
 * person works on Today. The one picked is kept, so the next page opens on it too.
 */
export function NetworkPicker({
  workspaceId,
  value,
  networks,
  every,
  hrefOf,
}: {
  workspaceId: string;
  /** The network shown: null for every one. */
  value: Platform | null;
  /** The networks to pick from. */
  networks: readonly Platform[];
  /** Whether All networks is one of the choices. */
  every: boolean;
  /** The page's address for a network picked, keeping what else it shows. */
  hrefOf: (net: Platform | null) => string;
}) {
  const router = useRouter();
  return (
    <Select
      selectSize="sm"
      className="w-auto min-w-[168px]"
      aria-label={NW.filter}
      value={value ?? 'all'}
      onChange={(e) => {
        const net = readNetwork(e.target.value);
        rememberNetwork(workspaceId, net);
        router.push(hrefOf(net));
      }}
      data-testid="outreach-network-picker"
    >
      {every ? <option value="all">{NW.all}</option> : null}
      {networks.map((p) => (
        <option key={p} value={p}>
          {PLATFORMS[p]}
        </option>
      ))}
    </Select>
  );
}
