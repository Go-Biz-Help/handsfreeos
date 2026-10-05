import type { ToursView } from '@hfos/core/addons/realestate/views/tours';
import type { FieldNote } from '@hfos/core/addons/realestate/views/field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Linking } from 'react-native';

import { change, changes } from '@/changes';
import { toast } from '@/components/ui/toast';

import { FeedbackBody, StopBody, ToursBody } from '../tours';
import { AGENT, DEAL, DEAL_REF, home, id, LINH, TZ, WS } from './buyer-fixtures';

/**
 * Tours in the field (board 83): the day's stops with Directions and Check in, what to see and ask at a stop, the
 * client's reaction and notes by text, voice or photo with no signal, and the feedback after for the client's portal.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/changes', () => {
  const actual = jest.requireActual<{ ChangeError: unknown; NEEDS_SIGNAL: string }>(
    '@/changes/controller',
  );
  let n = 0;
  return {
    change: jest.fn(async () => ({ id: `change-${++n}`, queued: true })),
    changes: { addPhoto: jest.fn(async () => ({ id: 'upload-1' })) },
    newId: jest.fn(() => '99999999-9999-4999-8999-999999999999'),
    ChangeError: actual.ChangeError,
    NEEDS_SIGNAL: actual.NEEDS_SIGNAL,
  };
});
let mockOnline = true;
jest.mock('@/lib/network', () => ({
  useNetwork: () => ({ online: mockOnline }),
  networkSnapshot: () => ({ online: mockOnline, lastOnlineAt: 0 }),
}));
jest.mock('@/changes/photo-device', () => ({
  takePhoto: jest.fn(async () => ({
    kind: 'kept',
    photo: { localName: 'photo.jpg', sizeBytes: 2048, width: 10, height: 10 },
  })),
}));
jest.mock('@/components/safety/check-in-sheet', () => {
  const { Text: MockText } = jest.requireActual<{
    Text: React.ComponentType<{ testID?: string; children?: React.ReactNode }>;
  }>('react-native');
  return {
    CheckInSheet: (p: { open: boolean; place?: string; appointmentId?: string }) =>
      p.open ? (
        <MockText testID="mock-check-in">{`${p.place} · ${p.appointmentId}`}</MockText>
      ) : null,
  };
});
jest.mock('../recorder', () => ({
  ...jest.requireActual<object>('../recorder'),
  keepRecording: jest.fn(() => ({ localName: 'note.m4a', sizeBytes: 4096 })),
}));

const NEW_ID = '99999999-9999-4999-8999-999999999999';
const APPOINTMENT = id(90);
const TOUR = id(50);
const stops = ['418 Maple Ave', '77 Birch Hollow', '31 Live Oak Ln', '9 Creekside Dr'];
const stopId = (i: number) => id(60 + i);

function tour(over: Partial<ToursView['tours'][number]> = {}): ToursView['tours'][number] {
  return {
    id: TOUR,
    status: 'planned',
    startsAt: '2026-10-03T15:00:00.000Z',
    endsAt: '2026-10-03T17:30:00.000Z',
    appointmentId: APPOINTMENT,
    calendarId: null,
    agent: { id: AGENT, fullName: 'Sam Rivera' },
    note: null,
    exception: null,
    canceledReason: null,
    stops: stops.map((s, i) => ({
      id: stopId(i),
      homeId: id(i + 1),
      address: `${s}, Austin, TX`,
      position: i,
      status: 'planned' as const,
      visitedAt: null,
      note: null,
      feedback: [],
    })),
    ...over,
  };
}
const AGREEMENT = {
  ok: true,
  rule: null,
  words: null,
  signedTitle: 'Buyer agreement',
  endsOn: '2026-12-31',
};
const note = (n: number, over: Partial<FieldNote>): FieldNote => ({
  id: id(n),
  aboutKind: 'tour_stop',
  aboutId: stopId(0),
  body: null,
  audioFileId: null,
  transcript: null,
  transcriptState: 'none',
  photoFileIds: [],
  createdBy: AGENT,
  notedAt: '2026-10-03T15:10:00.000Z',
  ...over,
});
const calls = () => jest.mocked(change).mock.calls.map(([name, input]) => ({ name, input }));

beforeEach(() => {
  // A toast stays 2.6 seconds; the tests read what it says instead.
  jest.spyOn(toast, 'show').mockImplementation(() => 1);
  jest.spyOn(toast, 'error').mockImplementation(() => 1);
  jest.mocked(change).mockClear();
  jest.mocked(changes.addPhoto).mockClear();
  jest.mocked(router.replace).mockClear();
  mockOnline = true;
});

describe('a tour', () => {
  it('lists the day’s stops in order with when each is, Directions and Check in', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(
      <ToursBody
        workspaceId={WS}
        deal={DEAL_REF}
        view={{ agreement: AGREEMENT, tours: [tour()] }}
        homes={[]}
        today="2026-09-29"
        timeZone={TZ}
        planning={false}
        planHome={null}
        editable
      />,
    );
    expect(screen.getByText('Saturday’s tour')).toBeTruthy();
    expect(screen.getByText('Agreement on file')).toBeTruthy();
    expect(screen.getByTestId('re-tour-line')).toHaveTextContent(
      'Linh Nguyen · 4 homes · 10:00 AM–12:30 PM',
    );
    expect(screen.getByText('Stops')).toBeTruthy();
    expect(screen.getByTestId(`re-stop-row-${stopId(0)}`)).toHaveTextContent(
      '418 Maple AveTo see10:00',
    );
    expect(screen.getByTestId(`re-stop-row-${stopId(3)}`)).toHaveTextContent(
      '9 Creekside DrTo see11:52',
    );
    await fireEvent.press(screen.getByTestId(`re-tour-directions-${TOUR}`));
    expect(open.mock.calls[0]![0]).toContain('418%20Maple%20Ave');
    await fireEvent.press(screen.getByTestId(`re-tour-checkin-${TOUR}`));
    expect(screen.getByTestId('mock-check-in')).toHaveTextContent(
      `418 Maple Ave, Austin, TX · ${APPOINTMENT}`,
    );
    await fireEvent.press(screen.getByTestId(`re-stop-row-${stopId(1)}`));
    expect(router.push).toHaveBeenCalledWith(
      `/app/w/${WS}/a/realestate/deals/${DEAL}/tours?stop=${stopId(1)}`,
    );
  });

  it('says why a tour can’t be planned, and that planning needs signal', async () => {
    mockOnline = false;
    await render(
      <ToursBody
        workspaceId={WS}
        deal={DEAL_REF}
        view={{
          agreement: {
            ...AGREEMENT,
            ok: false,
            rule: 'buyer_agreement_needed',
            words: 'Nguyen purchase has no signed buyer agreement, so tours can’t be planned yet.',
          },
          tours: [],
        }}
        homes={[]}
        today="2026-09-29"
        timeZone={TZ}
        planning={false}
        planHome={null}
        editable
      />,
    );
    expect(screen.getByTestId('re-tours-agreement')).toHaveTextContent(
      'Nguyen purchase has no signed buyer agreement, so tours can’t be planned yet.',
    );
    expect(screen.getByTestId('re-tours-plan')).toHaveTextContent('Needs signal');
    expect(screen.getByTestId('re-tours-plan-why')).toHaveTextContent(
      'Planning a tour needs signal; it goes on the calendar and the clients are invited.',
    );
  });
});

describe('planning a tour from a home', () => {
  const birch = home({ id: id(9), address: '12 Sunset Ridge, Austin, TX' });
  const draw = () =>
    render(
      <ToursBody
        workspaceId={WS}
        deal={DEAL_REF}
        view={{ agreement: AGREEMENT, tours: [tour()] }}
        homes={[home(), birch]}
        today="2026-09-29"
        timeZone={TZ}
        planning
        planHome={id(9)}
        editable
      />,
    );

  it('needs signal: it goes on the calendar', async () => {
    mockOnline = false;
    await draw();
    expect(screen.getByTestId(`re-plan-add-${TOUR}`)).toHaveTextContent('Needs signal');
    expect(screen.getByTestId('re-plan-save')).toHaveTextContent('Needs signal');
  });

  it('adds the home to a tour already planned, or plans one with it first', async () => {
    await draw();
    expect(screen.getByText('Add to Saturday’s tour')).toBeTruthy();
    await fireEvent.press(screen.getByTestId(`re-plan-add-${TOUR}`));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(calls()[0]).toEqual({
      name: 'realestate.tour.set_stops',
      input: { workspaceId: WS, tourId: TOUR, homeIds: [id(1), id(2), id(3), id(4), id(9)] },
    });
    jest.mocked(change).mockClear();
    await draw();
    await fireEvent.press(screen.getByTestId('re-plan-day-2026-10-01'));
    await fireEvent.press(screen.getByTestId('re-plan-time-600'));
    await fireEvent.press(screen.getByTestId('re-plan-save'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(calls()[0]).toEqual({
      name: 'realestate.tour.plan',
      input: {
        workspaceId: WS,
        dealId: DEAL,
        homeIds: [id(9)],
        startsAt: '2026-10-01T15:00:00.000Z',
      },
    });
  });
});

describe('at a stop', () => {
  const maple = home({
    fit: {
      lines: [{ key: 'sqft', met: null, words: 'Size not known yet' }],
      met: 0,
      missed: 0,
      unknown: 1,
    },
  });
  const mapleFacts = home({
    mls: {
      ...maple.mls!,
      facts: { ...maple.mls!.facts, year_built: 1998 },
    },
    fit: maple.fit,
  });
  const draw = (t = tour()) =>
    render(
      <StopBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        tour={t}
        stop={t.stops[0]!}
        home={mapleFacts}
        profile={{
          budgetMinCents: null,
          budgetMaxCents: null,
          areas: [],
          homeTypes: [],
          bedsMin: null,
          bathsMin: null,
          sqftMin: null,
          moveBy: null,
          mustHaves: ['Is the garage a full two cars?'],
          dealBreakers: [],
          version: 1,
          updatedAt: '2026-10-01T00:00:00.000Z',
          updatedBy: null,
        }}
        notes={[]}
      />,
    );

  it('shows the facts at a glance and what to ask', async () => {
    await draw();
    expect(screen.getByTestId('re-stop-count')).toHaveTextContent('Stop 1 of 4');
    expect(screen.getByText('$409,000')).toBeTruthy();
    expect(screen.getByText('3 · 2 · 1,780 sq ft')).toBeTruthy();
    expect(screen.getByText('1998 · $35 a month')).toBeTruthy();
    expect(screen.getByText('Ask while you’re there')).toBeTruthy();
    expect(screen.getByText('Is the garage a full two cars?')).toBeTruthy();
    expect(screen.getByText('Linh’s must-have')).toBeTruthy();
    expect(screen.getByText('What Linh thought')).toBeTruthy();
    expect(screen.getByText('Loved it')).toBeTruthy();
    expect(screen.getByText('Not for Linh')).toBeTruthy();
    expect(screen.getByText('Next stop · 77 Birch Hollow')).toBeTruthy();
  });

  it('keeps the client’s reaction with no signal, once the home is marked seen', async () => {
    mockOnline = false;
    await draw();
    await fireEvent.press(screen.getByTestId(`re-stop-interest-${LINH}-maybe`));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(calls()).toEqual([
      {
        name: 'realestate.tour.record_visit',
        input: { workspaceId: WS, stopId: stopId(0), status: 'visited' },
      },
      {
        name: 'realestate.tour.feedback',
        input: { workspaceId: WS, stopId: stopId(0), personId: LINH, interest: 'maybe' },
      },
    ]);
    // The reaction waits for the visit it needs.
    const visit = (await jest.mocked(change).mock.results[0]!.value) as { id: string };
    expect(jest.mocked(change).mock.calls[1]![2]).toMatchObject({ dependsOn: [visit.id] });
  });

  it('takes a typed note and moves on to the next stop', async () => {
    await draw();
    await fireEvent.press(screen.getByTestId('re-stop-note'));
    await fireEvent.changeText(screen.getByTestId('re-stop-note-sheet-text'), 'Roof 2015, AC 2019');
    await fireEvent.press(screen.getByTestId('re-stop-note-sheet-submit'));
    await fireEvent.press(screen.getByTestId('re-stop-next'));
    await waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(calls()).toEqual([
      {
        name: 'realestate.field_note.add',
        input: {
          workspaceId: WS,
          dealId: DEAL,
          id: NEW_ID,
          aboutKind: 'tour_stop',
          aboutId: stopId(0),
          body: 'Roof 2015, AC 2019',
          photoFileIds: [],
        },
      },
      {
        name: 'realestate.tour.record_visit',
        input: { workspaceId: WS, stopId: stopId(0), status: 'visited' },
      },
    ]);
    expect(router.replace).toHaveBeenCalledWith(
      `/app/w/${WS}/a/realestate/deals/${DEAL}/tours?stop=${stopId(1)}`,
    );
  });

  it('keeps a photo with the stop: it uploads on its own, and the note waits for it', async () => {
    mockOnline = false;
    await draw();
    await fireEvent.press(screen.getByTestId('re-stop-photo'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(changes.addPhoto).toHaveBeenCalledWith(
      { workspaceId: WS, recordType: 'custom_record', recordId: DEAL },
      { localName: 'photo.jpg', sizeBytes: 2048 },
      { fileId: NEW_ID, name: undefined, mimeType: undefined },
    );
    expect(calls()[0]).toEqual({
      name: 'realestate.field_note.add',
      input: {
        workspaceId: WS,
        dealId: DEAL,
        id: NEW_ID,
        aboutKind: 'tour_stop',
        aboutId: stopId(0),
        photoFileIds: [NEW_ID],
      },
    });
    expect(jest.mocked(change).mock.calls[0]![2]).toMatchObject({ dependsOn: ['upload-1'] });
  });

  it('records a voice note with no signal and says the words come when it sends', async () => {
    mockOnline = false;
    await draw();
    await fireEvent.press(screen.getByTestId('re-stop-voice'));
    await waitFor(() => expect(screen.getByTestId('re-voice-stop')).toBeTruthy());
    expect(screen.getByText('Voice note')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('re-voice-stop'));
    await waitFor(() =>
      expect(
        screen.getByText(
          'Recorded with no signal. The words come when it sends; the recording is kept with the stop.',
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText('Record again')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('re-voice-keep'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(changes.addPhoto).toHaveBeenCalledWith(
      { workspaceId: WS, recordType: 'custom_record', recordId: DEAL },
      { localName: 'note.m4a', sizeBytes: 4096 },
      { fileId: NEW_ID, name: 'Voice note, 418 Maple Ave.m4a', mimeType: 'audio/mp4' },
    );
    expect(calls()[0]).toEqual({
      name: 'realestate.field_note.add',
      input: {
        workspaceId: WS,
        dealId: DEAL,
        id: NEW_ID,
        aboutKind: 'tour_stop',
        aboutId: stopId(0),
        audioFileId: NEW_ID,
        photoFileIds: [],
      },
    });
  });

  it('offers Check in for the stop, from the tour’s appointment', async () => {
    await draw();
    await fireEvent.press(screen.getByTestId('re-stop-checkin'));
    expect(screen.getByTestId('mock-check-in')).toHaveTextContent(
      `418 Maple Ave, Austin, TX · ${APPOINTMENT}`,
    );
  });
});

describe('after the tour', () => {
  const done = tour({
    status: 'done',
    stops: tour().stops.map((s, i) => ({
      ...s,
      status: i === 2 ? ('skipped' as const) : ('visited' as const),
      note: i === 2 ? 'the listing agent didn’t confirm.' : null,
      feedback:
        i === 0
          ? [
              {
                id: id(70),
                personId: LINH,
                name: 'Linh Nguyen',
                interest: 'love' as const,
                rating: null,
                words: null,
                recordedBy: { id: AGENT, fullName: 'Sam Rivera' },
                at: '2026-10-03T15:12:00.000Z',
              },
            ]
          : [],
    })),
  });
  const notes = [
    note(80, {
      audioFileId: id(81),
      transcript: 'The yard is perfect. Kitchen is small.',
      transcriptState: 'done',
    }),
    note(82, {
      body: 'Garage fits two cars; roof 2015, AC 2019.',
      notedAt: '2026-10-03T15:14:00.000Z',
    }),
  ];

  it('says what the client thought of each home, with the agent’s notes, and sends it to their portal', async () => {
    await render(
      <FeedbackBody
        workspaceId={WS}
        userId={AGENT}
        deal={DEAL_REF}
        tour={done}
        name="Saturday’s tour"
        notes={notes}
      />,
    );
    expect(screen.getByText('Saturday’s tour · what Linh said')).toBeTruthy();
    expect(screen.getByTestId(`re-feedback-${stopId(0)}`)).toHaveTextContent(
      '418 Maple AveLoved it“The yard is perfect. Kitchen is small.” · voice noteGarage fits two cars; roof 2015, AC 2019.',
    );
    expect(screen.getByText('Skipped: the listing agent didn’t confirm.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('re-feedback-send'));
    await waitFor(() => expect(change).toHaveBeenCalled());
    expect(calls()).toEqual([
      {
        name: 'realestate.tour.feedback',
        input: {
          workspaceId: WS,
          stopId: stopId(0),
          personId: LINH,
          interest: 'love',
          words: 'The yard is perfect. Kitchen is small. Garage fits two cars; roof 2015, AC 2019.',
        },
      },
    ]);
    expect(screen.getByText('Send to Linh’s portal')).toBeTruthy();
  });
});
