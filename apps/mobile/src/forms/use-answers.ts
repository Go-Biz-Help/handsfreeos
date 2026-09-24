import type { paths } from '@hfos/api-client';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { change } from '@/changes';
import type { OutboxRow } from '@/changes/outbox';
import { inputOf, stillStanding } from '@/inbox/outbox';
import { api, errorMessage, unwrap } from '@/lib/api';
import { config } from '@/lib/config';
import { useNetwork } from '@/lib/network';

import { FORM_WORDS, formLink } from './words';

/**
 * A form's answers and its link on the phone (M17): what `form.response_list`, `form.response_get`,
 * `booking_site.get` and `branded_domain.get` answer.
 *
 * **None of it is in the phone's copy.** Answers are what customers said about themselves, sometimes a lot of it, and
 * the sync service only carries the forms a phone can fill in. So these screens are live or say they need a signal,
 * as the balance and the Assistant's chats are. What this phone sent and HandsFreeOS hasn't got yet comes from the
 * phone's own queue instead, so a sheet filled in a basement isn't missing from the list without a word.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type ResponseRow = Ok<'/v1/queries/form.response_list'>['items'][number];
export type ResponseFull = Ok<'/v1/queries/form.response_get'>;
export type ResponseAnswer = ResponseFull['answers'][number];

/**
 * Answer sheets deleted from this phone since the app opened. The list leaves them out at once, so going back to the
 * form after deleting one never shows it for the moment the list takes to ask again.
 */
const deletedHere = new Set<string>();

/** Tests: start again with nothing deleted. */
export function forgetDeletedAnswers(): void {
  deletedHere.clear();
}

/** How many answer sheets come down at a time. The web asks for 50 on a page with room for them. */
const PAGE = 25;

export interface AnswerList {
  readonly items: readonly ResponseRow[];
  /** Nothing to show yet, and an answer on its way. */
  readonly loading: boolean;
  /** Words for what went wrong, or that it needs a signal. Null while it's fine. */
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  reload(): void;
  more(): void;
}

/** Who answered a form, newest first, asked again on Try again and when the phone comes back into signal. */
export function useFormAnswers(workspaceId: string, formId: string): AnswerList {
  const { online } = useNetwork();
  const [state, setState] = React.useState<{
    items: readonly ResponseRow[];
    cursor: string | null;
    loaded: boolean;
  }>({ items: [], cursor: null, loaded: false });
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .POST('/v1/queries/form.response_list', {
        body: { workspaceId, formId, includeUnfinished: false, limit: PAGE },
      })
      .then(unwrap)
      .then((page) => {
        if (!cancelled) setState({ items: page.items, cursor: page.nextCursor, loaded: true });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(online ? errorMessage(e) : FORM_WORDS.needsSignal);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `online` is in here so coming back into signal on this screen fetches it, rather than leaving the "needs a
    // signal" card sitting there until somebody presses Try again.
  }, [formId, online, round, workspaceId]);

  const more = React.useCallback(() => {
    const cursor = state.cursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api
      .POST('/v1/queries/form.response_list', {
        body: { workspaceId, formId, includeUnfinished: false, limit: PAGE, cursor },
      })
      .then(unwrap)
      .then((page) =>
        setState((was) =>
          // The reload that happened while this page was in the air wins: its cursor is no longer this one.
          was.cursor === cursor
            ? { ...was, items: [...was.items, ...page.items], cursor: page.nextCursor }
            : was,
        ),
      )
      .catch((e: unknown) => setError(online ? errorMessage(e) : FORM_WORDS.needsSignal))
      .finally(() => setLoadingMore(false));
  }, [formId, loadingMore, online, state.cursor, workspaceId]);

  return {
    items: state.items.filter((r) => !deletedHere.has(r.responseId)),
    loading: loading && !state.loaded,
    error,
    hasMore: state.cursor !== null,
    loadingMore,
    reload: React.useCallback(() => setRound((r) => r + 1), []),
    more,
  };
}

/** One answer sheet in full, with each question as it read when they answered it. */
export function useFormAnswer(
  workspaceId: string,
  responseId: string,
): {
  readonly data: ResponseFull | null;
  readonly loading: boolean;
  readonly error: string | null;
  reload(): void;
} {
  const { online } = useNetwork();
  const [data, setData] = React.useState<ResponseFull | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .POST('/v1/queries/form.response_get', { body: { workspaceId, responseId } })
      .then(unwrap)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(online ? errorMessage(e) : FORM_WORDS.needsSignal);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [online, responseId, round, workspaceId]);

  return {
    data,
    loading: loading && data === null,
    error,
    reload: React.useCallback(() => setRound((r) => r + 1), []),
  };
}

/**
 * Deletes one answer sheet and its answers (`form_response.delete`): a test of the person's own, or a customer asking
 * to be forgotten. An online command, so `change` sends it straight out and never queues it: a deletion that went out
 * hours later, after somebody had looked again and changed their mind, is not one to leave waiting on a phone. Throws
 * a ChangeError with the API's words, or that it needs signal.
 */
export async function deleteFormAnswer(workspaceId: string, responseId: string): Promise<void> {
  await change('form_response.delete', { workspaceId, responseId });
  deletedHere.add(responseId);
}

/**
 * The form's public link, asked for when somebody presses Share: the business's link name and its own domain aren't
 * in the phone's copy. Throws the words to show when there is no signal or no link name yet.
 */
export async function fetchFormLink(workspaceId: string, formSlug: string): Promise<string> {
  const body = { body: { workspaceId } };
  let site: string | null;
  let domain: Awaited<ReturnType<typeof brandedDomain>>;
  try {
    [site, domain] = await Promise.all([
      api
        .POST('/v1/queries/booking_site.get', body)
        .then(unwrap)
        .then((r) => r.site?.slug ?? null),
      brandedDomain(workspaceId),
    ]);
  } catch (e) {
    throw new Error(e instanceof TypeError ? FORM_WORDS.linkNeedsSignal : errorMessage(e));
  }
  const link = formLink(site, formSlug, domain, config.webUrl);
  if (!link) throw new Error(FORM_WORDS.noSite);
  return link;
}

/**
 * The business's own domain, or null. A failure here falls back to HandsFreeOS's own address, as the web's
 * `brandedOriginFor` does: a link that works is better than no link.
 */
async function brandedDomain(workspaceId: string) {
  try {
    const out = unwrap(await api.POST('/v1/queries/branded_domain.get', { body: { workspaceId } }));
    return out.domain;
  } catch {
    return null;
  }
}

/**
 * How many of this form's answer sheets were filled in on this phone and haven't reached HandsFreeOS yet: waiting for
 * signal, or held for a decision. A refused one is Changes on this phone's to explain, not this list's.
 */
const OUTBOX_SQL = `
  SELECT * FROM outbox
  WHERE workspace_id = ? AND name = 'form_response.record' AND state NOT IN ('sent', 'refused')
  ORDER BY seq`;

export function useAnswersOnThisPhone(workspaceId: string, formId: string): number {
  const { data } = useQuery<OutboxRow>(OUTBOX_SQL, [workspaceId]);
  return React.useMemo(
    () => data.filter((row) => stillStanding(row) && inputOf(row).formId === formId).length,
    [data, formId],
  );
}
