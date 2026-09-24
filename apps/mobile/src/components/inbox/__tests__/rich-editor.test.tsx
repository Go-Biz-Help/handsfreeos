import { checkRich, RICH_WORDS, type RichDraft } from '@hfos/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';

import { Composer } from '@/components/inbox/composer';

/**
 * Buttons, a card or a carousel written on the phone (RCS, 0103), through the composer as the conversation holds it:
 * the editor opens from the composer, shows the plain text a phone without RCS gets as it's written, names the first
 * problem in core's words, and asks for a carousel card's picture from the camera or the library.
 */

jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true }) }));

const DALE = '11111111-1111-4111-8111-111111111111';

const props = {
  userId: DALE,
  mode: 'sms' as const,
  modes: ['sms', 'email'] as const,
  onMode: jest.fn(),
  subject: '',
  onSubject: jest.fn(),
  showSubject: false,
  photos: [],
  onAddPhoto: jest.fn(),
  onRemovePhoto: jest.fn(),
  canPhoto: true,
  note: null,
  off: false,
  first: 'Mike',
  phoneDisplay: '(713) 555-0142',
  fromNumber: '(713) 555-0100',
  fromEmail: null,
  elsewhere: null,
  handover: null,
  online: true,
  editing: false,
  onCancelEdit: jest.fn(),
  busy: false,
  onSend: jest.fn(),
};

/** The composer with its words and draft kept the way the conversation screen keeps them. */
function Conversation({
  canCarousel = true,
  onCardPhoto = jest.fn(),
}: {
  canCarousel?: boolean;
  onCardPhoto?: (cardKey: string, source: 'camera' | 'library') => void;
}) {
  const [body, setBody] = React.useState('');
  const [rich, setRich] = React.useState<RichDraft | null>(null);
  return (
    <Composer
      {...props}
      body={body}
      onBody={setBody}
      rich={rich}
      onRich={setRich}
      richCheck={rich ? checkRich(rich, body, 0) : null}
      canRich
      canCarousel={canCarousel}
      onCardPhoto={onCardPhoto}
    />
  );
}

describe('buttons, a card or a carousel on the phone', () => {
  it('opens from the composer and shows the text a phone without RCS gets, as it’s written', async () => {
    await render(<Conversation />);
    expect(screen.queryByTestId('rich-editor')).toBeNull();
    await fireEvent.press(screen.getByTestId('composer-rich'));
    expect(screen.getByTestId('rich-editor')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('rich-button-title'), 'Confirm');
    await fireEvent.press(screen.getByTestId('rich-add-button'));
    await fireEvent.changeText(screen.getAllByTestId('rich-button-title')[1]!, 'Reschedule');
    expect(screen.getByText(RICH_WORDS.writeToSee)).toBeTruthy();
    await fireEvent.changeText(
      screen.getByTestId('composer-body'),
      'Your visit is tomorrow at 2 PM.',
    );
    expect(screen.getByTestId('rich-plain-face')).toHaveTextContent(
      'Your visit is tomorrow at 2 PM.\n\nReply 1 for Confirm or 2 for Reschedule.',
    );

    // A call button starts on the business's own number.
    await fireEvent.press(screen.getAllByTestId('rich-button-call')[1]!);
    expect(screen.getAllByTestId('rich-button-target')[0]).toHaveProp('value', '(713) 555-0100');

    await fireEvent.press(screen.getByTestId('rich-close'));
    expect(screen.queryByTestId('rich-editor')).toBeNull();
  });

  it('names the first problem in core’s words: a card needs a title', async () => {
    await render(<Conversation />);
    await fireEvent.press(screen.getByTestId('composer-rich'));
    await fireEvent.press(screen.getByTestId('rich-kind-card'));
    await fireEvent.changeText(
      screen.getByTestId('composer-body'),
      'A full tune-up before summer.',
    );
    expect(screen.getByTestId('rich-problem')).toHaveTextContent('Give the card a title.');
    await fireEvent.changeText(screen.getByTestId('rich-card-title'), 'Spring tune-up: $89');
    expect(screen.queryByTestId('rich-problem')).toBeNull();
    expect(screen.getByTestId('rich-plain-face')).toHaveTextContent(/^Spring tune-up: \$89/);
  });

  it('asks for a carousel card’s picture, and needs a customer for one', async () => {
    const onCardPhoto = jest.fn();
    const view = await render(<Conversation onCardPhoto={onCardPhoto} />);
    await fireEvent.press(screen.getByTestId('composer-rich'));
    await fireEvent.press(screen.getByTestId('rich-kind-carousel'));
    expect(screen.getAllByTestId('rich-card-editor')).toHaveLength(2);
    await fireEvent.press(screen.getAllByTestId('rich-card-picture')[1]!);
    await fireEvent.press(screen.getByTestId('card-photo-library'));
    await waitFor(() => expect(onCardPhoto).toHaveBeenCalledWith(expect.any(String), 'library'));

    await view.rerender(<Conversation canCarousel={false} />);
    await fireEvent.press(screen.getByTestId('composer-rich'));
    await fireEvent.press(screen.getByTestId('composer-rich'));
    expect(screen.getByTestId('rich-kind-carousel')).toBeDisabled();
    expect(screen.getByText(RICH_WORDS.carouselNeedsCustomer)).toBeTruthy();
  });

  it('isn’t offered where buttons can’t go', async () => {
    await render(
      <Composer {...props} body="" onBody={jest.fn()} canRich={false} onRich={jest.fn()} />,
    );
    expect(screen.queryByTestId('composer-rich')).toBeNull();
  });
});
