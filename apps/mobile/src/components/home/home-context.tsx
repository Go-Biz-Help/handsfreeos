import type { TeammateDraftShape } from '@hfos/core';
import * as React from 'react';

import type { HomeChange } from '@/home/build';
import type { HomeActions } from '@/home/actions';

/** Everything a card on Home can read: the business, the moment, the team, signal, and what its buttons do. */
export interface HomeEnv {
  readonly workspaceId: string;
  readonly timeZone: string;
  /** The moment the chips are worded for (moves every 30 seconds). */
  readonly now: number;
  readonly myUserId: string;
  readonly members: readonly {
    readonly id: string;
    readonly fullName: string;
    readonly role: string;
  }[];
  /** The business's AI teammate ("Ava"), or null. */
  readonly teammateName: string | null;
  readonly online: boolean;
  /** The AI teammate's drafts waiting, by id: an approval card approves through step 14's decision hook. */
  readonly drafts: ReadonlyMap<string, TeammateDraftShape>;
  /** A refused change's words, by item. */
  readonly refused: ReadonlyMap<string, HomeChange>;
  /** Items HandsFreeOS was asked to handle from here, not through yet. */
  readonly handing: ReadonlySet<string>;
  /** The card a link opened (`?item=`), marked for a moment. */
  readonly highlightId: string | null;
  readonly act: HomeActions;
}

const HomeEnvContext = React.createContext<HomeEnv | null>(null);

export const HomeEnvProvider = HomeEnvContext.Provider;

export function useHomeEnv(): HomeEnv {
  const env = React.useContext(HomeEnvContext);
  if (!env) throw new Error('useHomeEnv is for Home');
  return env;
}
