import type { MetadataRoute } from 'next';
import { urls } from '@/content/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [
    '',
    '/features',
    '/pricing',
    '/founding',
    '/app',
    '/support',
    '/privacy',
    '/terms',
  ];
  const lastModified = new Date();
  return pages.map((path) => ({
    url: `${urls.site}${path}`,
    lastModified,
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : 0.7,
  }));
}
