import type { CopyGroup } from '@hfos/core';
import type * as React from 'react';

import type { CopyDb, PhoneAddonSearch } from '@/search/copy-sql';

import { OutreachMore } from './outreach/more';
import { OutreachSocialCard } from './outreach/social-card';
import { RealestateMore } from './realestate/more';
import { RE_COPY_KINDS, searchRealestateCopy } from './realestate/search';
import { SalescoachCallCard } from './salescoach/call-card';
import { SalescoachMore } from './salescoach/more';

/**
 * The add-ons this build of the phone draws, and where each sits in core's screens, as the web's
 * `apps/web/src/addons/registry.ts`: the only file outside an add-on's folder (and its own pages under
 * `app/app/w/[workspaceId]/(tabs)/(more)/a/<id>/`) that imports from it. Core's screens show an entry only while the
 * person holds its permission, which they hold only while the add-on runs in the business.
 */
export interface PhoneAddon {
  readonly addonId: string;
  /** What the person needs for any of it (`realestate.use`). */
  readonly permission: string;
  /** Its places at the top of More. */
  readonly More: React.ComponentType;
  /**
   * What search finds in its part of the phone's copy with no signal, as core's groups for `searchCopy`
   * (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Phone: no signal"). Asked only of someone holding `permission`.
   */
  readonly search?: (db: CopyDb, ask: PhoneAddonSearch) => Promise<readonly CopyGroup[]>;
  /**
   * The group kinds `search` answers (`realestate.deals`): one kind's page for any other of its kinds says it needs
   * signal with none, rather than that nothing matched.
   */
  readonly searchKinds?: readonly string[];
  /**
   * What it shows the team over the top of a HandsFreeOS video call (the web's `call.panels`): the Sales Coach's newest
   * card. Drawn only for someone holding `permission`; nothing while it has nothing to say.
   */
  readonly CallCard?: React.ComponentType<{ workspaceId: string }>;
  /**
   * Its card on a customer's page (the web's `person.panels`): Social Outreach's Social card. Drawn only for someone
   * holding `permission`; nothing for a customer it has nothing on.
   */
  readonly PersonPanel?: React.ComponentType<{ workspaceId: string; personId: string }>;
}

export const PHONE_ADDONS: readonly PhoneAddon[] = [
  {
    addonId: 'realestate',
    permission: 'realestate.use',
    More: RealestateMore,
    search: searchRealestateCopy,
    searchKinds: RE_COPY_KINDS,
  },
  {
    addonId: 'outreach',
    permission: 'outreach.use',
    More: OutreachMore,
    PersonPanel: OutreachSocialCard,
  },
  {
    addonId: 'salescoach',
    permission: 'salescoach.use',
    More: SalescoachMore,
    CallCard: SalescoachCallCard,
  },
];
