/**
 * The demo player (staff only): scripted scenes that play inside the real screens of a business, for recorded videos
 * and live shows. Where a scene is up to lives in one cookie scoped to that business's pages, so Server Components
 * (through apiServer) and the browser (through the fetch it patches) answer the same made-up records. Nothing is
 * sent or saved: the scene's people, messages, drafts and campaigns exist only in the answers this app makes up for
 * them, and real records are never changed or hidden.
 */
export const DEMO_COOKIE = 'hfos-demo';

export interface DemoState {
  /** The scene playing (an id from ./scenes). */
  readonly scene: string;
  /** When each step that has run ran, in ms since `startedAt`; its length is how many have run. */
  readonly steps: readonly number[];
  /** When the scene started (ms since the epoch). */
  readonly startedAt: number;
  /** The business's name, its AI teammate's and its time zone, so made-up messages read as theirs. */
  readonly business: string;
  readonly teammate: string;
  readonly timeZone: string;
  /** The person playing it, for "approved by". */
  readonly me: { readonly id: string; readonly name: string };
}

const pathOf = (workspaceId: string) => `/app/w/${workspaceId}`;

/** The cookie's value as a state, or null when it's missing or unreadable. */
export function parseDemoState(value: string | undefined | null): DemoState | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(value)) as Partial<Record<string, unknown>>;
    const steps = Array.isArray(raw['n']) ? raw['n'].filter((x) => typeof x === 'number') : null;
    if (typeof raw['s'] !== 'string' || !steps || typeof raw['t'] !== 'number') return null;
    return {
      scene: raw['s'],
      steps,
      startedAt: raw['t'],
      business: typeof raw['b'] === 'string' ? raw['b'] : 'Summit Plumbing & Drain',
      teammate: typeof raw['m'] === 'string' ? raw['m'] : 'Ava',
      timeZone: typeof raw['z'] === 'string' ? raw['z'] : 'America/Chicago',
      me: {
        id: typeof raw['i'] === 'string' ? raw['i'] : '00000000-0000-4000-8000-000000000000',
        name: typeof raw['u'] === 'string' ? raw['u'] : 'You',
      },
    };
  } catch {
    return null;
  }
}

function serialize(state: DemoState): string {
  return encodeURIComponent(
    JSON.stringify({
      s: state.scene,
      n: state.steps,
      t: state.startedAt,
      b: state.business,
      m: state.teammate,
      z: state.timeZone,
      i: state.me.id,
      u: state.me.name,
    }),
  );
}

/** The scene playing on the page open in this browser, if any. Browser only. */
export function readDemoState(): DemoState | null {
  const found = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${DEMO_COOKIE}=`));
  return parseDemoState(found?.slice(DEMO_COOKIE.length + 1));
}

/** Until the browser closes, or Exit. Browser only. */
export function writeDemoState(workspaceId: string, state: DemoState): void {
  document.cookie = `${DEMO_COOKIE}=${serialize(state)}; path=${pathOf(workspaceId)}; samesite=lax`;
}

export function clearDemoState(workspaceId: string): void {
  document.cookie = `${DEMO_COOKIE}=; path=${pathOf(workspaceId)}; max-age=0; samesite=lax`;
}
