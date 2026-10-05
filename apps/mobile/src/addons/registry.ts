import type * as React from 'react';

import { RealestateMore } from './realestate/more';

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
}

export const PHONE_ADDONS: readonly PhoneAddon[] = [
  { addonId: 'realestate', permission: 'realestate.use', More: RealestateMore },
];
