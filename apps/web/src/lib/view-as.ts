/**
 * Viewing the app as a teammate (20261018000100). The view a business's pages are in is kept in a cookie scoped to
 * that business's own path, so only its pages carry it, and every request they make names it to the API in the
 * `x-hfos-view-as` header: Server Components through apiServer, the browser through apiBrowser. The API decides
 * whether the view holds; the cookie only says which one to ask about.
 */
export const VIEW_AS_COOKIE = 'hfos-view-as';

export interface ViewCookie {
  readonly viewId: string;
  /** Whose view it is, so a page's "you" is them while it lasts. The API reads the view itself, never this. */
  readonly personId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pathOf = (workspaceId: string) => `/app/w/${workspaceId}`;

export function parseViewCookie(value: string | undefined | null): ViewCookie | null {
  const [viewId, personId] = (value ?? '').split('.');
  return viewId && personId && UUID.test(viewId) && UUID.test(personId)
    ? { viewId, personId }
    : null;
}

/** The view the page open in this browser is in, if any. Browser only. */
export function readViewCookie(): ViewCookie | null {
  const found = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${VIEW_AS_COOKIE}=`));
  return parseViewCookie(found?.slice(VIEW_AS_COOKIE.length + 1));
}

/** Until the browser closes, or Stop viewing. Browser only. */
export function rememberView(workspaceId: string, view: ViewCookie): void {
  document.cookie = `${VIEW_AS_COOKIE}=${view.viewId}.${view.personId}; path=${pathOf(workspaceId)}; samesite=lax`;
}

export function forgetView(workspaceId: string): void {
  document.cookie = `${VIEW_AS_COOKIE}=; path=${pathOf(workspaceId)}; max-age=0; samesite=lax`;
}
