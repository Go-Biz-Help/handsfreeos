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

/**
 * The address this workspace's public links live on: its own domain when one is serving (M17), otherwise
 * whatever the browser is on. `useOrigin` is still called unconditionally, so the rules of hooks hold and a
 * business without a domain gets exactly what it got before.
 */
export function usePublicOrigin(brandedOrigin: string | null | undefined): string {
  const self = useOrigin();
  return brandedOrigin ?? self;
}
