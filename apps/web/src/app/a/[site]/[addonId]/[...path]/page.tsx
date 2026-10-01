import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { ADDON_UI, type AddonPublicPageProps } from '@/addons/registry';
import { matchPublicPage } from '@/lib/addons/public-pages';
import { publicAddonPage } from '@/lib/api/public-addon';

type Params = Promise<{ site: string; addonId: string; path: string[] }>;

/** The page's look-up, asked once per request for both the title and the page. */
const lookUp = cache(async (site: string, addonId: string, path: string) =>
  answerFor(site, addonId, path.split('/')),
);
const load = ({ site, addonId, path }: Awaited<Params>) => lookUp(site, addonId, path.join('/'));

async function answerFor(
  site: string,
  addonId: string,
  path: readonly string[],
): Promise<AddonPublicPageProps> {
  const match = matchPublicPage(addonId, path);
  if (!match || !ADDON_UI[addonId]?.public) notFound();
  const answer = await publicAddonPage(site, match.query, match.params);
  return {
    site,
    page: match.page,
    params: match.params,
    result: answer.result,
    business: answer.business,
    botCheck: answer.botCheck ?? null,
  };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const p = await params;
  try {
    const props = await load(p);
    return { title: ADDON_UI[p.addonId]?.public?.title?.(props) ?? props.business.name };
  } catch {
    return { title: 'Page' };
  }
}

/**
 * One of an add-on's public pages, signed out: `/a/<business>/<add-on>/<path>`, only a path its manifest declares
 * (`ui.public`), drawn by the add-on through the web's registry from what its public query answered. The worker
 * decides what's published; a page it doesn't know is the 404 page.
 */
export default async function AddonPublicPage({ params }: { params: Params }) {
  const p = await params;
  const props = await load(p);
  const { default: Pages } = await ADDON_UI[p.addonId]!.public!.pages();
  return <Pages {...props} />;
}
