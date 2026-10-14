/**
 * The real Google Meet transcript reader against recorded responses: no network, no accounts.
 */
import { describe, expect, it } from 'vitest';
import { createGoogleMeet, entriesToText } from '../src/meetings/google-meet';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function meet(routes: Record<string, unknown>) {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const path = url.replace('https://meet.googleapis.com/v2/', '').split('?')[0]!;
    return path in routes ? json(routes[path]) : json({ error: { code: 404 } }, 404);
  }) as typeof fetch;
  return { urls, m: createGoogleMeet({ fetch: f }) };
}

const since = new Date('2026-10-13T15:00:00Z');

describe('Google Meet transcripts', () => {
  it('finds the call by its code, and joins the entries with each speaker’s name', async () => {
    const { m, urls } = meet({
      conferenceRecords: {
        conferenceRecords: [
          {
            name: 'conferenceRecords/old',
            startTime: '2026-10-01T15:00:00Z',
            endTime: '2026-10-01T16:00:00Z',
          },
          {
            name: 'conferenceRecords/r1',
            startTime: '2026-10-13T15:02:00Z',
            endTime: '2026-10-13T15:40:00Z',
          },
        ],
      },
      'conferenceRecords/r1/transcripts': {
        transcripts: [{ name: 'conferenceRecords/r1/transcripts/t1', state: 'FILE_GENERATED' }],
      },
      'conferenceRecords/r1/transcripts/t1/entries': {
        transcriptEntries: [
          { participant: 'conferenceRecords/r1/participants/p1', text: 'Thanks for joining.' },
          { participant: 'conferenceRecords/r1/participants/p1', text: 'Let’s talk quotes.' },
          { participant: 'conferenceRecords/r1/participants/p2', text: 'Sounds good.' },
        ],
      },
      'conferenceRecords/r1/participants': {
        participants: [
          {
            name: 'conferenceRecords/r1/participants/p1',
            signedinUser: { displayName: 'Dale Rivera' },
          },
          { name: 'conferenceRecords/r1/participants/p2', anonymousUser: { displayName: 'Mike' } },
        ],
      },
    });
    expect(await m.look('at', 'abc-defg-hij', since)).toEqual({
      status: 'ready',
      id: 'conferenceRecords/r1/transcripts/t1',
      text: 'Dale Rivera: Thanks for joining. Let’s talk quotes.\nMike: Sounds good.',
    });
    expect(decodeURIComponent(urls[0]!)).toContain('filter=space.meeting_code = "abc-defg-hij"');
  });

  it('a call still going, or a transcript still being written, is not yet; a call without one is none', async () => {
    const going = meet({
      conferenceRecords: {
        conferenceRecords: [{ name: 'conferenceRecords/r1', startTime: '2026-10-13T15:02:00Z' }],
      },
    });
    expect(await going.m.look('at', 'abc-defg-hij', since)).toEqual({ status: 'not_yet' });
    const writing = meet({
      conferenceRecords: {
        conferenceRecords: [
          {
            name: 'conferenceRecords/r1',
            startTime: '2026-10-13T15:02:00Z',
            endTime: '2026-10-13T15:40:00Z',
          },
        ],
      },
      'conferenceRecords/r1/transcripts': {
        transcripts: [{ name: 'conferenceRecords/r1/transcripts/t1', state: 'STARTED' }],
      },
    });
    expect(await writing.m.look('at', 'abc-defg-hij', since)).toEqual({ status: 'not_yet' });
    const none = meet({
      conferenceRecords: {
        conferenceRecords: [
          {
            name: 'conferenceRecords/r1',
            startTime: '2026-10-13T15:02:00Z',
            endTime: '2026-10-13T15:40:00Z',
          },
        ],
      },
      'conferenceRecords/r1/transcripts': { transcripts: [] },
    });
    expect(await none.m.look('at', 'abc-defg-hij', since)).toEqual({ status: 'none' });
    const nothing = meet({ conferenceRecords: {} });
    expect(await nothing.m.look('at', 'abc-defg-hij', since)).toEqual({ status: 'not_yet' });
  });

  it('runs a speaker’s lines together and keeps lines with no name', () => {
    expect(
      entriesToText([
        { who: 'A', text: 'one' },
        { who: 'A', text: 'two' },
        { who: null, text: 'three' },
        { who: 'B', text: '  ' },
      ]),
    ).toBe('A: one two\nthree');
  });
});
