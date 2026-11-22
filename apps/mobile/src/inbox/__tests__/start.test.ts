import { COMPOSE_WORDS } from '@hfos/core';

import { change, changes } from '@/changes';

import { LATEST_THREAD_SQL, startConversation } from '../start';

/**
 * Starting a conversation from the phone (the Inbox's New message; Text and Email on a customer's page): one they
 * already have opens from the phone's copy, signal or none, and one they don't have is started by HandsFreeOS, sent
 * straight away, and opened once it has reached the phone.
 */

let mockOnline = true;
jest.mock('@/lib/network', () => ({ networkSnapshot: () => ({ online: mockOnline }) }));
const mockDb = { getOptional: jest.fn() };
jest.mock('@/changes', () => ({
  change: jest.fn(),
  changes: {
    get open() {
      return { db: mockDb };
    },
    sendQueuedNow: jest.fn(),
    discard: jest.fn(),
  },
}));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MIKE = '33333333-3333-4333-8333-333333333333';
const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const text = {
  workspaceId: WS,
  personId: MIKE,
  name: 'Mike Johnson',
  channel: 'sms' as const,
  counterpart: '+17135550142',
};
const opened = { workspaceId: WS, personId: MIKE, channel: 'sms' };

type Row = Awaited<ReturnType<typeof changes.sendQueuedNow>>;
const row = (state: string, more: object = {}) => ({ state, reason: null, ...more }) as Row;

beforeEach(() => {
  mockOnline = true;
  mockDb.getOptional.mockReset();
  jest.mocked(change).mockReset();
  jest.mocked(change).mockResolvedValue({ id: 'open-1', queued: true });
  jest.mocked(changes.sendQueuedNow).mockReset();
  jest.mocked(changes.discard).mockReset();
});

it('opens the conversation they already have, with no signal and nothing sent', async () => {
  mockOnline = false;
  mockDb.getOptional.mockResolvedValue({ id: CONV, person_id: MIKE });
  expect(await startConversation(text)).toEqual({ ok: true, conversationId: CONV });
  expect(mockDb.getOptional).toHaveBeenCalledWith(LATEST_THREAD_SQL, [WS, 'sms', '+17135550142']);
  expect(change).not.toHaveBeenCalled();
});

it('links a thread with their number that nobody linked yet, without waiting for it', async () => {
  mockDb.getOptional.mockResolvedValue({ id: CONV, person_id: null });
  expect(await startConversation(text)).toEqual({ ok: true, conversationId: CONV });
  expect(change).toHaveBeenCalledWith('conversation.open', opened);
  expect(changes.sendQueuedNow).not.toHaveBeenCalled();
});

it('says a new conversation needs signal, and leaves nothing waiting', async () => {
  mockOnline = false;
  mockDb.getOptional.mockResolvedValue(null);
  expect(await startConversation(text)).toEqual({
    ok: false,
    message: COMPOSE_WORDS.needsSignal('Mike Johnson'),
  });
  expect(change).not.toHaveBeenCalled();
});

it('starts one straight away and opens it once it’s on the phone', async () => {
  mockDb.getOptional
    .mockResolvedValueOnce(null) // no thread with them yet
    .mockResolvedValueOnce(null) // started, not on the phone yet
    .mockResolvedValue({ id: CONV });
  jest
    .mocked(changes.sendQueuedNow)
    .mockResolvedValue(
      row('sent', { answer: JSON.stringify({ conversationId: CONV, created: true }) }),
    );
  expect(await startConversation(text)).toEqual({ ok: true, conversationId: CONV });
  expect(change).toHaveBeenCalledWith('conversation.open', opened);
  expect(changes.sendQueuedNow).toHaveBeenCalledWith('open-1');
  expect(changes.discard).not.toHaveBeenCalled();
});

it('gives HandsFreeOS’s reason when it says no, and discards the change', async () => {
  mockDb.getOptional.mockResolvedValue(null);
  jest.mocked(changes.sendQueuedNow).mockResolvedValue(
    row('refused', {
      reason: 'Mike Johnson has no mobile number yet. Add one to their details to text them.',
    }),
  );
  expect(await startConversation(text)).toEqual({
    ok: false,
    message: 'Mike Johnson has no mobile number yet. Add one to their details to text them.',
  });
  expect(changes.discard).toHaveBeenCalledWith(['open-1']);
});

it('doesn’t leave it waiting when HandsFreeOS can’t be reached', async () => {
  mockDb.getOptional.mockResolvedValue(null);
  jest.mocked(changes.sendQueuedNow).mockResolvedValue(row('waiting'));
  expect(await startConversation(text)).toEqual({ ok: false, message: COMPOSE_WORDS.notReached });
  expect(changes.discard).toHaveBeenCalledWith(['open-1']);
});
