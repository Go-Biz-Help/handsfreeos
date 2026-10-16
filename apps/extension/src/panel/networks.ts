/**
 * The networks, in the side panel (src/networks/on.ts): a network the person turned on in HandsFreeOS that Chrome
 * hasn't let the extension on yet gets a plain line and **Allow on LinkedIn**, which asks Chrome (Chrome asks only
 * from the person's own click, so the button is here); and a network that warned them today gets a red note naming
 * it. Facebook's warning is Next up's (./status.ts), where the runner works. A network that's off shows nothing.
 * LinkedIn's runner (src/auto/linkedin.ts) says what it's doing in a line of its own.
 */
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { isState, LINKEDIN_STATE_KEY, type AutoState } from '../auto/plan';
import { warnedByNetwork, WARNED_KEY, type WarnedByNetwork } from '../hfos/warned';
import { facebook, KIT_LIST, type Kit } from '../networks';
import { isStates, NETWORKS_KEY, type NetworkStates } from '../networks/on';
import { button, h, type Child } from './dom';

let box: HTMLElement | null = null;
let states: NetworkStates | null = null;
let warned: WarnedByNetwork = {};
/** Each network's own runner, as it keeps itself: LinkedIn's. */
let runners: Partial<Record<Platform, AutoState>> = {};
const RUNNER_KEYS: Partial<Record<Platform, string>> = { linkedin: LINKEDIN_STATE_KEY };
/** The networks Chrome was asked about from here and said no to, until it says yes. */
const refused = new Set<Platform>();

const today = () => new Date().toLocaleDateString('en-CA');

/** Asks Chrome to let the extension on a network's sites. Called straight from the click: Chrome needs that. */
function allow(kit: Kit): void {
  chrome.permissions
    .request({ origins: [...kit.hosts] })
    .then(
      (granted) => granted,
      () => false,
    )
    .then((granted) => {
      // Allowed: the background hears it, starts the network's script and keeps the new state, which redraws this.
      if (granted) refused.delete(kit.platform);
      else refused.add(kit.platform);
      draw();
    });
}

/** What the panel says about one network: why it does nothing there yet, or its warning today. */
function partsFor(kit: Kit): Child[] {
  const state = states?.[kit.platform];
  if (!state?.on) return [];
  const name = kit.network.name;
  if (!state.allowed)
    return [
      h(
        'p',
        { class: 'warn-line', role: refused.has(kit.platform) ? 'alert' : undefined },
        refused.has(kit.platform)
          ? `Chrome didn’t let the extension on ${name}, so it does nothing there. Press Allow on ${name} and pick Allow in Chrome’s box, or turn ${name} off in HandsFreeOS under Social Outreach → Settings.`
          : `${name} is on for you in HandsFreeOS, but Chrome hasn’t let the extension on ${name} yet, so it notes nothing there. Press Allow on ${name}, then Allow in Chrome’s box.`,
      ),
      button(`Allow on ${name}`, () => allow(kit), { primary: true }),
    ];
  // Facebook's warning is in Next up, beside the runner it stops.
  const words = kit === facebook ? null : warned[kit.platform];
  if (!words || words.day !== today()) {
    const line = runners[kit.platform]?.line;
    return line ? [h('p', { class: 'run-line', role: 'status' }, `${name}: ${line}`)] : [];
  }
  return [
    h(
      'p',
      { class: 'warning-note', role: 'alert' },
      `${name} warned you today (“${words.words[0] ?? ''}”). The extension stops on ${name} until tomorrow, and your daily limits there are halved for a week. Your other networks go on as before.`,
    ),
  ];
}

function draw(): void {
  if (!box) return;
  const parts = KIT_LIST.flatMap(partsFor).filter((part): part is Node | string => Boolean(part));
  box.hidden = parts.length === 0;
  box.replaceChildren(...parts);
}

async function read(): Promise<void> {
  try {
    const runnerKeys = Object.values(RUNNER_KEYS);
    const found = await chrome.storage.local.get([NETWORKS_KEY, WARNED_KEY, ...runnerKeys]);
    const kept: unknown = found[NETWORKS_KEY];
    states = isStates(kept) ? kept : null;
    warned = warnedByNetwork(found[WARNED_KEY]);
    runners = Object.fromEntries(
      Object.entries(RUNNER_KEYS).flatMap(([platform, key]) => {
        const state: unknown = found[key];
        return isState(state) ? [[platform, state]] : [];
      }),
    );
  } catch {
    states = null;
    warned = {};
    runners = {};
  }
  draw();
}

/** Draws the networks' lines into `into`, and again whenever they change. */
export function startNetworks(into: HTMLElement): void {
  box = into;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === 'local' &&
      (NETWORKS_KEY in changes ||
        WARNED_KEY in changes ||
        Object.values(RUNNER_KEYS).some((key) => key in changes))
    )
      void read();
  });
  void read();
}
