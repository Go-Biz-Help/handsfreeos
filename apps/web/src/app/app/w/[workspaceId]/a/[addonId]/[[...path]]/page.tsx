import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';

/**
 * Every address under `/app/w/<business>/a/<add-on>/…` that no add-on page answers (0108): an add-on that isn't
 * running here shows as "not available here" in the shell, and one that isn't in the catalogue, or a path the
 * add-on has no page for, as the business's not-found page. So a bookmark, an old link or a teammate's message
 * into an add-on that has since been turned off or removed never crashes, and never leaves a dead page behind.
 *
 * The convention for add-on pages: an add-on adds explicit folders here — `a/<id>/page.tsx` for its first page,
 * `a/<id>/leases/page.tsx` and so on, matching the paths its manifest's `ui.nav` gives — which Next matches before
 * this dynamic route. Each one's body is `addonPage(workspaceId, '<id>', '<permission>', …)` (addons/gate.tsx), so
 * it too is "not available here" the moment its add-on is off, and packages/core/test/web-boundaries.test.ts checks
 * that every page under `a/` does. Its components live in `apps/web/src/addons/<id>/`.
 */
export default async function AddonFallbackPage({
  params,
}: {
  params: Promise<{ workspaceId: string; addonId: string; path?: string[] }>;
}) {
  const { workspaceId, addonId } = await params;
  return addonPage(workspaceId, addonId, null, () => notFound());
}
