import type { MetadataRoute } from 'next';
import { urls } from '@/content/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${urls.site}/sitemap.xml`,
  };
}
