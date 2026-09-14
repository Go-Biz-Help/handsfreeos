import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

/**
 * The stand-in website for knowledge scans, served on a local port: the worker tests start it (port 0), and so
 * does Playwright through scripts/knowledge-site.ts. It has robots.txt keeping scanners out of /private/ (except
 * /private/open-house, by the longer Allow), a sitemap, a link to another site, a redirect to the cloud
 * metadata address, a 3 MB parts catalog, a page with planted instructions (/specials), and 45 pages
 * reachable in all, so the 40-page cap shows.
 */

const dir = fileURLToPath(new URL('./', import.meta.url));
const read = (name: string) => readFileSync(`${dir}${name}`, 'utf8');
const TOWNS = JSON.parse(read('areas.json')) as string[];

export const townPath = (town: string): string =>
  `/areas/${town.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** The nine hand-written pages (home, about, services, FAQ, contact, specials, areas, open house, catalog) and one per town. */
export const REACHABLE_PAGES = 9 + TOWNS.length;
export const TOWN_NAMES: readonly string[] = TOWNS;

export interface FixtureSite {
  readonly origin: string;
  /** Every path (with its query) the site was asked for, in order. */
  readonly requests: string[];
  /** Serves other HTML at a path (null: back to the fixture), so a rescan sees a change. */
  change(path: string, html: string | null): void;
  close(): Promise<void>;
}

/** A parts catalog of just over 3 MB: a scan keeps the first 2 MB. */
function catalog(): string {
  const rows: string[] = [];
  let size = 0;
  for (let n = 1; size < 3 * 1024 * 1024; n++) {
    const row = `<p>Part ${n}: 45/5 MFD dual run capacitor, in stock at the warehouse.</p>\n`;
    rows.push(row);
    size += row.length;
  }
  return `<!doctype html><html><head><title>Parts catalog</title></head><body><main><h1>Parts catalog</h1>\n${rows.join('')}</main></body></html>`;
}

export async function startFixtureSite(
  opts: { readonly port?: number; readonly host?: string } = {},
): Promise<FixtureSite> {
  const host = opts.host ?? '127.0.0.1';
  const overrides = new Map<string, string>();
  const requests: string[] = [];
  let origin = '';
  const big = catalog();
  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const html = (res: ServerResponse, body: string) =>
    send(res, 200, 'text/html; charset=utf-8', body);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const path = url.pathname;
    requests.push(path + url.search);
    const override = overrides.get(path);
    if (override !== undefined) return html(res, override);
    switch (path) {
      case '/robots.txt':
        return send(res, 200, 'text/plain', read('robots.txt').replaceAll('{{origin}}', origin));
      case '/sitemap.xml':
        return send(
          res,
          200,
          'application/xml',
          read('sitemap.xml').replaceAll('{{origin}}', origin),
        );
      case '/old-offer':
        res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data' });
        return res.end();
      case '/catalog':
        return html(res, big);
      case '/areas':
        return html(
          res,
          read('areas.html').replace(
            '{{links}}',
            TOWNS.map((t) => `        <li><a href="${townPath(t)}">${t}</a></li>`).join('\n'),
          ),
        );
    }
    const town = TOWNS.find((t) => townPath(t) === path);
    if (town) return html(res, read('area.html').replaceAll('{{town}}', town));
    const file = path === '/' ? 'index.html' : `${path.slice(1)}.html`;
    if (!file.includes('..') && /^[a-z0-9/-]+\.html$/.test(file))
      try {
        return html(res, read(file));
      } catch {
        // Not a page: 404 below.
      }
    send(res, 404, 'text/plain', 'Not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  origin = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    change(path, body) {
      if (body === null) overrides.delete(path);
      else overrides.set(path, body);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
