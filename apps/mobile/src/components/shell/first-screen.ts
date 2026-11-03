/**
 * A stack's first screen, kept at its bottom: More's list under every More screen, and Social Outreach's list of pages
 * under each of its pages. A screen opened from somewhere else (a card on Home, the bell, a notification, Search) goes
 * into a stack that may not be open yet, and that stack then starts at the screen. Back had nothing under it there, so
 * it left the tab for Home with the screen still on top, and the tab opened it again every time (Social Outreach's
 * Needs you, 2026-11-03). So when a screen shows with anything else at the bottom, the first screen goes in under it,
 * without moving what's on top, and Back comes to it. Tapping the tab again on such a screen comes to it too, as the
 * stack goes back to its first screen on a second tap.
 *
 * `opensFirst` is given to the stack as its `screenListeners`.
 */

interface Route {
  readonly name: string;
  readonly params?: object;
}

interface StackState {
  readonly index: number;
  readonly routes: Route[];
}

/** What a screen's listener is handed: its navigation, whose state is its stack's. */
interface Listened {
  readonly navigation: {
    getState(): StackState | undefined;
    reset(state: StackState): void;
  };
}

export function opensFirst(
  first: Route,
  /** Whether a route is the first screen: by its name, unless the name alone can't say (one route, many pages). */
  isFirst: (route: Route) => boolean = (route) => route.name === first.name,
) {
  return ({ navigation }: Listened) => ({
    focus: () => {
      const state = navigation.getState();
      const bottom = state?.routes[0];
      if (!state || !bottom || isFirst(bottom)) return;
      navigation.reset({ ...state, index: state.index + 1, routes: [first, ...state.routes] });
    },
  });
}
