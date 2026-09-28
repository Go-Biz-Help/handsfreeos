'use client';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Each loader's lazy component: made once, so drawing a page again doesn't load its code again. */
const made = new Map<object, unknown>();

/**
 * An add-on's component from the web's registry (addons/registry.ts), fetched the first time it's drawn: a panel in
 * a slot (./slot.tsx) or its settings form (components/settings/add-ons/addon-settings-sheet.tsx). A load that fails
 * isn't kept, so the next time it's drawn (Try again) its code is fetched again.
 */
export function lazyOnce<P>(
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> {
  const known = made.get(load) as LazyExoticComponent<ComponentType<P>> | undefined;
  if (known) return known;
  const component = lazy(() =>
    load().catch((e: unknown) => {
      made.delete(load);
      throw e;
    }),
  );
  made.set(load, component);
  return component;
}
