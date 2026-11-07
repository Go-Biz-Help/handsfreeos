/**
 * Whole links for the Assistant. The setup keeps a business's public pages by their path alone
 * (`/book/lonestar/main`), and a path is not a link: the model, given only the end of one, once guessed the
 * address in front and got it wrong. So every public page's path in what a tool found is written out whole
 * before the model reads it, on the business's own domain when one is serving and on ours otherwise, the same
 * address Settings copies. Paths in the app (`/app/…`) are the team's own and stay as they are.
 */
import { AFFILIATE_SITE, isPublicPagePath } from '@hfos/core';
import type { Db } from '@hfos/db/client';
import { query } from './tools-read';
import type { ToolContext } from './runtime';

/** A path standing alone, or after a space, a bracket or a quote in words. */
const PATH = /(^|[\s(["'“‘])(\/[A-Za-z0-9][^\s"'”’<>)\]]*)/g;
/** Where `found` ends once the punctuation closing its sentence is left off: a loop, so no text reads slowly. */
function pathEnd(found: string): number {
  let end = found.length;
  while (end > 1 && '.,;:!?'.includes(found[end - 1]!)) end--;
  return end;
}

/** The words with each public page's path in them written out on `origin`; null when there was none. */
export function wholeLinksIn(text: string, origin: string): string | null {
  let changed = false;
  const out = text.replace(PATH, (whole, before: string, found: string) => {
    const path = found.slice(0, pathEnd(found));
    if (!isPublicPagePath(path.split(/[?#]/)[0]!)) return whole;
    changed = true;
    return `${before}${origin}${found}`;
  });
  return changed ? out : null;
}

/** `value` with every string in it run through `fix`; the same object when nothing changed. */
function mapStrings(value: unknown, fix: (s: string) => string | null): unknown {
  if (typeof value === 'string') return fix(value) ?? value;
  if (Array.isArray(value)) {
    const next = value.map((v) => mapStrings(v, fix));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      next[k] = mapStrings(v, fix);
      if (next[k] !== v) changed = true;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * The address this business's public pages are on, as Settings shows it: its own domain once that is verified
 * and its certificate is ready, else `webUrl`. Anyone in the business may read the domain.
 */
export async function publicOriginFor(db: Db, ctx: ToolContext, webUrl: string): Promise<string> {
  const got = await query<{
    domain: { domain: string; status: string; certificateReady: boolean } | null;
  }>(db, ctx, 'branded_domain.get').catch(() => null);
  const d = got?.domain;
  return d && d.status === 'verified' && d.certificateReady ? `https://${d.domain}` : webUrl;
}

/** The hosts that are ours: the web app's, and the website's (handsfreeos.com), which serves no business's pages. */
function oursOf(webUrl: string): (host: string) => boolean {
  const site = new URL(AFFILIATE_SITE).hostname;
  let app = '';
  try {
    app = new URL(webUrl).hostname;
  } catch {
    // No address known (some tests): only the website is ours.
  }
  return (host) => host === app || host === site || host === `www.${site}`;
}

/**
 * The arguments a model gave, with each link in them to one of the business's public pages put on the address those
 * pages are on. The model read the path from a tool, but the address in front is ours to give, never its guess: a
 * listing's page link on our website's host instead of the app's would reach every contact a campaign goes to as a
 * page that isn't there. Only a link on one of our own hosts moves; one on any other host is left alone, since it may
 * be the business's own website. The address is looked up only when there is a link to move.
 */
export async function onPublicOrigin(
  args: Record<string, unknown>,
  origin: () => Promise<string>,
  webUrl: string,
): Promise<Record<string, unknown>> {
  const ours = oursOf(webUrl);
  const moving = (s: string): URL | null => {
    if (!/^https?:\/\/\S+$/.test(s)) return null;
    try {
      const url = new URL(s);
      return ours(url.hostname) && isPublicPagePath(url.pathname) ? url : null;
    } catch {
      return null;
    }
  };
  let any = false;
  mapStrings(args, (s) => {
    if (!any && moving(s)) any = true;
    return null;
  });
  if (!any) return args;
  const base = (await origin()).replace(/\/+$/, '');
  if (!base) return args;
  return mapStrings(args, (s) => {
    const url = moving(s);
    const whole = url ? `${base}${url.pathname}${url.search}${url.hash}` : null;
    return whole && whole !== s ? whole : null;
  }) as Record<string, unknown>;
}

/**
 * A file the web app hands out to the team, by its path alone: the browser extension's zip (Social Outreach's Download
 * it). Served only on our own address, never a business's domain. A website chat's Try it page is the same: a
 * signed-in page of ours, never the business's.
 */
const APP_FILE =
  /^\/(?:downloads\/[A-Za-z0-9][A-Za-z0-9._-]*|chat-preview\/wk_[A-Za-z0-9]{20}\?w=[0-9a-f-]{36})$/;

/**
 * What a tool found, with each value that is one of the web app's own files by its path written out whole on the web
 * app's address, as its Download button links to it. Left as it was with no address known (some tests).
 */
export function withAppFiles(value: unknown, webUrl: string): unknown {
  const base = webUrl.replace(/\/+$/, '');
  if (!base) return value;
  return mapStrings(value, (s) => (APP_FILE.test(s) ? `${base}${s}` : null));
}

/**
 * What a tool found, with each public page's path in it a whole link. The address is only looked up when there is
 * a path to write out, and with no address known (`webUrl` empty, as in some tests) it is left as it was.
 */
export async function withWholeLinks(
  value: unknown,
  origin: () => Promise<string>,
): Promise<unknown> {
  let any = false;
  mapStrings(value, (s) => {
    if (!any && wholeLinksIn(s, 'x') !== null) any = true;
    return null;
  });
  if (!any) return value;
  const base = (await origin()).replace(/\/+$/, '');
  if (!base) return value;
  return mapStrings(value, (s) => wholeLinksIn(s, base));
}
