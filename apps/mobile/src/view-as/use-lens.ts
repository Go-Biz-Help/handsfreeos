import * as React from 'react';

import { useOptionalBusiness } from '@/components/shell/business-context';

import { lensOf, type Lens } from './state';

/** What the teammate being viewed as sees of the copy (20261018000100); null when nobody is being viewed as. */
export function useLens(): Lens | null {
  const viewing = useOptionalBusiness()?.viewing ?? null;
  return React.useMemo(() => lensOf(viewing), [viewing]);
}
