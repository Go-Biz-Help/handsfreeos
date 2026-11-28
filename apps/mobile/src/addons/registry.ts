import type { AddonWidgetFacts, CopyGroup } from '@hfos/core';
import type * as React from 'react';

import type { CopyDb, PhoneAddonSearch } from '@/search/copy-sql';

import { ContractorMore } from './contractor/more';
import { ContractorVisitPanel } from './contractor/visit-panel';
import { OutreachMore } from './outreach/more';
import { OutreachSocialCard } from './outreach/social-card';
import { OutreachWidgetFacts } from './outreach/widget';
import { RealestateMore } from './realestate/more';
import { RE_COPY_KINDS, searchRealestateCopy } from './realestate/search';
import { SalescoachCallCard } from './salescoach/call-card';
import { SalescoachMore } from './salescoach/more';
import { SocialcontentMore } from './socialcontent/more';

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
  /**
   * Its row on a visit's page in Calendar: Contractor Operations' work order, for a visit on one of its jobs. Drawn
   * only for someone holding `permission`; nothing for a visit it has nothing on.
   */
  readonly VisitPanel?: React.ComponentType<{ workspaceId: string; appointmentId: string }>;
  /**
   * What it puts on its home-screen widget (docs/phone-widgets.md): Social Outreach's goal and what waits for an OK.
   * Draws nothing: the business's widget keeper renders it for someone holding `permission`, and it reports the
   * widget's figures with `onFacts`. For anyone else the widget says the add-on isn't on for them.
   */
  readonly WidgetFacts?: React.ComponentType<{ onFacts: (facts: AddonWidgetFacts) => void }>;
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
    WidgetFacts: OutreachWidgetFacts,
  },
  {
    addonId: 'salescoach',
    permission: 'salescoach.use',
    More: SalescoachMore,
    CallCard: SalescoachCallCard,
  },
  {
    addonId: 'socialcontent',
    permission: 'socialcontent.use',
    More: SocialcontentMore,
  },
  {
    addonId: 'contractor',
    permission: 'contractor.use',
    More: ContractorMore,
    VisitPanel: ContractorVisitPanel,
  },
];
