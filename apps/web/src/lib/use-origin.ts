'use client';
import { useSyncExternalStore } from 'react';

const noop = () => () => {};

/** This site's origin in the browser ("https://app.handsfreeos.com"); empty on the server. */
export function useOrigin(): string {
  return useSyncExternalStore(
    noop,
    () => window.location.origin,
    () => '',
  );
}
