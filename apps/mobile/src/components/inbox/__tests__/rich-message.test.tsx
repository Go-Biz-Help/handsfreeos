import { messageItemOf, readLine, type MessageThreadRow } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { MessageBubble } from '@/components/inbox/thread-items';

/**
 * RCS in the phone's thread (0103), from a synced row through core's `messageItemOf` to the screen: buttons, a card
 * and a carousel as the customer saw them, the RCS tag and when it was read, the plain text a phone without RCS got,
 * and the button a customer's reply came from.
 */

// Pictures load through signed links: here, one made up from where the picture is kept.
jest.mock('@/inbox/storage', () => ({
  useSignedUrl: (bucket: string | null, path: string | null) =>
    bucket && path ? `https://files.test/${path}` : null,
  signedUrl: jest.fn(async () => null),
}));
// The thread's voicemail player plays audio, which has nothing to do with RCS and no player in a test.
jest.mock('@/components/inbox/voicemail-player', () => ({ VoicemailPlayer: () => null }));

const picture = (name: string) => ({
  bucket: 'attachments',
  objectPath: `ws/p/${name}`,
  contentType: 'image/jpeg',
  sizeBytes: 900,
  name,
});

const row = (over: Partial<MessageThreadRow> = {}): MessageThreadRow => ({
  id: 'm1',
  conversation_id: 'c1',
  channel: 'sms',
  direction: 'outbound',
  status: 'delivered',
  from_address: null,
  to_addresses: null,
  cc_addresses: null,
  subject: null,
  body_text: 'Your visit is tomorrow at 2 PM.',
  media: null,
  error_code: null,
  error_message: null,
  sent_by: 'u-dale',
  sent_by_name: 'Dale Porter',
  sent_by_teammate_id: null,
  approved_by: null,
  client_id: null,
  occurred_at: '2026-09-22T14:10:00Z',
  delivered_at: '2026-09-22T14:10:03Z',
  ...over,
});

const buttons = JSON.stringify({
  kind: 'buttons',
  title: null,
  buttons: [
    { type: 'reply', title: 'Confirm', id: 'm1.b0' },
    { type: 'reply', title: 'Reschedule', id: 'm1.b1' },
    { type: 'call', title: 'Call us', id: 'm1.b2', phone: '+17135550142' },
  ],
  cards: [],
  smsText:
    'Your visit is tomorrow at 2 PM.\n\nCall us: (713) 555-0142\n\nReply 1 for Confirm or 2 for Reschedule.',
});

const bubble = (over: Partial<MessageThreadRow>) =>
  render(
    <MessageBubble
      item={messageItemOf(row(over))}
      customerFirstName="Mike"
      timeZone="America/Chicago"
      onCancelHeld={() => undefined}
    />,
  );

