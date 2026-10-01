import { VIDEO_LINK_WORDS } from '@hfos/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { Composer } from '@/components/inbox/composer';

/**
 * "Ask for a video" in the phone's reply box (20261018000200): offered in a text thread, it asks the screen for a
 * link, and waits while one is being made. Not offered where the link can't go, or while the box is off.
 */

jest.mock('@/lib/network', () => ({ useNetwork: () => ({ online: true }) }));

const props = {
  userId: '11111111-1111-4111-8111-111111111111',
  mode: 'sms' as const,
  modes: ['sms', 'email'] as const,
  onMode: jest.fn(),
  body: '',
  onBody: jest.fn(),
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

it('asks the screen for a link, and waits while one is made', async () => {
  const onAskVideo = jest.fn();
  const view = await render(<Composer {...props} canAskVideo onAskVideo={onAskVideo} />);
  await fireEvent.press(screen.getByRole('button', { name: VIDEO_LINK_WORDS.button }));
  expect(onAskVideo).toHaveBeenCalledTimes(1);

  await view.rerender(<Composer {...props} canAskVideo askingVideo onAskVideo={onAskVideo} />);
  expect(screen.getByTestId('composer-ask-video')).toBeDisabled();
});

it('isn’t offered outside a text thread, or while the box is off', async () => {
  const view = await render(<Composer {...props} onAskVideo={jest.fn()} />);
  expect(screen.queryByTestId('composer-ask-video')).toBeNull();
  await view.rerender(<Composer {...props} off canAskVideo onAskVideo={jest.fn()} />);
  expect(screen.queryByTestId('composer-ask-video')).toBeNull();
});
