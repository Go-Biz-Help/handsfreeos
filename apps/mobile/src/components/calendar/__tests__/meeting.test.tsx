import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Linking } from 'react-native';
import { CallRecord, MeetingLink, meetingOf } from '@/components/calendar/meeting';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';

/**
 * An online appointment on the phone: its Zoom or Meet link to join, a HandsFreeOS video call joined in the app, and
 * for a recorded call the AI's summary, its suggestions (approved or dismissed here, as on the web) and what was said.
 */

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

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
  (router.push as jest.Mock).mockClear();
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
        workspaceId={WS}
      />,
    );
    expect(screen.getByTestId('appointment-meeting-error')).toHaveTextContent(
      'Dale hasn’t connected Zoom.',
    );
    expect(screen.queryByTestId('appointment-join')).toBeNull();
  });

  it('opens a HandsFreeOS video call in the app', async () => {
    const call = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await render(
      <MeetingLink
        meeting={{
          video: 'handsfree',
          url: `https://app.handsfreeos.com/call/${call}`,
          error: null,
          record: false,
        }}
        workspaceId={WS}
      />,
    );
    expect(screen.getByText('HandsFreeOS video call')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('appointment-join'));
    expect(router.push).toHaveBeenCalledWith(`/app/w/${WS}/call/${call}`);
  });

  it('opens Zoom in its own app', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(
      <MeetingLink
        meeting={{ video: 'zoom', url: 'https://zoom.us/j/1', error: null, record: false }}
        workspaceId={WS}
      />,
    );
    await fireEvent.press(screen.getByTestId('appointment-join'));
    expect(open).toHaveBeenCalledWith('https://zoom.us/j/1');
    expect(router.push).not.toHaveBeenCalled();
    open.mockRestore();
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

  it('shows a suggested record update beside what’s on file, and approves it', async () => {
    answer({
      summary: null,
      items: [
        {
          id: 's3',
          kind: 'record_change',
          status: 'pending',
          preview: { email: 'rosa@newmail.example', was: { email: 'rosa@old.example' } },
        },
      ],
    });
    await render(<CallRecord workspaceId={WS} appointmentId={APPT} online />);
    await waitFor(() =>
      expect(screen.getByTestId('call-change-email')).toHaveTextContent(
        /rosa@newmail\.example.*now rosa@old\.example/,
      ),
    );
    await fireEvent.press(screen.getByTestId('call-suggestion-approve'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/commands/call_suggestion.decide', {
        body: { workspaceId: WS, suggestionId: 's3', decision: 'approve' },
      }),
    );
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

  it('reads a video call that wasn’t for an appointment by the call, and names it as ours', async () => {
    const CALL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    answer({ summary: 'Dana wants the duct quote by Friday.', items: [] }, [
      { id: 't2', provider: 'handsfree', createdAt: '2026-10-28T10:00:00Z', body: 'Dana: Hi.' },
    ]);
    await render(<CallRecord workspaceId={WS} videoCallId={CALL} online ours />);
    await waitFor(() => screen.getByTestId('call-summary'));
    expect(post).toHaveBeenCalledWith('/v1/queries/call_suggestion.list', {
      body: { workspaceId: WS, videoCallId: CALL },
    });
    expect(post).toHaveBeenCalledWith('/v1/queries/appointment.transcripts', {
      body: { workspaceId: WS, videoCallId: CALL },
    });
    expect(screen.getByTestId('call-transcript')).toHaveTextContent(/HandsFreeOS video call/);
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
