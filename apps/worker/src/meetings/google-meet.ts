/**
 * Google Meet transcripts through the Meet REST API (v2), with the host's Google calendar sign-in once it holds
 * the Meet permission (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md, step 7). A Meet link's code finds the call's
 * conference record; its transcript's entries, with each speaker's name, become plain text.
 */
import { providerJson } from '../mailbox/provider';

const API = 'https://meet.googleapis.com/v2';

/** What a look at one Meet call found. */
export type MeetTranscriptLook =
  | { readonly status: 'ready'; readonly id: string; readonly text: string }
  /** The call hasn't happened, is still going, or its transcript is still being written. */
  | { readonly status: 'not_yet' }
  /** The call ended without a transcript (nobody turned transcripts on). */
  | { readonly status: 'none' };

export interface MeetTranscripts {
  /** The transcript of the call with this meeting code that started after `since`. */
  look(accessToken: string, meetingCode: string, since: Date): Promise<MeetTranscriptLook>;
}

interface ConferenceRecord {
  name?: string;
  startTime?: string;
  endTime?: string;
}
interface Transcript {
  name?: string;
  state?: string;
}
interface Entry {
  participant?: string;
  text?: string;
}
interface Participant {
  name?: string;
  signedinUser?: { displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

/** Lines of "Name: words", a speaker's lines run together while they keep talking. */
export function entriesToText(entries: readonly { who: string | null; text: string }[]): string {
  const turns: { who: string | null; said: string }[] = [];
  for (const e of entries) {
    const said = e.text.trim();
    if (!said) continue;
    const last = turns[turns.length - 1];
    if (last && last.who === e.who) last.said += ` ${said}`;
    else turns.push({ who: e.who, said });
  }
  return turns.map((t) => (t.who ? `${t.who}: ${t.said}` : t.said)).join('\n');
}

export function createGoogleMeet(opts: { fetch?: typeof fetch } = {}): MeetTranscripts {
  const f = opts.fetch ?? fetch;
  const get = async <T>(accessToken: string, path: string): Promise<T> =>
    providerJson<T>(
      'Google Meet',
      await f(`${API}/${path}`, { headers: { authorization: `Bearer ${accessToken}` } }),
    );
  /** Every page of a list, up to a sane limit. */
  async function all<T>(accessToken: string, path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let token = '';
    for (let page = 0; page < 50; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const got = await get<Record<string, unknown>>(
        accessToken,
        `${path}${sep}pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
      );
      out.push(...((got[key] as T[] | undefined) ?? []));
      token = String(got['nextPageToken'] ?? '');
      if (!token) break;
    }
    return out;
  }

  return {
    async look(accessToken, meetingCode, since) {
      const filter = encodeURIComponent(`space.meeting_code = "${meetingCode}"`);
      const records = (
        await all<ConferenceRecord>(
          accessToken,
          `conferenceRecords?filter=${filter}`,
          'conferenceRecords',
        )
      )
        .filter((r) => r.name && r.startTime && Date.parse(r.startTime) >= since.getTime())
        .sort((a, b) => Date.parse(b.startTime!) - Date.parse(a.startTime!));
      const record = records[0];
      if (!record?.name || !record.endTime) return { status: 'not_yet' };
      const transcripts = await all<Transcript>(
        accessToken,
        `${record.name}/transcripts`,
        'transcripts',
      );
      if (transcripts.length === 0) return { status: 'none' };
      const done = transcripts.find((t) => t.name && t.state !== 'STARTED');
      if (!done?.name) return { status: 'not_yet' };
      const [entries, participants] = await Promise.all([
        all<Entry>(accessToken, `${done.name}/entries`, 'transcriptEntries'),
        all<Participant>(accessToken, `${record.name}/participants`, 'participants'),
      ]);
      const names = new Map(
        participants.map((p) => [
          p.name ?? '',
          p.signedinUser?.displayName ??
            p.anonymousUser?.displayName ??
            p.phoneUser?.displayName ??
            null,
        ]),
      );
      const text = entriesToText(
        entries.map((e) => ({ who: names.get(e.participant ?? '') ?? null, text: e.text ?? '' })),
      );
      return text ? { status: 'ready', id: done.name.slice(0, 200), text } : { status: 'none' };
    },
  };
}

/** The local and test Meet: transcripts the tests put there, by meeting code. */
export interface FakeMeet extends MeetTranscripts {
  /** A Meet call ended with this transcript ("Name: words" lines), or `null` for one with none. */
  finish(meetingCode: string, text: string | null): void;
}

export function createFakeMeet(): FakeMeet {
  const calls = new Map<string, string | null>();
  return {
    async look(_accessToken, meetingCode) {
      if (!calls.has(meetingCode)) return { status: 'not_yet' };
      const text = calls.get(meetingCode);
      return text
        ? { status: 'ready', id: `fake-meet-transcript-${meetingCode}`, text }
        : { status: 'none' };
    },
    finish(meetingCode, text) {
      calls.set(meetingCode, text);
    },
  };
}
