/**
 * The blog's RSS feed, from `/v1/content/rss`.
 *
 * Built per request from the cached API answer (the same `opinly` tag the webhook drops), so a feed reader sees a
 * new post as soon as the page for it exists. If Opinly cannot be reached the feed answers 503 with a
 * Retry-After, which readers understand as "come back later" — an empty 200 would read as "every post is gone".
 */
import { connection } from 'next/server';
import { company, urls } from '@/content/site';
import { opinly } from '@/lib/opinly/client';
import { absoluteUrl, blogPaths } from '@/lib/opinly/paths';
import type { OpinlyRssItem } from '@/lib/opinly/types';

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Characters XML 1.0 forbids outright; one stray control character makes a reader reject the whole feed.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const rfc822 = (iso: string): string | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toUTCString();
};

export async function GET(): Promise<Response> {
  await connection();
  let items: OpinlyRssItem[];
  try {
    items = await opinly.rss(50);
  } catch (error) {
    console.warn(`[rss] Opinly unavailable: ${(error as Error).message}`);
    return new Response('The feed is unavailable right now.', {
      status: 503,
      headers: { 'Retry-After': '600', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const blogUrl = absoluteUrl(blogPaths.index());
  const feedUrl = absoluteUrl(blogPaths.rss());
  const newest = items.map((i) => rfc822(i.date)).find(Boolean);

  const entries = items
    .map((item) => {
      const link = absoluteUrl(blogPaths.post(item.slug));
      const date = rfc822(item.date);
      return [
        '    <item>',
        `      <title>${escapeXml(item.title)}</title>`,
        `      <link>${escapeXml(link)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(link)}</guid>`,
        item.description ? `      <description>${escapeXml(item.description)}</description>` : null,
        date ? `      <pubDate>${date}</pubDate>` : null,
        ...(item.categories ?? []).map((c) => `      <category>${escapeXml(c)}</category>`),
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(`${company.product} blog`)}</title>
    <link>${escapeXml(blogUrl)}</link>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(`Articles from ${company.product} for people who run a small service business.`)}</description>
    <language>en-us</language>
    <copyright>${escapeXml(`© ${company.legalName}`)}</copyright>
    <image>
      <url>${escapeXml(`${urls.site}/handsfreeos-mark.png`)}</url>
      <title>${escapeXml(`${company.product} blog`)}</title>
      <link>${escapeXml(blogUrl)}</link>
    </image>
${newest ? `    <lastBuildDate>${newest}</lastBuildDate>\n` : ''}${entries}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
