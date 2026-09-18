import type { MetadataRoute } from 'next';
import { urls } from '@/content/site';

/**
 * Everything here is public and meant to be found, by search engines and by the assistants people
 * now shop in — so nothing is disallowed, and the crawlers that answer questions are named
 * explicitly rather than left to the default. There is deliberately no `llms.txt`: measurement
 * across hundreds of millions of AI crawler visits shows they fetch HTML and ignore it, and Google
 * has said it does not support it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      // The ones that read a page to answer somebody's question, and cite it.
      { userAgent: 'OAI-SearchBot', allow: '/' },
      { userAgent: 'ChatGPT-User', allow: '/' },
      { userAgent: 'PerplexityBot', allow: '/' },
      { userAgent: 'ClaudeBot', allow: '/' },
      { userAgent: 'Claude-User', allow: '/' },
      { userAgent: 'Google-Extended', allow: '/' },
      { userAgent: 'GPTBot', allow: '/' },
    ],
    sitemap: `${urls.site}/sitemap.xml`,
    host: urls.site,
  };
}
