/**
 * Which networks the extension works on for the person (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "How it
 * fits: one add-on, a kit per network": a network that's off runs nothing, reads nothing and shows nothing). Two
 * things say so, and both must:
 *
 * - **HandsFreeOS:** the person turned the network on in their settings (`settings.networks`), and the business allows
 *   it (`rules.networksAllowed`), as the extension last loaded them for whoever is signed in (../hfos/follow.ts).
 *   While nobody's signed in, or before they load, each network is as its kit starts: Facebook on, as it always was,
 *   and any other off.
 * - **Chrome:** a network whose sites are asked for when it's turned on (`optional`) works only once the person
 *   pressed Allow; Facebook's are the manifest's own.
 *
 * The background keeps the answer in `hfos.networks` (./scripts.ts), where every tab's script reads it, and the panel
 * shows a network on in HandsFreeOS that Chrome hasn't allowed (../panel/networks.ts).
 */
import { PLATFORM_KEYS, type Platform } from '@hfos/core/addons/outreach/networks';
import type { Kit } from './kit';

export const NETWORKS_KEY = 'hfos.networks';

export interface NetworkState {
  /** HandsFreeOS says the person works it: on in their settings, and the business allows it. */
  readonly on: boolean;
  /** Chrome lets the extension on its sites. */
  readonly allowed: boolean;
}
export type NetworkStates = Partial<Record<Platform, NetworkState>>;

/** The settings as the extension keeps them from HandsFreeOS: only what says which networks are on. */
export interface NetworksSaid {
  readonly userId: string;
  readonly settings: {
    readonly networks?: Partial<Record<Platform, { readonly on?: boolean } | undefined>>;
  };
  readonly rules: { readonly networksAllowed?: readonly Platform[] };
}

type KitStart = Pick<Kit, 'platform' | 'startsOn' | 'optional'>;

/**
 * Whether HandsFreeOS says the person works a network, from their settings: on in them, and allowed by the business
 * (HandsFreeOS always lists Facebook; every network when a build of it didn't say). As the kit starts when the
 * settings don't say.
 */
export function onInHfos(kit: KitStart, said: NetworksSaid): boolean {
  const on = said.settings.networks?.[kit.platform]?.on ?? kit.startsOn;
  return on && (said.rules.networksAllowed ?? PLATFORM_KEYS).includes(kit.platform);
}

/**
 * Each network as it stands: on in HandsFreeOS for whoever is signed in (`userId`; the kit's start while nobody is, or
 * their settings aren't loaded yet), and allowed by Chrome (`granted`, for the networks it asks for).
 */
export function networkStates(
  kits: readonly KitStart[],
  said: NetworksSaid | null,
  userId: string | null,
  granted: Partial<Record<Platform, boolean>>,
): NetworkStates {
  const theirs = said && userId !== null && said.userId === userId ? said : null;
  return Object.fromEntries(
    kits.map((kit) => [
      kit.platform,
      {
        on: theirs ? onInHfos(kit, theirs) : kit.startsOn,
        allowed: !kit.optional || granted[kit.platform] === true,
      },
    ]),
  ) as NetworkStates;
}

/** Whether the extension works on a network now: on in HandsFreeOS and allowed by Chrome; as its kit starts when untold. */
export function isWorking(kit: KitStart, states: NetworkStates | null | undefined): boolean {
  const state = states?.[kit.platform];
  return state ? state.on && state.allowed : kit.startsOn && !kit.optional;
}

/** Whether a value kept as the networks' states looks like one. */
export function isStates(value: unknown): value is NetworkStates {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).every(
    ([platform, state]) =>
      (PLATFORM_KEYS as readonly string[]).includes(platform) &&
      typeof (state as NetworkState | null)?.on === 'boolean' &&
      typeof (state as NetworkState | null)?.allowed === 'boolean',
  );
}

/** The networks' states as kept, or null when none are (or what's kept isn't one). */
export async function statesNow(): Promise<NetworkStates | null> {
  try {
    const kept: unknown = (await chrome.storage.local.get(NETWORKS_KEY))[NETWORKS_KEY];
    return isStates(kept) ? kept : null;
  } catch {
    return null;
  }
}
