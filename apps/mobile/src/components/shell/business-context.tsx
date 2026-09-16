import * as React from 'react';

import type { Business, Me } from '@/lib/businesses';

export interface BusinessContextValue {
  readonly userId: string;
  readonly me: Me;
  readonly business: Business;
  readonly openSwitcher: () => void;
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