describe('RCS in the thread', () => {
  it('shows the buttons the customer could tap, the RCS tag, and when it was read', async () => {
    const readAt = '2026-09-22T14:12:00.000Z';
    await bubble({ rich: buttons, transport: 'rcs', status: 'read', read_at: readAt });
    expect(screen.getByText('Your visit is tomorrow at 2 PM.')).toBeTruthy();
    expect(screen.getAllByTestId('rich-button')).toHaveLength(3);
    expect(screen.getByText('Reschedule')).toBeTruthy();
    expect(screen.getByLabelText('Call us: +17135550142')).toBeTruthy();
    expect(screen.getByTestId('transport')).toHaveTextContent('RCS');
    expect(screen.getByTestId('delivery')).toHaveTextContent(readLine(readAt), { exact: false });
    // It went over RCS, so there's no plain text to open.
    expect(screen.queryByTestId('plain-face')).toBeNull();
  });

  it('opens the plain text a phone without RCS got instead', async () => {
    await bubble({ rich: buttons, transport: 'sms' });
    expect(screen.getByTestId('transport')).toHaveTextContent('· SMS');
    expect(screen.queryByTestId('plain-face-text')).toBeNull();
    await fireEvent.press(screen.getByTestId('plain-face-toggle'));
    expect(screen.getByTestId('plain-face-text')).toHaveTextContent(
      /Reply 1 for Confirm or 2 for Reschedule\./,
    );
  });

  it('draws a card with its photo, title, words and buttons in place of the bubble', async () => {
    await bubble({
      transport: 'rcs',
      body_text: 'A full tune-up before summer.',
      media: JSON.stringify([picture('tune-up.jpg')]),
      rich: JSON.stringify({
        kind: 'card',
        title: 'Spring tune-up: $89',
        buttons: [
          { type: 'link', title: 'Book online', id: 'm1.b0', url: 'https://lonestar.test/book' },
        ],
        cards: [],
        smsText:
          'Spring tune-up: $89\nA full tune-up before summer.\n\nBook online: https://lonestar.test/book',
      }),
    });
    const card = screen.getByTestId('rich-card');
    expect(card).toHaveTextContent(/Spring tune-up: \$89/);
    expect(card).toHaveTextContent(/A full tune-up before summer\./);
    expect(screen.getByLabelText('Book online: https://lonestar.test/book')).toBeTruthy();
    expect(screen.getByLabelText('tune-up.jpg')).toBeTruthy();
    // The card is the message: its photo isn't shown again as an attachment.
    expect(screen.queryByTestId('media-thumb')).toBeNull();
  });

  it('draws a carousel’s cards side by side under the words', async () => {
    await bubble({
      transport: 'rcs',
      body_text: 'Two offers this week.',
      rich: JSON.stringify({
        kind: 'carousel',
        title: null,
        buttons: [],
        cards: [
          {
            title: 'Tune-up',
            body: '$89',
            media: picture('tune-up.jpg'),
            buttons: [{ type: 'reply', title: 'Book the tune-up', id: 'm1.c0.b0' }],
          },
          {
            title: null,
            body: 'Duct cleaning, $149',
            media: picture('ducts.jpg'),
            buttons: [{ type: 'reply', title: 'Book the cleaning', id: 'm1.c1.b0' }],
          },
        ],
        smsText: 'Two offers this week.',
      }),
    });
    expect(screen.getByText('Two offers this week.')).toBeTruthy();
    expect(screen.getByTestId('rich-carousel')).toBeTruthy();
    expect(screen.getAllByTestId('rich-card')).toHaveLength(2);
    expect(screen.getByText('Book the cleaning')).toBeTruthy();
  });

  it('says which button a customer’s reply came from, tapped or texted back', async () => {
    const inbound = {
      direction: 'inbound',
      sent_by: null,
      sent_by_name: null,
      transport: 'rcs',
      delivered_at: null,
    };
    await bubble({
      ...inbound,
      body_text: 'Confirm',
      button_reply: JSON.stringify({
        type: 'reply',
        title: 'Confirm',
        id: 'm1.b0',
        messageId: 'm1',
        via: 'tap',
      }),
    });
    expect(screen.getByTestId('button-reply')).toHaveTextContent('Tapped “Confirm”');
    expect(screen.getByTestId('transport')).toHaveTextContent('RCS');
    await screen.unmount();

    await bubble({
      ...inbound,
      transport: 'sms',
      body_text: '2',
      button_reply: JSON.stringify({
        type: 'reply',
        title: 'Reschedule',
        id: 'm1.b1',
        messageId: 'm1',
        via: 'text',
      }),
    });
    expect(screen.getByTestId('button-reply')).toHaveTextContent('Texted 2 for “Reschedule”');
  });

  it('leaves an ordinary text as it was', async () => {
    await bubble({});
    expect(screen.getByText('Your visit is tomorrow at 2 PM.')).toBeTruthy();
    expect(screen.queryByTestId('rich-buttons')).toBeNull();
    expect(screen.queryByTestId('transport')).toBeNull();
    expect(screen.getByTestId('delivery')).toHaveTextContent('Delivered', { exact: false });
  });
});

describe('a text held for quiet hours', () => {
  const held = (timeZone: string) =>
    render(
      <MessageBubble
        // Due at 8:00 AM in Chicago (13:00 UTC), whatever zone this phone is in.
        item={messageItemOf(
          row({ status: 'queued', error_code: 'scheduled', occurred_at: '2026-09-23T13:00:00Z' }),
        )}
        customerFirstName="Mike"
        timeZone={timeZone}
        onCancelHeld={() => undefined}
      />,
    );

  it('says when it goes on the business’s clock, as the quiet-hours question did', async () => {
    await held('America/Chicago');
    expect(screen.getByTestId('held-line').props.children).toMatch(
      /^Dale · Sends .*8:00 AM, when quiet hours end$/,
    );
  });

  it('reads the same moment where a business in another zone is', async () => {
    await held('America/Los_Angeles');
    expect(screen.getByTestId('held-line').props.children).toMatch(
      /6:00 AM, when quiet hours end$/,
    );
  });
});
