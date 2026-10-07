/**
 * Finishing a Facebook sign-in for the inbox (20261025000200): the person is back from Facebook, signed in to the
 * app as whoever pressed Connect (http/oauth.ts checked that), and what they allowed decides what can connect.
 *
 * One Page, with or without the Instagram account linked to it, connects straight away: that's most businesses, and
 * a question with one answer is no question. Several ask which, as a checklist; an agency's sign-in can hold a
 * hundred Pages and only one is this business's. A Page already answering here is connected again with the fresh
 * sign-in, which is how a broken one is mended. One another business answers is shown and can't be picked.
 *
 * The person's own token waits on the pending sign-in while they choose, sealed, so the answer doesn't carry it;
 * the handoff is what the answer proves, signed in as the same person, on the same ten-minute clock.
 */
import {
  executeCommand,
  HfosError,
  metaAccountConnect,
  metaConnectionActivate,
  textArray,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { metaConnections } from '@hfos/db/schema';
import { and, eq } from 'drizzle-orm';
import type { HttpDeps } from '../http/common';
import type { FinishOutcome, FinishPickOption } from '../http/handoff';
import { errorMessage } from '../outbox';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { META_INSTAGRAM_SCOPES, META_MESSENGER_SCOPES, type MetaPage } from './graph';

/** The pending sign-in, as the shared OAuth lookup finds it. */
export interface MetaSignIn {
  readonly connection_id: string;
  readonly workspace_id: string;
  readonly organization_id: string;
}

export interface MetaCallback {
  readonly code?: string;
  readonly error?: string;
  readonly error_description?: string;
}

/** Where the answer to the checklist is posted. */
export const META_PICK_ANSWER = '/v1/oauth/meta-accounts';

const scopeOf = (row: MetaSignIn): TenantScope => ({
  workspaceId: row.workspace_id,
  organizationId: row.organization_id,
});

export const metaSettingsUrl = (deps: HttpDeps, workspaceId: string) =>
  `${deps.webUrl}/app/w/${workspaceId}/settings/facebook-instagram`;

/** `facebook:<page id>`, `instagram:<account id>`: what the checklist names each by. */
const optionId = (platform: 'facebook' | 'instagram', id: string) => `${platform}:${id}`;

interface Candidate {
  readonly platform: 'facebook' | 'instagram';
  readonly externalId: string;
  readonly page: MetaPage;
  readonly name: string;
  readonly username: string | null;
}

/** Everything this sign-in could connect: each Page, and each Instagram account linked to one, when allowed. */
function candidates(pages: readonly MetaPage[], instagram: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const page of pages) {
    out.push({
      platform: 'facebook',
      externalId: page.id,
      page,
      name: page.name,
      username: null,
    });
    if (instagram && page.instagram)
      out.push({
        platform: 'instagram',
        externalId: page.instagram.id,
        page,
        name: page.instagram.name ?? page.instagram.username ?? page.name,
        username: page.instagram.username,
      });
  }
  return out;
}

/** Who answers each of these now, anywhere on HandsFreeOS. */
async function holders(deps: HttpDeps, list: readonly Candidate[]): Promise<Map<string, string>> {
  if (list.length === 0) return new Map();
  const found = await asWorker(deps.httpDb, {}, (tx) =>
    rows<{ platform: string; external_id: string; workspace_id: string }>(
      tx,
      sql`select platform, external_id, workspace_id
          from private.meta_account_holders(${textArray(list.map((c) => c.externalId))})`,
    ),
  );
  return new Map(found.map((h) => [`${h.platform}:${h.external_id}`, h.workspace_id]));
}

type Standing = 'free' | 'here' | 'elsewhere' | 'no_access';

function standingOf(c: Candidate, held: Map<string, string>, workspaceId: string): Standing {
  const holder = held.get(optionId(c.platform, c.externalId));
  if (holder && holder !== workspaceId) return 'elsewhere';
  if (!c.page.accessToken) return 'no_access';
  return holder ? 'here' : 'free';
}

const NOTES: Readonly<Record<Exclude<Standing, 'free'>, string>> = {
  here: 'Already connected here. It picks up this sign-in.',
  elsewhere: 'Answers its messages in another business on HandsFreeOS. Disconnect it there first.',
  no_access:
    'Your role on this Page can’t answer its messages. Ask one of its admins for Messages access in the Page’s settings, then connect again.',
};

