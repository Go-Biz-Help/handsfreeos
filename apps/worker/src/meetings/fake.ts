/**
 * The local and test Zoom. Signing in is the worker's own stand-in page (the one calendars and mailboxes use,
 * with PKCE checked like the real thing). Nothing here looks like a secret: the tokens name the account and say
 * they're fake.
 */
import { randomBytes } from 'node:crypto';
import { pkceChallenge } from '../mailbox/provider';
import type { ZoomRecordingSettings } from '@hfos/core';
import { MeetingAuthError, MeetingError, type MeetingProvider, type TokenSet } from './provider';

/** A meeting the stand-in holds. */
export interface FakeMeeting {
  readonly id: string;
  readonly account: string;
  readonly appointmentId: string;
  readonly topic: string;
  readonly start: string;
  readonly end: string;
  readonly joinUrl: string;
  readonly record: boolean;
}

export interface FakeZoom extends MeetingProvider {
  /** What HandsFreeOS made in the account's Zoom. */
  meetings(account: string): readonly FakeMeeting[];
  /** Someone deleted the meeting in Zoom itself. */
  forget(id: string): void;
  /** A recorded call ended and Zoom made its transcript: the download link and file id its webhook names. */
  addTranscript(meetingId: string, vtt: string): { url: string; fileId: string };
  /** Changes the account's plan or recording switches (a paid plan with both on until then). */
  setSettings(account: string, s: Partial<ZoomRecordingSettings>): void;
}

const enc = (s: string) => Buffer.from(s).toString('base64url');
const dec = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const HOUR = 3_600_000;
const SCOPES = ['meeting:write:meeting', 'meeting:update:meeting', 'user:read:user'];

export function createFakeZoom(opts: { publicUrl: string }): FakeZoom {
  const held = new Map<string, FakeMeeting>();
  const files = new Map<string, string>();
  const settings = new Map<string, ZoomRecordingSettings>();
  const ALL_ON: ZoomRecordingSettings = {
    planType: 2,
    cloudRecording: true,
    audioTranscript: true,
  };
  let seq = 0;
  const tokens = (email: string): TokenSet => ({
    accessToken: `fake-zoom-access.${enc(email)}.${randomBytes(6).toString('hex')}`,
    refreshToken: `fake-zoom-refresh.${enc(email)}`,
    expiresAt: new Date(Date.now() + HOUR).toISOString(),
    scopes: [...SCOPES],
  });
  const emailOf = (token: string) => {
    const [kind, who] = token.split('.');
    if (!kind?.startsWith('fake-zoom-') || !who)
      throw new MeetingError('Not a fake Zoom token.', 401);
    return dec(who);
  };
  const zoom: FakeZoom = {
    name: 'zoom',
    configured: true,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({
        state,
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
      });
      return `${opts.publicUrl}/oauth/fake/zoom/authorize?${q}`;
    },
    async exchangeCode({ code, codeVerifier }) {
      // The stand-in page's code (mailbox/fake.ts fakeCode): who signed in, and the PKCE challenge to check.
      const [prefix, body] = code.split('.');
      if (prefix !== 'fakecode' || !body) throw new MeetingAuthError('Bad code.', 'invalid_grant');
      const c = JSON.parse(dec(body)) as { email: string; challenge: string; provider: string };
      if (c.provider !== 'zoom' || c.challenge !== pkceChallenge(codeVerifier))
        throw new MeetingAuthError('The code verifier does not match.', 'invalid_grant');
      return tokens(c.email);
    },
    async refresh(current) {
      return tokens(emailOf(current.refreshToken ?? ''));
    },
    async account(accessToken) {
      const email = emailOf(accessToken);
      return { email, id: `fake-zoom-user-${enc(email).slice(0, 12)}` };
    },
    missingScopes: () => [],
    async createMeeting(accessToken, m) {
      const id = String(80_000_000_000 + ++seq);
      const joinUrl = `https://zoom.us/j/${id}?pwd=fake`;
      held.set(id, {
        id,
        account: emailOf(accessToken),
        appointmentId: m.appointmentId,
        topic: m.topic,
        start: m.start.toISOString(),
        end: m.end.toISOString(),
        joinUrl,
        record: !!m.record,
      });
      return { id, joinUrl };
    },
    async updateMeeting(accessToken, id, m) {
      const had = held.get(id);
      if (!had || had.account !== emailOf(accessToken)) return null;
      held.set(id, {
        ...had,
        topic: m.topic,
        start: m.start.toISOString(),
        end: m.end.toISOString(),
      });
      return 'updated';
    },
    async deleteMeeting(accessToken: string, id: string) {
      emailOf(accessToken);
      held.delete(id);
    },
    meetings: (account: string) =>
      [...held.values()].filter((x) => x.account === account.trim().toLowerCase()),
    forget(id: string) {
      held.delete(id);
    },
    async downloadTranscript(accessToken, url) {
      emailOf(accessToken);
      const text = files.get(url);
      if (text === undefined) throw new MeetingError('No such transcript.', 404, true);
      return text;
    },
    addTranscript(meetingId: string, vtt: string) {
      const fileId = `fake-transcript-${meetingId}-${files.size + 1}`;
      const url = `https://fake.zoom.us/rec/download/${fileId}`;
      files.set(url, vtt);
      return { url, fileId };
    },
    async readSettings(accessToken) {
      return settings.get(emailOf(accessToken)) ?? ALL_ON;
    },
    setSettings(account: string, next: Partial<ZoomRecordingSettings>) {
      const key = account.trim().toLowerCase();
      settings.set(key, { ...(settings.get(key) ?? ALL_ON), ...next });
    },
  };
  return zoom;
}
