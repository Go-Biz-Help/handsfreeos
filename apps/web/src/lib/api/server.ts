import { createApiClient, isApiErrorBody, type ApiClient } from '@hfos/api-client';
import {
  ADDON_CATALOG,
  NO_SUCH_ROUTE,
  VIEW_AS_HEADER,
  effectivePermissions,
  findAddon,
  type TeammateViewSession,
} from '@hfos/core';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { publicEnv } from '../env';
import { getServerSession } from '../supabase/server';
import { VIEW_AS_COOKIE, parseViewCookie, type ViewCookie } from '../view-as';
import { ApiError, errorMessage, unwrap } from './errors';
import { refusalDigest } from './page-refusals';
import type { Me, WorkspaceGet, WorkspaceSummary } from './types';

export { ApiError, errorMessage, unwrap };

/**
 * `unwrap` for page loads: a 404 from the API renders the 404 page instead of a server error, so a
 * non-member never learns whether a workspace exists and the logs stay quiet.
 *
 * **Except a 404 that means the API has no such route.** This app ships the moment main moves; the API
 * ships after CI passes, twenty-odd minutes later. In between, a page built from the new commit asks for
 * endpoints the running API does not have yet, and every one of them answers 404. Reading those as real
 * 404s put "The page does not exist, or you do not have access to it" on whole settings pages that were
 * fine — the worst thing this screen can say, because it blames the person's account for a deploy that is
 * simply still in flight. A route the API does not know is server trouble, so it throws and is reported as
 * one: wrong for a minute and then right, rather than wrong about whose fault it is.
 *
 * A 403 still throws the ApiError it always did, so a page that leaves out what a person may not see (Money's
 * `allowed`) carries on as before. What changes is where one that nobody catches ends up: it is marked
 * (./page-refusals.ts), and the business's error screen draws it in the shell — "turned off" for an add-on that
 * is off (0108), the not-found page for anything else — instead of Next's bare error page (FE-4).
 */
export function unwrapPage<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.response.status === 404 && !isNoSuchRoute(result.error)) notFound();
  try {
    return unwrap(result);
  } catch (e) {
    // Next hands a server error's digest to the error screen, and keeps one that is already set.
    if (e instanceof ApiError && e.status === 403)
      throw Object.assign(e, { digest: refusalDigest(e.rule) });
    throw e;
  }
}

/** True when a 404 came from the API's router rather than from anything the request asked for. */
function isNoSuchRoute(body: unknown): boolean {
  return isApiErrorBody(body) && body.error.rule === NO_SUCH_ROUTE;
}

/**
 * Typed API client for Server Components; redirects to sign-in when there is no session.
 *
 * On a business's pages that are viewing as a teammate (20261018000100), every request names the view, and `userId`
 * is the teammate's, so a page's "you" (assigned to you, your calendar) is theirs as the API's answers are. `viewing`
 * says so; `signedInAs` is always the person signed in.
 */
export async function apiServer(): Promise<{
  api: ApiClient;
  userId: string;
  email: string;
  signedInAs: string;
  viewing: ViewCookie | null;
}> {
  const session = await getServerSession();
  if (!session) redirect('/sign-in');
  const viewing = parseViewCookie((await cookies()).get(VIEW_AS_COOKIE)?.value);
  const api = createApiClient({
    baseUrl: publicEnv.apiUrl,
    getToken: () => session.accessToken,
    fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
  });
  if (viewing)
    api.use({
      onRequest({ request }) {
        request.headers.set(VIEW_AS_HEADER, viewing.viewId);
        return request;
      },
    });
  return {
    api,
    userId: viewing?.personId ?? session.userId,
    email: session.email,
    signedInAs: session.userId,
    viewing,
  };
}

/**
 * The signed-in user's profile, organizations and workspaces. A valid session whose account no longer
 * exists (deleted, or a reset local database) is signed out instead of erroring.
 *
 * Fetched once per request: the layout and the page both ask for it, and a live refresh renders both again.
 */
export const getMe = cache(async (): Promise<Me> => {
  const { api } = await apiServer();
  const result = await api.POST('/v1/queries/account.me', { body: {} });
  if (result.response.status === 404) redirect('/auth/sign-out?reason=account');
  return unwrap(result);
});

