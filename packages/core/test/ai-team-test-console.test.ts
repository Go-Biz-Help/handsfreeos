import { describe, expect, it } from 'vitest';
import {
  parseTestEvent,
  readTestEvents,
  restToSay,
  TestConsoleInput,
  testSamples,
  testVerb,
} from '../src/ai-team/index';

/**
 * The test console's contract, which the worker, the web and the phone app all read: what a test may ask for (a
 * phone test says which way the call goes, an outgoing one who and why, a campaign what it's about), and how the
 * stream's events are read.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const issues = (input: unknown) => {
  const r = TestConsoleInput.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('what a test asks for', () => {
  it('a written test needs a message, and takes no call', () => {
    const ok = TestConsoleInput.parse({
      workspaceId: WS,
      channel: 'sms',
      messages: [{ from: 'customer', text: 'Hi' }],
    });
    expect(ok).toMatchObject({ personId: null, call: null, at: null, config: null });
    expect(issues({ workspaceId: WS, channel: 'email', messages: [] })).toEqual([
      'messages: Write a message first.',
    ]);
  });

  it('a phone test starts with no messages, and says which way the call goes', () => {
    expect(
      issues({ workspaceId: WS, channel: 'phone', call: { direction: 'inbound' }, messages: [] }),
    ).toEqual([]);
    expect(issues({ workspaceId: WS, channel: 'phone', messages: [] })).toEqual([
      'call: Say which way the call goes.',
    ]);
  });

  it('an outgoing call is to someone in Customers, for a reason; a campaign says what about', () => {
    expect(
      issues({ workspaceId: WS, channel: 'phone', call: { direction: 'outbound' }, messages: [] }),
    ).toEqual(['call.purpose: Pick why it calls.', 'personId: Pick a customer for it to call.']);
    expect(
      issues({
        workspaceId: WS,
        personId: PERSON,
        channel: 'phone',
        call: { direction: 'outbound', purpose: 'campaign', goal: '  ' },
        messages: [],
      }),
    ).toEqual(['call.goal: Say what the campaign call is about.']);
    expect(
      issues({
        workspaceId: WS,
        personId: PERSON,
        channel: 'phone',
        call: { direction: 'outbound', purpose: 'confirm_visit' },
        messages: [],
      }),
    ).toEqual([]);
  });
});

describe('the stream', () => {
  it('reads a call’s end, and a done from an older worker as not ended', () => {
    expect(
      parseTestEvent({
        type: 'done',
        outcome: 'replied',
        reply: 'Bye!',
        ended: true,
        toolSteps: 1,
      }),
    ).toMatchObject({ type: 'done', ended: true, draft: false, reply: 'Bye!', ms: 0 });
    expect(parseTestEvent({ type: 'done', outcome: 'handed_off' })).toMatchObject({
      ended: false,
      reply: null,
    });
    expect(parseTestEvent({ type: 'done', outcome: 'maybe' })).toBeNull();
  });

  it('knows the call-only changes, and reads an unknown kind as a note', () => {
    expect(
      parseTestEvent({ type: 'would', kind: 'confirm', summary: 'marked it confirmed' }),
    ).toMatchObject({ kind: 'confirm' });
    expect(parseTestEvent({ type: 'would', kind: 'teleport', summary: 'x' })).toMatchObject({
      kind: 'note',
    });
    expect(parseTestEvent({ type: 'mystery' })).toBeNull();
  });

  it('reads a sentence said while the reply is written, and skips an empty one', () => {
    expect(parseTestEvent({ type: 'say', text: 'We’re open eight to five.' })).toEqual({
      type: 'say',
      text: 'We’re open eight to five.',
    });
    expect(parseTestEvent({ type: 'say', text: ' ' })).toBeNull();
  });

  it('says only the rest of a reply that was started early, or all of one that changed', () => {
    const said = ['Yes, we are.', 'We open at nine.'];
    expect(restToSay(said, 'Yes, we are.  We open at nine.\nAnything else?')).toBe(
      'Anything else?',
    );
    expect(restToSay(said, 'Yes, we are. We open at nine.')).toBe('');
    expect(restToSay([], 'Hi there.')).toBe('Hi there.');
    // A hand-off after the early words: its own line is said whole.
    expect(restToSay(said, 'One moment, I’ll connect you with the team.')).toBe(
      'One moment, I’ll connect you with the team.',
    );
  });

  it('splits a stream into whole events, whatever its line endings', () => {
    const { events, rest } = readTestEvents(
      ': ping\n\ndata: {"type":"started","runId":"r1"}\r\n\r\ndata: {"type":"delta",',
    );
    expect(events).toEqual([{ type: 'started', runId: 'r1', at: expect.any(String) }]);
    expect(rest).toBe('data: {"type":"delta",');
  });
});

describe('the console’s words', () => {
  it('offers lines for the channel, and on a call for which way it goes and why', () => {
    expect(testSamples('sms', null)).toContain('Are you a real person?');
    expect(testSamples('phone', { direction: 'inbound', purpose: null, goal: null })).toContain(
      'That’s all, bye!',
    );
    expect(
      testSamples('phone', { direction: 'outbound', purpose: 'confirm_visit', goal: null }),
    ).toContain('Yes, that still works');
    expect(testVerb('phone')).toBe('said');
    expect(testVerb('chat')).toBe('wrote in the chat');
  });
});
