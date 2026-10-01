import * as React from 'react';

import type { Business, Me } from '@/lib/businesses';
import type { PhoneView } from '@/view-as/state';

export interface BusinessContextValue {
  /** Who is signed in, always: what this phone keeps for them (their choices, their lock) is under it. */
  readonly userId: string;
  /** Their businesses, and who the screens are for: the teammate, while viewing as one. */
  readonly me: Me;
  /** The business, with the role and permissions the screens follow: the teammate's, while viewing as one. */
  readonly business: Business;
  readonly openSwitcher: () => void;
  /** Viewing the app as a teammate here (20261016000200): read-only, until stopped. */
  readonly viewing?: PhoneView | null;
}

const BusinessContext = React.createContext<BusinessContextValue | null>(null);

export const BusinessProvider = BusinessContext.Provider;

/** The business open now, the person, and the switcher. Only inside /app/w/<business>. */
export function useBusiness(): BusinessContextValue {
  const value = React.useContext(BusinessContext);
  if (!value)
    throw new Error('useBusiness needs a BusinessProvider (the /app/w/[workspaceId] layout).');
  return value;
}

/** The same, or null outside a business (the lock screen, the sign-in screens). */
export function useOptionalBusiness(): BusinessContextValue | null {
  return React.useContext(BusinessContext);
}

/** Where a business's screens live, mirroring the web's /app/w/<business>/…. */
export function businessHref(businessId: string, path = ''): `/app/w/${string}` {
  return `/app/w/${businessId}${path ? `/${path}` : ''}`;
}