/** Said when nothing came of the sign-in, with the way back. */
const pageOut = (deps: HttpDeps, row: MetaSignIn, title: string, body: string): FinishOutcome => ({
  page: {
    title,
    body,
    link: {
      href: metaSettingsUrl(deps, row.workspace_id),
      label: 'Back to Facebook & Instagram',
    },
  },
});

/**
 * Why a sign-in didn't finish, kept on it. One that ends here without connecting anything forgets the token it got:
 * nothing is left to use it for.
 */
async function note(
  deps: HttpDeps,
  row: MetaSignIn,
  error: string | null,
  ended = false,
): Promise<void> {
  await asWorker(deps.httpDb, scopeOf(row), async (tx) => {
    await tx
      .update(metaConnections)
      .set({ lastError: error ? error.slice(0, 2000) : null })
      .where(eq(metaConnections.id, row.connection_id));
    if (ended)
      await tx
        .update(metaConnections)
        .set({ tokenEnc: null, tokenKeyId: null, tokenExpiresAt: null })
        .where(
          and(eq(metaConnections.id, row.connection_id), eq(metaConnections.status, 'pending')),
        );
  });
}

/** Another try at the same sign-in (a checklist sent twice) finished it first: that one's answer stands. */
const finishedElsewhere = (e: unknown): boolean =>
  e instanceof HfosError && e.rule === 'meta_connection_not_pending';

/** Facebook's answer, from the app: connect what can be, or ask which. */
export async function finishMetaSignIn(
  deps: HttpDeps,
  row: MetaSignIn,
  q: MetaCallback,
): Promise<FinishOutcome> {
  const back = (result: string) => ({
    next: `${metaSettingsUrl(deps, row.workspace_id)}?meta=${result}`,
  });
  if (q.error || !q.code) {
    await note(
      deps,
      row,
      `The sign-in ended without access (${(q.error ?? 'no code').slice(0, 80)}).`,
    );
    return back(q.error === 'access_denied' ? 'cancelled' : 'failed');
  }
  const graph = deps.social.graph;
  const redirectUri = `${deps.publicUrl}/oauth/facebook/callback`;
  try {
    const token = await graph.exchangeCode({ code: q.code, redirectUri });
    // What they allowed, as Meta says: the sign-in screen lets people untick any of it.
    const check = await graph.checkToken(token.accessToken).catch(() => null);
    const scopes = check?.scopes ?? [];
    if (check && META_MESSENGER_SCOPES.some((s) => !scopes.includes(s))) {
      await note(deps, row, 'Some permissions were left unticked on the sign-in screen.');
      return pageOut(
        deps,
        row,
        'Some permissions were left unticked',
        'HandsFreeOS needs to see your Pages and manage their messages to answer them. Choose Connect again, and leave every permission ticked on Facebook’s screen.',
      );
    }
    const me = await graph.me(token.accessToken);
    const pages = await graph.pages(token.accessToken);
    if (pages.length === 0) {
      await note(deps, row, 'That sign-in doesn’t manage any Facebook Page.');
      return pageOut(
        deps,
        row,
        'No Facebook Page to connect',
        'That Facebook account doesn’t manage a Page. Messenger and Instagram messages reach a business through its Facebook Page, so sign in with an account that manages yours, or create a Page first.',
      );
    }
    /*
     * Kept now, still pending, so the checklist's answer doesn't have to carry it; with who it is, so removing the
     * app on Facebook, or asking for their data to be deleted, finds it too.
     */
    await asWorker(deps.httpDb, scopeOf(row), (tx) =>
      tx
        .update(metaConnections)
        .set({
          facebookUserId: me.id,
          facebookUserName: me.name,
          tokenEnc: deps.sealer.seal(token.accessToken),
          tokenKeyId: deps.sealer.keyId,
          tokenExpiresAt: token.expiresAt ? new Date(token.expiresAt) : null,
          scopes: scopes.slice(0, 60).map((s) => s.slice(0, 120)),
          lastError: null,
        })
        .where(eq(metaConnections.id, row.connection_id)),
    );
    const instagram = !check || META_INSTAGRAM_SCOPES.every((s) => scopes.includes(s));
    const list = candidates(pages, instagram);
    const held = await holders(deps, list);
    const standing = list.map((c) => ({ c, s: standingOf(c, held, row.workspace_id) }));
    const free = standing.filter((x) => x.s === 'free');
    const here = standing.filter((x) => x.s === 'here');
    if (free.length === 0 && here.length === 0) {
      const elsewhere = standing.some((x) => x.s === 'elsewhere');
      await note(deps, row, 'Nothing that sign-in manages could be connected here.', true);
      return pageOut(
        deps,
        row,
        elsewhere
          ? 'Those Pages answer in another business'
          : 'You can’t answer those Pages’ messages',
        elsewhere
          ? 'Every Page that sign-in manages already answers its messages in another business on HandsFreeOS. Disconnect it there first, then connect it here.'
          : NOTES.no_access,
      );
    }
    // One Page, and whatever's linked to it: nothing to ask. Nothing new to pick: the ones here pick up the sign-in.
    if (
      (pages.length === 1 && standing.every((x) => x.s === 'free' || x.s === 'here')) ||
      free.length === 0
    )
      return await connectChosen(deps, row, {
        token: token.accessToken,
        tokenExpiresAt: token.expiresAt,
        me,
        scopes,
        chosen: [...free, ...here].map((x) => x.c),
      });
    return {
      pick: {
        title: 'Which Pages should answer here?',
        body: 'Their Messenger and Instagram messages will arrive in this business’s inbox, and replies will go out from them. Pick the ones that belong to this business.',
        submit: 'Connect',
        answer: META_PICK_ANSWER,
        options: standing.map(({ c, s }) => pickOption(c, s, pages.length)),
      },
    };
  } catch (e) {
    if (finishedElsewhere(e)) return back('connected');
    deps.log.warn(
      { connectionId: row.connection_id, err: errorMessage(e) },
      'a Facebook sign-in did not finish',
    );
    await note(deps, row, errorMessage(e), true);
    return back('failed');
  }
}