/**
 * Whether the signed-in person answers HandsFreeOS support (`platform.me`). Only a hint for what a page lists, so a
 * failure is null, no answer. Fetched once per request: the settings menu's search and the Account page both ask.
 */
export const getPlatformMe = cache(async () => {
  const { api } = await apiServer();
  return api
    .POST('/v1/queries/platform.me', { body: {} })
    .then(unwrap)
    .catch(() => null);
});

/** The business a page is in, as its shell draws it: the sidebar, the menu, and the gate on add-ons' pages. */
export interface WorkspaceShell {
  /** Its name, the person's role and permissions there, and the add-ons running there (0108). */
  readonly current: WorkspaceSummary;
  /**
   * Set when a HandsFreeOS support person is looking at it (M13), or the founder is working in it as its owner
   * (`acting`, with no end time); null for its own people.
   */
  readonly viewingAs: {
    readonly businessName: string;
    readonly expiresAt: string | null;
    readonly acting: boolean;
  } | null;
  /**
   * Set while the person is viewing the app as a teammate here (20261018000100): `current` is the business as the
   * teammate sees it, their role and permissions, read through the view.
   */
  readonly teammateView: TeammateViewSession | null;
  /** The page carries a view that no longer holds (stopped elsewhere, or no longer theirs to see): forget it. */
  readonly staleView: boolean;
}

/**
 * The business `workspaceId` for the signed-in person, or the 404 page when it isn't theirs to see. Fetched once
 * per request, like `getMe`: the layout draws the shell from it and an add-on's page (addons/gate.tsx) decides
 * from the very same answer whether to open.
 */
export const getWorkspaceShell = cache(async (workspaceId: string): Promise<WorkspaceShell> => {
  const me = await getMe();
  const { api, viewing } = await apiServer();
  // A view the page carries holds only while the API says it is the one open here.
  let teammateView: TeammateViewSession | null = null;
  if (viewing) {
    const open = unwrap(
      await api.POST('/v1/queries/teammate_view.current', { body: { workspaceId } }),
    ).view;
    if (open?.id === viewing.viewId) teammateView = open;
  }
  const staleView = !!viewing && !teammateView;
  const mine = me.workspaces.find((w) => w.id === workspaceId);
  if (mine && !teammateView) return { current: mine, viewingAs: null, teammateView, staleView };
  /**
   * A HandsFreeOS support person looking at this business (M13). They are not a member and never become
   * one: the API serves their look-ups read-only under an open session, and refuses every command. The
   * banner says so, and the business has the same fact in its own audit log. The founder is the one exception:
   * their session works as the owner would, and the business is not told (20261013002100).
   *
   * Anyone viewing as a teammate gets the business as the API reads it through the view: the teammate's.
   */
  // Not one of ours (including users with no workspaces at all, e.g. after being removed):
  // behave like the API (404), never confirm it exists. /app sends workspace-less users to onboarding.
  let workspace: WorkspaceGet | null = null;
  try {
    workspace = unwrap(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  if (mine) return { current: workspace!.workspace, viewingAs: null, teammateView, staleView };
  const looking = unwrap(
    await api.POST('/v1/queries/platform.view_as.current', { body: {} }),
  ).session;
  if (!looking || looking.workspaceId !== workspaceId) notFound();
  const w = workspace!.workspace;
  const viewingAs = {
    businessName: looking.businessName || w.name,
    expiresAt: looking.expiresAt,
    acting: looking.acting,
  };
  // The founder working in it as its owner, or HandsFreeOS viewing it as a teammate: the API answers as it would
  // for them, so the shell shows what it says.
  if (looking.acting || teammateView) return { current: w, viewingAs, teammateView, staleView };
  return {
    // They see every place the business has, as before (0106), its add-ons' included (0108): the API decides
    // what each look-up may read, and refuses every change, so nothing here widens what they can do.
    current: {
      ...w,
      role: 'member',
      permissions: [
        ...effectivePermissions('owner'),
        ...w.addons.flatMap(
          (id) => findAddon(ADDON_CATALOG, id)?.permissions.map((p) => p.key) ?? [],
        ),
      ],
    },
    viewingAs,
    teammateView: null,
    staleView,
  };
});
