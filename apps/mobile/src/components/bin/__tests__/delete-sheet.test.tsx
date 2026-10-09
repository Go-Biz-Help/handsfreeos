import { BIN_WORDS } from '@hfos/core';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as React from 'react';

import { DeleteSheet } from '@/components/bin/delete-sheet';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';

/**
 * Delete for good on the phone (the Deleted bin, 20261027000400 and 20261027000700): the sheet asks HandsFreeOS what
 * goes with it and says so in core's words, as the web's box does; a booking still to come asks whether to tell its
 * customer, as Cancel does; what can't go yet says why and the rest still goes; and the screen is left only once the
 * sheet is gone.
 */

jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Try again.',
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DANA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VISIT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOU = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const KIM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** The stand-in API, typed plainly: openapi-fetch's own signature is too deep for a mock to wear. */
const post = api.POST as unknown as jest.Mock<
  Promise<{ data: unknown }>,
  [string, { body: Record<string, unknown> }]
>;

/** What the API answers, by path. */
function answering(byPath: Record<string, unknown>) {
  post.mockImplementation(async (path) => {
    if (!(path in byPath)) throw new Error(`Nothing answers ${path}`);
    return { data: byPath[path] };
  });
}

const posted = (path: string) =>
  post.mock.calls.filter(([p]) => p === path).map(([, init]) => init);

