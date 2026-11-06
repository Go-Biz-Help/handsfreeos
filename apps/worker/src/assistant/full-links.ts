/**
 * Whole links for the Assistant. The setup keeps a business's public pages by their path alone
 * (`/book/lonestar/main`), and a path is not a link: the model, given only the end of one, once guessed the
 * address in front and got it wrong. So every public page's path in what a tool found is written out whole
 * before the model reads it, on the business's own domain when one is serving and on ours otherwise, the same
 * address Settings copies. Paths in the app (`/app/…`) are the team's own and stay as they are.
 */
import { isPublicPagePath } from '@hfos/core';
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
