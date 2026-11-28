import {
  buildKeyboardBusiness,
  buildKeyboardData,
  holds,
  type KeyboardBusinessInput,
  type KeyboardTemplateRow,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { AppState } from 'react-native';

import { useBusiness } from '@/components/shell/business-context';
import { brandedDomain } from '@/forms/use-answers';
import { api, ApiError, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { useGrants } from '@/lib/grants';

import {
  onKeyboardRefresh,
  readStoredKeyboard,
  setKeyboardStatus,
  storeKeyboard,
  type KeyboardProblem,
} from './store';

/**
 * Keeps the HandsFreeOS keyboard's copy of the business open now up to date (docs/phone-keyboard.md): its booking
 * pages, live forms, review link and website from this phone's copy of the business, as they change, and its
 * templates from HandsFreeOS when the business opens, when the app comes back after a while, and on Update now.
 * Draws nothing. Not while viewing as a teammate: the keyboard is the signed-in person's own.
 */

/** How long fetched templates count as fresh when the app comes back to the front. */
const TEMPLATES_FRESH_MS = 5 * 60_000;

const WORKSPACE_SQL = 'SELECT name, settings FROM workspaces WHERE id = ?';
const SITE_SQL = 'SELECT slug, name, enabled FROM booking_sites WHERE workspace_id = ? LIMIT 1';
const CALENDARS_SQL =
  'SELECT name, slug, status, public, created_at FROM calendars WHERE workspace_id = ?';
// Only live forms reach the phone (the sync rules' `status = 'live'`).
const FORMS_SQL = 'SELECT name, slug, mode FROM forms WHERE workspace_id = ?';
// The business's own number and address, as the worker's {{business.phone}} and {{business.email}} pick them.
const PHONE_SQL = `SELECT e164 FROM phone_numbers WHERE workspace_id = ? AND status = 'active'
  ORDER BY created_at DESC LIMIT 1`;
const EMAIL_SQL =
  'SELECT address FROM email_addresses WHERE workspace_id = ? ORDER BY is_default DESC, created_at LIMIT 1';

interface Fetched {
  readonly templates: readonly KeyboardTemplateRow[] | null;
  readonly origin: string;
  readonly problem: KeyboardProblem;
  readonly at: number;
}

function settingsOf(json: string | null | undefined): unknown {
  if (!json) return {};
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

export function KeepKeyboardFresh() {
  const { business, me } = useBusiness();
  const grants = useGrants();
  const canUseInbox = holds(grants, 'inbox.use');
  const id = business.id;

  const workspace = useQuery<{ name: string | null; settings: string | null }>(WORKSPACE_SQL, [id]);
  const site = useQuery<{
    slug: string | null;
    name: string | null;
    enabled: number | boolean | null;
  }>(SITE_SQL, [id]);
  const calendars = useQuery<{
    name: string | null;
    slug: string | null;
    status: string | null;
    public: number | boolean | null;
    created_at: string | null;
  }>(CALENDARS_SQL, [id]);
  const forms = useQuery<{ name: string | null; slug: string | null; mode: string | null }>(
    FORMS_SQL,
    [id],
  );
  const phone = useQuery<{ e164: string | null }>(PHONE_SQL, [id]);
  const email = useQuery<{ address: string | null }>(EMAIL_SQL, [id]);

  const [fetched, setFetched] = React.useState<Fetched | null>(null);
  const fetchedRef = React.useRef<Fetched | null>(null);
  fetchedRef.current = fetched;

  const fetchNow = React.useCallback(async () => {
    setKeyboardStatus({ refreshing: true });
    const [templates, domain] = await Promise.all([
      canUseInbox
        ? api
            .POST('/v1/queries/template.list', { body: { workspaceId: id } })
            .then(unwrap)
            .then((out) => ({
              rows: out.templates as readonly KeyboardTemplateRow[],
              problem: null,
            }))
            .catch((e: unknown) => ({
              rows: null,
              problem: (e instanceof ApiError && e.status === 403
                ? 'not_yours'
                : 'signal') as KeyboardProblem,
            }))
        : Promise.resolve({ rows: null, problem: 'not_yours' as KeyboardProblem }),
      brandedDomain(id),
    ]);
    const origin =
      domain && domain.status === 'verified' && domain.certificateReady
        ? `https://${domain.domain}`
        : config.webUrl;
    setFetched({ templates: templates.rows, origin, problem: templates.problem, at: Date.now() });
    setKeyboardStatus({ refreshing: false, problem: templates.problem });
  }, [canUseInbox, id]);

  // When the business opens, and when Update now asks.
  React.useEffect(() => {
    setFetched(null);
    void fetchNow();
    return onKeyboardRefresh(fetchNow);
  }, [fetchNow]);

  // Back to the front after a while: the templates may have changed on the web.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const last = fetchedRef.current?.at ?? 0;
      if (state === 'active' && Date.now() - last > TEMPLATES_FRESH_MS) void fetchNow();
    });
    return () => sub.remove();
  }, [fetchNow]);

  const members = React.useMemo(() => new Set(me.businesses.map((b) => b.id)), [me.businesses]);
  const row = workspace.data[0];
  const siteRow = site.data[0];

  React.useEffect(() => {
    if (!fetched || !row) return;
    const input: KeyboardBusinessInput = {
      id,
      name: row.name ?? business.name,
      settings: settingsOf(row.settings),
      site: siteRow
        ? {
            slug: siteRow.slug,
            name: siteRow.name,
            enabled: siteRow.enabled === true || siteRow.enabled === 1,
          }
        : null,
      origin: fetched.origin,
      phoneE164: phone.data[0]?.e164 ?? null,
      email: email.data[0]?.address ?? null,
      calendars: calendars.data.map((c) => ({
        name: c.name ?? '',
        slug: c.slug,
        status: c.status ?? '',
        public: c.public,
        createdAt: c.created_at,
      })),
      forms: forms.data.map((f) => ({ name: f.name ?? '', slug: f.slug, mode: f.mode ?? 'form' })),
      templates: fetched.templates,
      // When the templates were fetched, so a copy rebuilt for nothing new is the same copy, and isn't saved again.
      now: new Date(fetched.at).toISOString(),
    };
    const previous = readStoredKeyboard();
    let built = buildKeyboardBusiness(input);
    // No signal this time: the templates the keyboard already has stay until they can be fetched again.
    if (fetched.templates === null && fetched.problem === 'signal') {
      const before = previous?.businesses.find((b) => b.id === id);
      if (before) built = { ...built, templates: before.templates };
    }
    storeKeyboard(buildKeyboardData(previous, built, members));
  }, [
    fetched,
    row,
    siteRow,
    phone.data,
    email.data,
    calendars.data,
    forms.data,
    id,
    business.name,
    members,
  ]);

  return null;
}
