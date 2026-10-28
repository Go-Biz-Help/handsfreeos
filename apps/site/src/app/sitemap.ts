import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { urls } from '@/content/site';
import { opinly } from '@/lib/opinly/client';
import { absoluteUrl, blogPaths, routePath } from '@/lib/opinly/paths';

/**
 * The site's own pages, then every blog page Opinly says exists (`/v1/content/routes`), with the date each
 * last changed.
 *
 * Built per request from the cached API answer, so a newly published post is listed as soon as Opinly's
 * webhook drops the cache. If Opinly cannot be reached, the site's own pages are still listed: a sitemap that
 * errors tells a crawler nothing at all.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const pages = [
    '',
    '/features',
    '/pricing',
    '/app',
    '/affiliates',
    '/support',
    '/privacy',
    '/terms',
    '/affiliates/terms',
  ];
  const lastModified = new Date();
  const site: MetadataRoute.Sitemap = pages.map((path) => ({
    url: `${urls.site}${path}`,
    lastModified,
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : 0.7,
  }));

  let blog: MetadataRoute.Sitemap = [];
  try {
    const routes = await opinly.routes();
    blog = routes.map((route) => ({
      url: absoluteUrl(routePath(route)),
      lastModified: new Date(route.lastModified),
      changeFrequency: route.type === 'post' ? 'monthly' : 'weekly',
      priority: route.type === 'home' ? 0.8 : route.type === 'post' ? 0.6 : 0.4,
    }));
    // The two directory pages are ours, not Opinly's, so its route list never names them.
    const newest = routes.reduce(
      (latest, r) => (r.lastModified > latest ? r.lastModified : latest),
      '',
    );
    for (const path of [blogPaths.categories(), blogPaths.authors()]) {
      blog.push({
        url: absoluteUrl(path),
        lastModified: newest ? new Date(newest) : lastModified,
        changeFrequency: 'weekly',
        priority: 0.3,
      });
    }
  } catch (error) {
    console.warn(`[sitemap] blog routes unavailable: ${(error as Error).message}`);
  }

  return [...site, ...blog];
}
