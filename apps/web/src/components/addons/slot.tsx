'use client';
import { ADDON_CATALOG, type AddonSlotName } from '@hfos/core';
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { ADDON_UI, type SlotLoader, type SlotProps } from '@/addons/registry';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { AddonBoundary } from './boundary';

type Panel<S extends AddonSlotName> = LazyExoticComponent<ComponentType<SlotProps<S>>>;

/** Each panel's lazy component, by its loader: made once, so drawing the page again doesn't load it again. */
const panels = new Map<object, unknown>();

function panelOf<S extends AddonSlotName>(load: SlotLoader<S>): Panel<S> {
  const made = panels.get(load) as Panel<S> | undefined;
  if (made) return made;
  const panel = lazy(() =>
    load().catch((e: unknown) => {
      // A failed load isn't kept: the next time the page is drawn (Try again), it is fetched again.
      panels.delete(load);
      throw e;
    }),
  );
  panels.set(load, panel);
  return panel;
}

/**
 * A place on a core page where add-ons put their panels (FE-5): `<AddonSlot name="person.panels" workspaceId=…
 * personId=… />`. It draws, in the catalogue's order, the panel of every add-on that runs in this business,
 * declares this slot in its manifest (`ui.slots`) and has one in the web's registry (addons/registry.ts), when
 * the person holds the permission the slot asks for. Each panel's code is fetched only then, and each sits in its
 * own boundary and Suspense, so a slow add-on keeps quiet until it's ready and a broken one never takes the page
 * with it. With no add-on here, it draws nothing at all.
 */
export function AddonSlot<S extends AddonSlotName>({
  name,
  ...entity
}: { readonly name: S } & SlotProps<S>) {
  const { addons, permissions } = useWorkspaceShell();
  const here = ADDON_CATALOG.flatMap((addon) => {
    if (!addons.includes(addon.id)) return [];
    const declared = addon.ui?.slots?.find((s) => s.slot === name);
    if (!declared || (declared.permission && !permissions.includes(declared.permission))) return [];
    const load: SlotLoader<S> | undefined = ADDON_UI[addon.id]?.slots?.[name];
    return load ? [{ addon, load }] : [];
  });
  if (here.length === 0) return null;
  // `name` checked these where the slot was placed, and the registry checked each panel against its slot; from
  // here on every panel is drawn alike.
  const props = entity as unknown as SlotProps;
  return (
    <>
      {here.map(({ addon, load }) => {
        const Panel = panelOf(load) as unknown as ComponentType<SlotProps>;
        return (
          <AddonBoundary key={addon.id} addonName={addon.name}>
            <Suspense fallback={null}>
              <Panel {...props} />
            </Suspense>
          </AddonBoundary>
        );
      })}
    </>
  );
}
