import { OWN_MAIL_DRAFT_WORDS as W } from '@hfos/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';
import { AppState, type AppStateStatus, Text } from 'react-native';

import { OwnMailDraftCard, OwnMailDraftUsed } from '@/components/inbox/own-mail-draft';
import { toast } from '@/components/ui/toast';
import { useOwnMailDraft } from '@/inbox/use-own-mail-draft';
import { api, ApiError } from '@/lib/api';

/**
 * The AI teammate's draft on someone's own mail, in a thread on the phone ("Let Ava read this mail", the owner
 * 22 Nov 2026), with HandsFreeOS played by a stand-in: the draft is asked for and shown after the newest mail, Use
 * this draft puts its words in the message box and sends nothing, No thanks puts it away, and a draft that answers
 * older mail never shows.
 */

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  api: { POST: jest.fn() },
}));
jest.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
}));
jest.mock('@/lib/auth', () => ({
  session: { accessToken: async () => 'token-1', signOut: jest.fn(async () => undefined) },
}));
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
  subscribeNetwork: () => () => undefined,
  isTestOffline: () => false,
  appFetch: jest.fn(),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const MAIL = '44444444-4444-4444-8444-444444444444';
const OLDER = '55555555-5555-4555-8555-555555555555';
const BODY = 'Hi Dana,\n\nThursday at 2 works. See you then.\n\nBlake';

type Draft = { body: string; forMessageId: string; at: string; by: string } | null;
let draft: Draft = null;
let refuseDismiss = false;
const post = jest.mocked(api.POST) as unknown as jest.Mock;
const asked = (path: string) => post.mock.calls.filter(([p]) => p === path).length;

/** The thread's own part of the screen: the card after the newest mail, and the message box its words go in. */
function Harness({ newest }: { newest: string | null }) {
  const own = useOwnMailDraft(WS, THREAD, newest);
  const [body, setBody] = React.useState('');
  const [used, setUsed] = React.useState<string | null>(null);
  return (
    <>
      {own.draft ? (
        used === own.draft.forMessageId ? (
          <OwnMailDraftUsed by={own.draft.by} />
        ) : (
          <OwnMailDraftCard
            draft={own.draft}
            busy={own.dismissing}
            onUse={() => {
              setBody(own.draft!.body);
              setUsed(own.draft!.forMessageId);
            }}
            onDismiss={() => void own.dismiss()}
          />
        )
      ) : null}
      <Text testID="box">{body}</Text>
    </>
  );
}

let onAppState: ((state: AppStateStatus) => void) | null = null;

beforeEach(() => {
  mockOnline = true;
  refuseDismiss = false;
  draft = { body: BODY, forMessageId: MAIL, at: '2026-11-22T15:00:00.000Z', by: 'Ava' };
  onAppState = null;
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    onAppState = listener as (state: AppStateStatus) => void;
    return { remove: () => undefined };
  });
  post.mockReset();
  const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });
  post.mockImplementation(async (path: string) => {
    if (path === '/v1/queries/conversation.get') return ok({ aiDraft: draft });
    if (path === '/v1/commands/conversation.ai_draft_dismiss') {
      if (refuseDismiss) throw new ApiError('Try again in a minute.', 503, 'unavailable', 'retry');
      draft = null;
      return ok({ conversationId: THREAD, dismissed: true });
    }
    throw new Error(`not expected: ${path}`);
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('shows the draft after the newest mail, and Use this draft puts its words in the message box', async () => {
  await render(<Harness newest={MAIL} />);
  const card = await screen.findByTestId('own-mail-draft');
  expect(post).toHaveBeenCalledWith('/v1/queries/conversation.get', {
    body: { workspaceId: WS, conversationId: THREAD },
  });
  expect(card).toHaveTextContent(W.title('Ava'), { exact: false });
  expect(card).toHaveTextContent(W.onlyYou, { exact: false });
  expect(card).toHaveTextContent(W.nothingSent, { exact: false });
  expect(screen.getByTestId('own-mail-draft-body')).toHaveTextContent(BODY);

  await fireEvent.press(screen.getByTestId('own-mail-draft-use'));
  expect(screen.getByTestId('box')).toHaveTextContent(BODY);
  expect(screen.getByTestId('own-mail-draft-used')).toHaveTextContent(W.inBox('Ava'));
  expect(screen.queryByTestId('own-mail-draft')).toBeNull();
  // Nothing went anywhere: the words are theirs to change and send.
  expect(post.mock.calls.every(([path]) => path === '/v1/queries/conversation.get')).toBe(true);
});

it('puts the draft away with No thanks, and keeps it when that didn’t go through', async () => {
  refuseDismiss = true;
  await render(<Harness newest={MAIL} />);
  await fireEvent.press(await screen.findByTestId('own-mail-draft-dismiss'));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Try again in a minute.'));
  expect(screen.getByTestId('own-mail-draft')).toBeTruthy();

  refuseDismiss = false;
  await fireEvent.press(screen.getByTestId('own-mail-draft-dismiss'));
  await waitFor(() => expect(screen.queryByTestId('own-mail-draft')).toBeNull());
  expect(post).toHaveBeenCalledWith('/v1/commands/conversation.ai_draft_dismiss', {
    body: { workspaceId: WS, conversationId: THREAD },
  });
  expect(screen.getByTestId('box')).toHaveTextContent('');
});

it('never shows a draft that answers older mail, and asks again for the new mail’s', async () => {
  jest.useFakeTimers();
  draft = { body: 'An answer to the mail before.', forMessageId: OLDER, at: '', by: 'Ava' };
  await render(<Harness newest={MAIL} />);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(100);
  });
  expect(asked('/v1/queries/conversation.get')).toBe(1);
  expect(screen.queryByTestId('own-mail-draft')).toBeNull();

  // The AI teammate finishes writing a little after the mail lands.
  draft = { body: BODY, forMessageId: MAIL, at: '', by: 'Ava' };
  await act(async () => {
    await jest.advanceTimersByTimeAsync(8_000);
  });
  expect(asked('/v1/queries/conversation.get')).toBe(2);
  expect(screen.getByTestId('own-mail-draft-body')).toHaveTextContent(BODY);

  // It has its draft, so it stops asking.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(60_000);
  });
  expect(asked('/v1/queries/conversation.get')).toBe(2);
});

it('asks again when the app comes back to the front', async () => {
  draft = null;
  await render(<Harness newest={MAIL} />);
  await waitFor(() => expect(asked('/v1/queries/conversation.get')).toBe(1));
  expect(screen.queryByTestId('own-mail-draft')).toBeNull();

  draft = { body: BODY, forMessageId: MAIL, at: '', by: 'Ava' };
  await act(async () => {
    onAppState?.('active');
  });
  expect(await screen.findByTestId('own-mail-draft')).toBeTruthy();
});

it('asks nothing when they’ve answered, the thread isn’t their own mail, or there’s no signal', async () => {
  const { rerender } = await render(<Harness newest={null} />);
  expect(post).not.toHaveBeenCalled();

  mockOnline = false;
  await rerender(<Harness newest={MAIL} />);
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByTestId('own-mail-draft')).toBeNull();
});
