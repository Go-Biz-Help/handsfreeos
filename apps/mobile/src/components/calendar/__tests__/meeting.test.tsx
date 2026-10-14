import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as React from 'react';
import { CallRecord, MeetingLink, meetingOf } from '@/components/calendar/meeting';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';

/**
 * An online appointment on the phone: its Zoom or Meet link to join, and for a recorded call the AI's summary,
 * its suggestions (approved or dismissed here, as on the web) and what was said.
 */

jest.mock('@/lib/api', () => ({
  api: { POST: jest.fn() },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.'),
  unwrap: (result: { data?: unknown; error?: unknown }) => {
    if (result.error) throw new Error(String(result.error));
    return result.data;
  },
}));

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const post = api.POST as unknown as jest.Mock;

beforeEach(() => {
  post.mockReset();
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
});

describe('meetingOf', () => {
  it('reads an online place’s link, and nothing for other places', () => {
    const online = JSON.stringify({
      kind: 'virtual',
      video: 'zoom',
      meetingUrl: 'https://zoom.us/j/1',
      record: true,
    });
    expect(meetingOf(online)).toEqual({
      video: 'zoom',
      url: 'https://zoom.us/j/1',
      error: null,
      record: true,
    });
    expect(meetingOf(JSON.stringify({ kind: 'business', address: '1 Main' }))).toBeNull();
    expect(meetingOf(null)).toBeNull();
    expect(meetingOf('not json')).toBeNull();
  });
});

describe('the video call', () => {
  it('says why there’s no link yet', async () => {
    await render(
      <MeetingLink
        meeting={{ video: 'zoom', url: null, error: 'Dale hasn’t connected Zoom.', record: false }}
      />,
    );
    expect(screen.getByTestId('appointment-meeting-error')).toHaveTextContent(
      'Dale hasn’t connected Zoom.',
    );
    expect(screen.queryByTestId('appointment-join')).toBeNull();
  });
});

describe('a recorded call', () => {
  const answer = (review: unknown, transcripts: unknown[] = []) =>
    post.mockImplementation(async (path: string) => {
      if (path === '/v1/queries/call_suggestion.list') return { data: review };
      if (path === '/v1/queries/appointment.transcripts') return { data: { items: transcripts } };
      return { data: { ok: true } };
    });

  it('shows the summary and what was said, and adds a suggested task as edited', async () => {
    answer(
      {
        summary: 'They want a quote for two units.',
        items: [
          { id: 's1', kind: 'task', status: 'pending', preview: { title: 'Send the quote' } },
        ],
      },
      [{ id: 't1', provider: 'google_meet', createdAt: '2026-10-14T10:00:00Z', body: 'Hello.' }],
    );
    await render(<CallRecord workspaceId={WS} appointmentId={APPT} online />);
    await waitFor(() =>
      expect(screen.getByTestId('call-summary')).toHaveTextContent(
        'They want a quote for two units.',
      ),
    );
    expect(screen.getByTestId('call-transcript')).toHaveTextContent(/Google Meet/);
    await fireEvent.changeText(screen.getByTestId('call-suggestion-title'), 'Send the quote today');
    await fireEvent.press(screen.getByTestId('call-suggestion-approve'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/commands/call_suggestion.decide', {
        body: {
          workspaceId: WS,
          suggestionId: 's1',
          decision: 'approve',
          edits: { title: 'Send the quote today' },
        },
      }),
    );
    expect(toast.show).toHaveBeenCalledWith('Done.');
  });

  it('dismisses a suggested email', async () => {
    answer({
      summary: null,
      items: [
        {
          id: 's2',
          kind: 'follow_up',
          status: 'pending',
          preview: { subject: 'Thanks', body: 'Good talking.' },
        },
      ],
    });
    await render(<CallRecord workspaceId={WS} appointmentId={APPT} online />);
    await waitFor(() => screen.getByTestId('call-suggestion-dismiss'));
    await fireEvent.press(screen.getByTestId('call-suggestion-dismiss'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/commands/call_suggestion.decide', {
        body: { workspaceId: WS, suggestionId: 's2', decision: 'dismiss' },
      }),
    );
  });

  it('says the transcript comes after the call, and waits for the network offline', async () => {
    answer({ summary: null, items: [] });
    await render(<CallRecord workspaceId={WS} appointmentId={APPT} online />);
    await waitFor(() => screen.getByTestId('call-record-waiting'));
    post.mockReset();
    await render(<CallRecord workspaceId={WS} appointmentId={APPT} online={false} />);
    expect(screen.getByText(/when the phone is online/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});