/** A screen's wiring: the sheet closes itself, and the screen is left from `onDeleted`. */
function Page(
  props: Omit<React.ComponentProps<typeof DeleteSheet>, 'open' | 'onClose' | 'workspaceId'>,
) {
  const [open, setOpen] = React.useState(true);
  return (
    <DeleteSheet open={open} onClose={() => setOpen(false)} workspaceId={LONE_STAR} {...props} />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  post.mockReset();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

it('says what goes with a customer and what stays, and leaves once they’re in the bin', async () => {
  answering({
    '/v1/queries/bin.preview': {
      items: [
        {
          id: DANA,
          name: 'Dana Lopez',
          contents: { conversations: 2, messages: 14, bills: 3 },
          rule: null,
          message: null,
        },
      ],
    },
    '/v1/commands/person.delete': { deleted: [{ id: DANA, binItemId: VISIT, name: 'Dana Lopez' }] },
  });
  const onDeleted = jest.fn();
  await render(<Page kind="person" ids={[DANA]} names={['Dana Lopez']} onDeleted={onDeleted} />);
  const dismiss = screen.root!.props.onDismiss as () => void;

  expect(screen.getByText('Delete Dana Lopez for good?')).toBeOnTheScreen();
  expect(
    await screen.findByText(
      'This also deletes everything only about them: 2 conversations and 14 messages.',
    ),
  ).toBeOnTheScreen();
  expect(screen.getByText('Their 3 bills stay, with just their name on them.')).toBeOnTheScreen();
  expect(screen.getByTestId('delete-keep')).toHaveTextContent('Keep it');

  await fireEvent.press(screen.getByTestId('delete-confirm'));
  expect(posted('/v1/commands/person.delete')).toEqual([
    { body: { workspaceId: LONE_STAR, personIds: [DANA] } },
  ]);
  expect(toast.show).toHaveBeenCalledWith(
    'Dana Lopez deleted. Bring them back from Settings → Deleted bin within 30 days.',
  );
  // iOS shows nothing new while the sheet's modal is still going: the screen is left once it's gone.
  await act(async () => jest.advanceTimersByTime(1_000));
  expect(onDeleted).not.toHaveBeenCalled();
  await act(async () => dismiss());
  expect(onDeleted).toHaveBeenCalledTimes(1);
});

it('asks whether to tell the customer when a booking still to come is cancelled first', async () => {
  answering({
    '/v1/queries/bin.preview': {
      items: [
        { id: VISIT, name: 'AC tune-up', contents: { upcoming: 1 }, rule: null, message: null },
      ],
    },
    '/v1/commands/appointment.delete': { id: VISIT },
  });
  await render(
    <Page
      kind="appointment"
      ids={[VISIT]}
      names={['AC tune-up']}
      tellFirst="Rosa"
      onDeleted={jest.fn()}
    />,
  );
  expect(await screen.findByText('It’s still to come, so it’s cancelled first.')).toBeOnTheScreen();
  expect(screen.getByTestId('delete-confirm')).toHaveTextContent('Delete and tell Rosa');
  expect(screen.getByTestId('delete-quietly')).toHaveTextContent('Delete without telling them');

  await fireEvent.press(screen.getByTestId('delete-confirm'));
  expect(posted('/v1/commands/appointment.delete')).toEqual([
    { body: { workspaceId: LONE_STAR, appointmentId: VISIT, notify: true } },
  ]);
  expect(toast.show).toHaveBeenCalledWith(BIN_WORDS.cancelledTold);
});

it('deletes a booking without telling anyone when asked not to', async () => {
  answering({
    '/v1/queries/bin.preview': {
      items: [
        { id: VISIT, name: 'AC tune-up', contents: { upcoming: 1 }, rule: null, message: null },
      ],
    },
    '/v1/commands/appointment.delete': { id: VISIT },
  });
  await render(
    <Page
      kind="appointment"
      ids={[VISIT]}
      names={['AC tune-up']}
      tellFirst="Rosa"
      onDeleted={jest.fn()}
    />,
  );
  await fireEvent.press(await screen.findByTestId('delete-quietly'));
  expect(posted('/v1/commands/appointment.delete')).toEqual([
    { body: { workspaceId: LONE_STAR, appointmentId: VISIT, notify: false } },
  ]);
  expect(toast.show).toHaveBeenCalledWith(
    'Booking deleted. Bring it back from Settings → Deleted bin within 30 days.',
  );
});

it('says why one can’t go yet, and deletes the other', async () => {
  answering({
    '/v1/queries/bin.preview': {
      items: [
        { id: LOU, name: 'Lou Park', contents: { messages: 3 }, rule: null, message: null },
        {
          id: KIM,
          name: 'Kim Diaz',
          contents: { messages: 1 },
          rule: 'bin_still_sending',
          message: 'A message in this conversation is still going out. Try again in a minute.',
        },
      ],
    },
    '/v1/commands/conversation.delete': { deleted: [] },
  });
  await render(
    <Page
      kind="conversation"
      ids={[LOU, KIM]}
      names={['Lou Park', 'Kim Diaz']}
      onDeleted={jest.fn()}
    />,
  );
  const blocked = await screen.findByTestId('delete-blocked');
  expect(blocked).toHaveTextContent(/This one can’t go yet:/);
  expect(blocked).toHaveTextContent(/still going out\. Try again in a minute\./);
  expect(screen.getByText('Delete the conversation with Lou Park for good?')).toBeOnTheScreen();
  expect(screen.getByText('This also deletes 3 messages.')).toBeOnTheScreen();
  expect(screen.getByTestId('delete-confirm')).toHaveTextContent('Delete the other one');

  await fireEvent.press(screen.getByTestId('delete-confirm'));
  expect(posted('/v1/commands/conversation.delete')).toEqual([
    { body: { workspaceId: LONE_STAR, conversationIds: [LOU] } },
  ]);
});

it('deletes a lead and leaves its customer, saying so', async () => {
  answering({
    '/v1/queries/bin.preview': {
      items: [
        {
          id: VISIT,
          name: 'Heat pump',
          contents: { tasks: 1, who: ['Dana Lopez'] },
          rule: null,
          message: null,
        },
      ],
    },
    '/v1/commands/lead.delete': { deleted: [{ id: VISIT, binItemId: KIM, name: 'Heat pump' }] },
  });
  await render(<Page kind="lead" ids={[VISIT]} names={['Heat pump']} onDeleted={jest.fn()} />);
  expect(screen.getByText('Delete this lead for good?')).toBeOnTheScreen();
  expect(await screen.findByText('This also deletes 1 task.')).toBeOnTheScreen();
  expect(screen.getByText('It doesn’t delete Dana Lopez from Contacts.')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('delete-confirm'));
  expect(posted('/v1/commands/lead.delete')).toEqual([
    { body: { workspaceId: LONE_STAR, leadIds: [VISIT] } },
  ]);
  expect(toast.show).toHaveBeenCalledWith(
    'Lead deleted. Bring it back from Settings → Deleted bin within 30 days.',
  );
});

it('says why a company an add-on uses has to stay', async () => {
  const said =
    'Pine Inspections is used by the Real Estate Agent add-on, so it has to stay. Archive it instead.';
  answering({
    '/v1/queries/bin.preview': {
      items: [
        { id: KIM, name: 'Pine Inspections', contents: {}, rule: 'bin_addon_uses', message: said },
      ],
    },
  });
  await render(
    <Page kind="company" ids={[KIM]} names={['Pine Inspections']} onDeleted={jest.fn()} />,
  );
  expect(await screen.findByText(said)).toBeOnTheScreen();
  expect(screen.queryByTestId('delete-confirm')).toBeNull();
});

it('says what went wrong when it can’t ask, and offers nothing to delete', async () => {
  const refused =
    'Only an owner of this business deletes for good. Ask an owner, or archive it instead.';
  post.mockRejectedValue(new Error(refused));
  await render(<Page kind="person" ids={[DANA]} names={['Dana Lopez']} onDeleted={jest.fn()} />);
  expect(await screen.findByText(refused)).toBeOnTheScreen();
  expect(screen.queryByTestId('delete-confirm')).toBeNull();
});
