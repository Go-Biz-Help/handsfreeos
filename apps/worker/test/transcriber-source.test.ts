/**
 * Where the words come from when our own copy of the audio does not exist.
 *
 * Transcription used to depend on the upload having worked: the job read a signed link to our object, and a call
 * with no object was written off as "nothing to transcribe". So a Storage that would not take the worker's key
 * cost the business both things at once — the recording *and* any idea of what the caller wanted. They are worth
 * separating: the carrier still has the audio, and Deepgram takes bytes as readily as it takes a link.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createDeepgramTranscriber } from '../src/telephony/deepgram';
import type { ProviderAccount } from '../src/telephony/provider';

const log = pino({ level: 'silent' });
const account = {} as ProviderAccount;
const REPLY = {
  results: { utterances: [{ channel: 0, start: 0, transcript: 'Hi, it’s Mike. Call me back.' }] },
};

interface Sent {
  url: string;
  contentType: string | null;
  body: string | Uint8Array;
}

let sent: Sent[];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  sent = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      contentType: headers.get('content-type'),
      body: init?.body as string | Uint8Array,
    });
    return new Response(JSON.stringify(REPLY), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Deepgram, given a recording', () => {
  const transcriber = () => createDeepgramTranscriber({ apiKey: 'dg-key', log });

  it('hands over a link to our copy when there is one', async () => {
    const started = await transcriber().submit(account, {
      url: 'https://storage.test/telephony/voicemail.mp3',
      audio: null,
      recordingSid: 'RE1',
      channels: 1,
    });
    expect(sent[0]?.contentType).toBe('application/json');
    expect(JSON.parse(String(sent[0]?.body))).toEqual({
      url: 'https://storage.test/telephony/voicemail.mp3',
    });
    expect(started).toEqual({
      status: 'completed',
      // A voicemail is the caller alone, so all of it is the customer's channel (2).
      sentences: [{ channel: 2, text: 'Hi, it’s Mike. Call me back.' }],
    });
  });

  it('posts the carrier’s own bytes when our copy never got stored', async () => {
    const data = Buffer.from('ID3fake-mp3-bytes');
    const started = await transcriber().submit(account, {
      url: null,
      audio: { data, contentType: 'audio/mpeg' },
      recordingSid: 'RE2',
      channels: 1,
    });
    expect(sent[0]?.contentType).toBe('audio/mpeg');
    expect(Buffer.from(sent[0]?.body as Uint8Array)).toEqual(data);
    expect(started.status).toBe('completed');
  });

  it('keeps a bridged call’s two sides apart whichever source it read', async () => {
    await transcriber().submit(account, {
      url: null,
      audio: { data: Buffer.from('x'), contentType: 'audio/wav' },
      recordingSid: 'RE3',
      channels: 2,
    });
    expect(sent[0]?.url).toContain('multichannel=true');
  });

  it('refuses, once and for good, when it is given neither', async () => {
    await expect(
      transcriber().submit(account, { url: null, audio: null, recordingSid: 'RE4', channels: 1 }),
    ).rejects.toMatchObject({ permanent: true });
    expect(sent).toHaveLength(0);
  });
});
