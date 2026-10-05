import { PortalAddonPage } from '@/components/portal/portal-pages';

/** One of an add-on's pages in the portal (`a/<id>/<path>`), drawn through the web's registry of add-ons. */
export default async function PortalAddon({
  params,
}: {
  params: Promise<{ addonId: string; path?: string[] }>;
}) {
  const { addonId, path } = await params;
  return <PortalAddonPage addonId={addonId} path={path ?? []} />;
}