function pickOption(c: Candidate, s: Standing, pages: number): FinishPickOption {
  const linked = c.platform === 'instagram';
  return {
    id: optionId(c.platform, c.externalId),
    name: linked && c.username ? `@${c.username}` : c.name,
    detail: linked ? `Instagram, linked to ${c.page.name}` : 'Facebook Page · Messenger',
    parent: linked ? optionId('facebook', c.page.id) : null,
    // Already here: ticked, and it stays. With a handful to choose from, nothing new is ticked for them.
    checked: s === 'here' || (s === 'free' && pages === 1),
    disabled: s !== 'free',
    note: s === 'free' ? null : NOTES[s],
  };
}

/** The checklist's answer: what was picked, read against what the sign-in really manages now. */
export async function answerMetaPick(
  deps: HttpDeps,
  row: MetaSignIn,
  ids: readonly string[],
): Promise<FinishOutcome> {
  const [c] = await asWorker(deps.httpDb, scopeOf(row), (tx) =>
    tx
      .select({
        tokenEnc: metaConnections.tokenEnc,
        tokenExpiresAt: metaConnections.tokenExpiresAt,
        scopes: metaConnections.scopes,
      })
      .from(metaConnections)
      .where(eq(metaConnections.id, row.connection_id)),
  );
  if (!c?.tokenEnc)
    return pageOut(
      deps,
      row,
      'This sign-in link has expired',
      'Sign-in links last ten minutes. Go back to Settings → Facebook & Instagram, and choose Connect again.',
    );
  if (ids.length === 0) {
    await note(deps, row, 'Nothing was picked.', true);
    return { next: `${metaSettingsUrl(deps, row.workspace_id)}?meta=cancelled` };
  }
  try {
    const token = deps.sealer.open(c.tokenEnc);
    const me = await deps.social.graph.me(token);
    const pages = await deps.social.graph.pages(token);
    const instagram =
      c.scopes.length === 0 || META_INSTAGRAM_SCOPES.every((s) => c.scopes.includes(s));
    const list = candidates(pages, instagram);
    const held = await holders(deps, list);
    const wanted = new Set(ids);
    // Only what this sign-in really manages, and only what can be picked: the answer is a parameter.
    const chosen = list.filter((x) => {
      const s = standingOf(x, held, row.workspace_id);
      return s === 'here' || (s === 'free' && wanted.has(optionId(x.platform, x.externalId)));
    });
    if (!chosen.some((x) => wanted.has(optionId(x.platform, x.externalId)))) {
      await note(deps, row, 'Nothing picked could be connected.', true);
      return pageOut(
        deps,
        row,
        'Nothing could be connected',
        'The Pages you picked can’t be connected now: another business may have just connected them, or your Facebook role changed. Choose Connect again to see where they stand.',
      );
    }
    return await connectChosen(deps, row, {
      token,
      tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null,
      me,
      scopes: c.scopes,
      chosen,
    });
  } catch (e) {
    if (finishedElsewhere(e))
      return { next: `${metaSettingsUrl(deps, row.workspace_id)}?meta=connected` };
    deps.log.warn(
      { connectionId: row.connection_id, err: errorMessage(e) },
      'Facebook Pages did not connect',
    );
    await note(deps, row, errorMessage(e), true);
    return { next: `${metaSettingsUrl(deps, row.workspace_id)}?meta=failed` };
  }
}

