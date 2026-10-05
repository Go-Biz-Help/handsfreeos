import { ADDON_CATALOG } from '@hfos/core';

/** One part of a public page's address: a slug or an id, never anything that could be a path of its own. */
const PART = /^[A-Za-z0-9_-]{1,100}$/;

/** A path matched to one of the add-on's declared public pages (`ui.public`). */
export interface PublicPageMatch {
  readonly page: string;
  readonly query: string;
  readonly params: Readonly<Record<string, string>>;
}

/** Which of the add-on's public pages the path is, with what each `:name` was; null for any other path. */
export function matchPublicPage(addonId: string, path: readonly string[]): PublicPageMatch | null {
  if (!path.every((p) => PART.test(p))) return null;
  for (const page of ADDON_CATALOG.find((a) => a.id === addonId)?.ui?.public ?? []) {
    const want = page.path.split('/');
    if (want.length !== path.length) continue;
    const params: Record<string, string> = {};
    const fits = want.every((w, i) => {
      if (w.startsWith(':')) {
        params[w.slice(1)] = path[i]!;
        return true;
      }
      return w === path[i];
    });
    if (fits) return { page: page.path, query: page.query, params };
  }
  return null;
}
