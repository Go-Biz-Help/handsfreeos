import { change, changes } from '@/changes';

import { sendReply, type TrayPhoto } from '../send';

/**
 * Replying from the phone with buttons, a card or a carousel (RCS, 0103): the photos and a carousel's pictures go
 * to the customer's files first, the message waits for all of them, and only the photos ride on the message itself.
 */

jest.mock('@/changes', () => ({
  change: jest.fn(),
  changes: { addPhoto: jest.fn() },
  newId: () => 'client-1',
}));
jest.mock('@/changes/photo-device', () => ({ removePhoto: jest.fn(), takePhoto: jest.fn() }));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MIKE = '33333333-3333-4333-8333-333333333333';

const photo = (fileId: string): TrayPhoto =>
  ({ fileId, localName: `${fileId}.jpg` }) as unknown as TrayPhoto;

beforeEach(() => {
  let n = 0;
  jest.mocked(changes.addPhoto).mockReset();
  jest.mocked(changes.addPhoto).mockImplementation(async () => {
    n += 1;
    return { id: `photo-change-${n}` } as Awaited<ReturnType<typeof changes.addPhoto>>;
  });
  jest.mocked(change).mockReset();
  jest
    .mocked(change)
    .mockResolvedValue({ id: 'message-change' } as Awaited<ReturnType<typeof change>>);
});

const base = {
  workspaceId: WS,
  conversationId: CONV,
  personId: MIKE,
  channel: 'sms' as const,
  body: 'Two offers this week.',
  quiet: null,
};

it('sends a carousel’s pictures to Mike’s files first, and the text waits for them', async () => {
  const rich = {
    kind: 'carousel' as const,
    cards: [
      {
        body: 'Tune-up, $89',
        mediaFileId: 'card-a',
        buttons: [{ type: 'reply' as const, title: 'Book it' }],
      },
      {
        body: 'Ducts, $149',
        mediaFileId: 'card-b',
        buttons: [{ type: 'reply' as const, title: 'Book those' }],
      },
    ],
  };
  await sendReply({ ...base, photos: [], rich, cardPhotos: [photo('card-a'), photo('card-b')] });
  expect(changes.addPhoto).toHaveBeenCalledTimes(2);
  expect(jest.mocked(changes.addPhoto).mock.calls.map((call) => call[2])).toEqual([
    { fileId: 'card-a' },
    { fileId: 'card-b' },
  ]);
  expect(change).toHaveBeenCalledWith(
    'message.send',
    expect.objectContaining({ body: 'Two offers this week.', rich, attachmentFileIds: [] }),
    { dependsOn: ['photo-change-1', 'photo-change-2'] },
  );
});

it('sends buttons with a text, and a card’s photo as the message’s own', async () => {
  const rich = { kind: 'card' as const, title: 'Tune-up: $89', buttons: [] };
  await sendReply({ ...base, photos: [photo('tune-up')], rich });
  expect(change).toHaveBeenCalledWith(
    'message.send',
    expect.objectContaining({ rich, attachmentFileIds: ['tune-up'] }),
    { dependsOn: ['photo-change-1'] },
  );
});

it('never puts buttons on an email', async () => {
  await sendReply({
    ...base,
    channel: 'email',
    photos: [],
    rich: { kind: 'buttons', buttons: [{ type: 'reply', title: 'Yes' }] },
  });
  expect(jest.mocked(change).mock.calls[0]![1]).not.toHaveProperty('rich');
});

it('answers a client in their portal, as the web does, with nothing but the words', async () => {
  await sendReply({
    ...base,
    channel: 'portal',
    body: 'I’ll send you the draft tonight to look over.',
    photos: [],
    rich: { kind: 'buttons', buttons: [] },
  });
  expect(changes.addPhoto).not.toHaveBeenCalled();
  expect(change).toHaveBeenCalledWith(
    'message.send',
    {
      workspaceId: WS,
      conversationId: CONV,
      channel: 'portal',
      body: 'I’ll send you the draft tonight to look over.',
      attachmentFileIds: [],
      clientId: 'client-1',
    },
    { dependsOn: [] },
  );
});

it('answers on Messenger with its photos, which go to the customer’s files first', async () => {
  await sendReply({
    ...base,
    channel: 'messenger',
    body: 'Here’s the part we’d swap in.',
    photos: [photo('f-1')],
  });
  expect(changes.addPhoto).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenCalledWith(
    'message.send',
    {
      workspaceId: WS,
      conversationId: CONV,
      channel: 'messenger',
      body: 'Here’s the part we’d swap in.',
      attachmentFileIds: ['f-1'],
      clientId: 'client-1',
    },
    { dependsOn: ['photo-change-1'] },
  );
});