/**
 * The app's own webhook, pointed here with every field read here each time somebody connects, so nobody has to find
 * them in Meta's dashboard (it doesn't offer every app `standby` for Pages). Connecting carries on if Meta says no:
 * the webhook can still be set by hand.
 */
async function pointAppWebhook(deps: HttpDeps): Promise<void> {
  const verifyToken = deps.social.verifyToken;
  if (!verifyToken) return;
  await deps.social.graph
    .subscribeApp({ callbackUrl: `${deps.publicUrl}/webhooks/meta`, verifyToken })
    .then(
      ({ refused }) => {
        if (refused.length)
          deps.log.warn({ refused }, 'Meta wouldn’t send some webhook fields to this app');
      },
      (e: unknown) =>
        deps.log.warn(
          { err: errorMessage(e) },
          'Meta didn’t take the app’s webhook; set it in Meta’s dashboard',
        ),
    );
}

/**
 * The sign-in becomes the business's, Meta is asked to send each chosen Page's messages here, and each Page and
 * Instagram account is connected (again, for one that was here before: its threads carry on).
 */
async function connectChosen(
  deps: HttpDeps,
  row: MetaSignIn,
  input: {
    readonly token: string;
    readonly tokenExpiresAt: string | null;
    readonly me: { readonly id: string; readonly name: string | null };
    readonly scopes: readonly string[];
    readonly chosen: readonly Candidate[];
  },
): Promise<FinishOutcome> {
  const scope = scopeOf(row);
  await executeCommand(
    deps.httpDb,
    metaConnectionActivate,
    {
      workspaceId: row.workspace_id,
      connectionId: row.connection_id,
      facebookUserId: input.me.id,
      facebookUserName: input.me.name,
      scopes: input.scopes.slice(0, 60).map((s) => s.slice(0, 120)),
      tokenEnc: deps.sealer.seal(input.token),
      tokenKeyId: deps.sealer.keyId,
      tokenExpiresAt: input.tokenExpiresAt,
    },
    systemActor(scope),
    workerMeta(),
  );
  await pointAppWebhook(deps);
  // Meta sends a Page's messages, and its Instagram account's, to the apps the Page subscribes: asked once a Page.
  const subscribed = new Map<string, boolean>();
  for (const c of input.chosen) {
    if (subscribed.has(c.page.id) || !c.page.accessToken) continue;
    const ok = await deps.social.graph.subscribe(c.page.id, c.page.accessToken).then(
      () => true,
      (e: unknown) => {
        deps.log.warn(
          { pageId: c.page.id, err: errorMessage(e) },
          'Meta did not agree to send a Page’s messages here; the daily check asks again',
        );
        return false;
      },
    );
    subscribed.set(c.page.id, ok);
  }
  const done = { facebook: 0, instagram: 0, skipped: 0 };
  for (const c of input.chosen) {
    if (!c.page.accessToken) continue;
    try {
      await executeCommand(
        deps.httpDb,
        metaAccountConnect,
        {
          workspaceId: row.workspace_id,
          connectionId: row.connection_id,
          platform: c.platform,
          externalId: c.externalId,
          pageId: c.page.id,
          name: c.name,
          username: c.username,
          tokenEnc: deps.sealer.seal(c.page.accessToken),
          tokenKeyId: deps.sealer.keyId,
          humanAgent: deps.social.humanAgent,
          subscribed: subscribed.get(c.page.id) ?? false,
        },
        systemActor(scope),
        workerMeta(),
      );
      done[c.platform]++;
    } catch (e) {
      // Another business got there between the checklist and the answer: the rest still connect.
      if (!(e instanceof HfosError) || e.rule !== 'meta_account_elsewhere') throw e;
      done.skipped++;
    }
  }
  const q = new URLSearchParams({
    meta: done.facebook + done.instagram > 0 ? 'connected' : 'failed',
    facebook: String(done.facebook),
    instagram: String(done.instagram),
    ...(done.skipped ? { skipped: String(done.skipped) } : {}),
  });
  return { next: `${metaSettingsUrl(deps, row.workspace_id)}?${q}` };
}
