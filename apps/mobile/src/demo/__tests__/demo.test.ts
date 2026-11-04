jest.mock('@/lib/auth', () => ({
  session: {
    accessToken: async () => 'token-1',
    getState: () => ({
      status: 'signedIn',
      person: { userId: '11111111-1111-4111-8111-111111111111', name: 'Dale Ramsey' },
      expiresAt: 0,
    }),
  },
}));

import {
  conversationOf,
  EMERGENCY_SAFETY_TEXT,
  teammateDraftOf,
  threadItemsOf,
  wallMinutes,
} from '@hfos/core';

import { DALE, LONE_STAR, memoryStore, phone, START } from '@/changes/__tests__/harness';
import { pressAction, TAP } from '@/push/buttons';
import { pushDataOf } from '@/push/payload';
import { notificationOf } from '@/push/present';
import { PressRunner, type PressDeps } from '@/push/press';

import { demoId, isDemoId, mentionsDemo } from '../ids';
import { playPress, pretendChange } from '../pretend';
import {
  approvalPush,
  demoWorld,
  emergencyPush,
  findPhoneScene,
  nightOf,
  PHONE_DEMO_SCENES,
} from '../scenes';
import { currentDemo, dropDemo, keepDemo, type PhoneDemo } from '../state';
import { PHONE_DEMO_WORDS } from '../words';

/**
 * The phone's demo player (src/demo): scenes 54 and 55 put made-up rows on the real screens, their notifications are
 * the worker's, worded and buttoned the same, and every change about something made up is answered on the phone and
 * never reaches HandsFreeOS. Approve on the lock screen, or a tap on the alert, plays the step that waits for it, once.
 */

const demo = (scene: string, played = 0, overrides: Partial<PhoneDemo> = {}): PhoneDemo => ({
  viewerId: DALE,
  workspaceId: LONE_STAR,
  scene,
  steps: Array.from({ length: played }, (_, i) => (i + 1) * 10_000),
  startedAt: START,
  business: 'Bayou Plumbing Co.',
  teammate: 'Ava',
  me: 'Dale',
  myName: 'Dale Ramsey',
  timeZone: 'America/Chicago',
  read: [],
  typed: [],
  ...overrides,
});

afterEach(() => dropDemo());

describe('the phone’s scenes', () => {
  it('are 54 and 55, each step with words to say', () => {
    expect(PHONE_DEMO_SCENES.map((s) => s.number)).toEqual([54, 55]);
    for (const s of PHONE_DEMO_SCENES)
      for (const step of s.steps) {
        expect(step.label.trim()).not.toBe('');
        expect(step.voiceover.length).toBeGreaterThan(40);
      }
  });

  it('makes up ids no record of HandsFreeOS has, and finds them anywhere in a change', () => {
    expect(demoId(5401)).toBe('de300000-0000-4000-8000-000000005401');
    expect(isDemoId(demoId(1))).toBe(true);
    expect(mentionsDemo({ workspaceId: LONE_STAR, pushIds: [demoId(7)] })).toBe(true);
    expect(mentionsDemo({ workspaceId: LONE_STAR, conversationId: DALE })).toBe(false);
  });
});

describe('54: approve from the lock screen', () => {
  it('puts a text with a reply waiting for your OK in the inbox, signed by the business’s teammate', () => {
    const w = demoWorld(demo('lock-screen-approve', 1));
    expect(w.conversations).toHaveLength(1);
    const c = conversationOf(w.conversations[0]!);
    expect(c.counterpartDisplay).toBeTruthy();
    expect(w.conversations[0]).toMatchObject({ first_name: 'Marcus', draft_waiting: 1 });
    const draft = teammateDraftOf(w.drafts[0]!, { canManage: true });
    expect(draft.preview.message?.body).toBe(
      'Hi Marcus, this is Ava with Bayou Plumbing Co. Sorry about the heat! We can come out tomorrow at 10:00 AM to look at your AC. Does that work for you?',
    );
  });

  it('notifies as the worker’s draft push does, with Approve deciding the made-up draft', () => {
    const data = approvalPush(demo('lock-screen-approve', 2));
    expect(pushDataOf(data)).not.toBeNull();
    expect(data).toMatchObject({
      category: 'approval',
      title: 'Approval · Marcus Reed',
      subtitle: 'Bayou Plumbing Co.',
    });
    expect(data.body).toMatch(/^Ava wrote: “Hi Marcus, this is Ava/);
    const action = pressAction({ data, actionId: 'approve', typed: null, pressedAt: START });
    expect(action).toMatchObject({
      kind: 'command',
      command: { name: 'ai_teammate.decide_draft', input: { decision: 'approve' } },
      unlock: true,
    });
    expect(notificationOf(data, 'ios')?.content.categoryIdentifier).toBe('approval');
  });

  it('plays the Approve step once when it’s pressed on the lock screen, and sends nothing to HandsFreeOS', async () => {
    keepDemo(demo('lock-screen-approve', 2));
    const p = phone({ pretend: pretendChange });
    const dismissed: string[] = [];
    const deps: PressDeps = {
      platform: 'ios',
      now: () => p.clock.now,
      ready: async () => ({ userId: DALE, businessIds: [LONE_STAR] }),
      phoneLocked: () => false,
      change: (name, input, opts) => p.changes.change(name, input, opts),
      sendNow: (id) => p.changes.sendQueuedNow(id),
      openLink: () => undefined,
      appInFront: () => false,
      askAbout: () => undefined,
      unlockToRun: () => undefined,
      followUp: async () => undefined,
      dismiss: async (id) => void dismissed.push(id),
      store: memoryStore(),
    };
    const runner = new PressRunner(deps);
    const data = approvalPush(currentDemo()!);
    const press = { data, actionId: 'approve', typed: null, identifier: data.notificationId };

    expect(await runner.handle(press)).toMatchObject({ kind: 'sent', button: 'approve' });
    expect(await runner.handle(press)).toMatchObject({ kind: 'already' });
    expect(currentDemo()?.steps).toHaveLength(3);
    expect(dismissed).toEqual([data.notificationId, data.notificationId]);
    await p.sync();
    expect(p.api.sent()).toEqual([]);

    const w = demoWorld(currentDemo()!);
    expect(w.drafts).toEqual([]);
    const sent = threadItemsOf(w.messages, []).filter((m) => m.direction === 'outbound');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ approvedBy: { id: DALE, fullName: 'Dale Ramsey' } });
  });

  it('plays it from the card in the app too, and an Approve heard after the step played does nothing more', () => {
    keepDemo(demo('lock-screen-approve', 2));
    const input = { workspaceId: LONE_STAR, draftId: demoId(5403), decision: 'approve' };
    expect(pretendChange('ai_teammate.decide_draft', input, false)).toEqual({
      id: expect.stringMatching(/^de300000-/),
    });
    expect(currentDemo()?.steps).toHaveLength(3);
    pretendChange('ai_teammate.decide_draft', input, false);
    expect(currentDemo()?.steps).toHaveLength(3);
  });
});

describe('55: woken for a real emergency', () => {
  it('has the customer’s 2:07 AM text and the fixed flooding safety steps, and needs a person', () => {
    const d = demo('emergency-wakes-you', 1);
    const w = demoWorld(d);
    const items = threadItemsOf(w.messages, []);
    expect(items.map((i) => i.body)).toEqual([
      'Help!! Water everywhere. A pipe under the kitchen sink burst and it’s all over the floor',
      EMERGENCY_SAFETY_TEXT.flooding,
    ]);
    expect(wallMinutes(Date.parse(items[0]!.occurredAt), d.timeZone)).toBe(2 * 60 + 7);
    expect(items[1]).toMatchObject({ handoffLine: true, teammate: { name: 'Ava' } });
    expect(conversationOf(w.conversations[0]!)).toMatchObject({ handoffReason: 'emergency' });
  });

  it('is the night before when the scene starts before 2:07 AM', () => {
    // 1:00 AM in Houston.
    const early = Date.parse('2026-09-16T06:00:00.000Z');
    const night = nightOf(demo('emergency-wakes-you', 0, { startedAt: early }));
    expect(night).toBe(Date.parse('2026-09-15T07:07:00.000Z'));
  });

  it('alerts as the worker’s emergency hand-off does: urgent, time-sensitive on an iPhone, with Reply and Call', () => {
    const data = emergencyPush(demo('emergency-wakes-you', 1));
    expect(pushDataOf(data)).not.toBeNull();
    expect(data).toMatchObject({
      category: 'customer_waiting_no_ai',
      title: 'Emergency · Jenna Morales',
      subtitle: 'Text · Bayou Plumbing Co.',
      path: `/app/w/${LONE_STAR}/inbox/${demoId(5502)}`,
    });
    expect(notificationOf(data, 'ios')?.content.interruptionLevel).toBe('timeSensitive');
    expect(pressAction({ data, actionId: TAP, typed: null, pressedAt: START })).toEqual({
      kind: 'open',
      path: data.path,
      button: null,
    });
  });

  it('plays its tap step from the alert, once', () => {
    keepDemo(demo('emergency-wakes-you', 1));
    expect(playPress('approve')).toBe(false);
    expect(playPress('open')).toBe(true);
    expect(playPress('open')).toBe(false);
    expect(currentDemo()?.steps).toHaveLength(2);
  });

  it('ends with your reply from bed and her thanks, taken over by you', () => {
    const scene = findPhoneScene('emergency-wakes-you')!;
    const w = demoWorld(demo('emergency-wakes-you', scene.steps.length));
    const last = threadItemsOf(w.messages, []).slice(-2);
    expect(last[0]).toMatchObject({
      direction: 'outbound',
      sentBy: { id: DALE, fullName: 'Dale Ramsey' },
    });
    expect(last[0]!.body).toMatch(/^Jenna, this is Dale with Bayou Plumbing Co\. I’m on my way/);
    expect(conversationOf(w.conversations[0]!)).toMatchObject({ handledBy: 'person' });
  });
});

describe('a change about something made up', () => {
  it('is left alone when it’s real', () => {
    keepDemo(demo('lock-screen-approve', 1));
    expect(
      pretendChange(
        'conversation.mark_read',
        { workspaceId: LONE_STAR, conversationId: DALE },
        false,
      ),
    ).toBeNull();
  });

  it('is never kept or sent: a reply typed into a made-up thread shows there, and reading it reads it', async () => {
    keepDemo(demo('lock-screen-approve', 1));
    const p = phone({ pretend: pretendChange });
    const conversationId = demoId(5402);
    await p.changes.change('conversation.mark_read', { workspaceId: LONE_STAR, conversationId });
    await p.changes.change('message.send', {
      workspaceId: LONE_STAR,
      conversationId,
      channel: 'sms',
      body: 'On it, Marcus.',
    });
    await p.sync();
    expect(p.db.sqlite.prepare('SELECT count(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    expect(p.api.sent()).toEqual([]);
    const w = demoWorld(currentDemo()!);
    expect(w.conversations[0]).toMatchObject({ unread_count: 0, last_preview: 'On it, Marcus.' });
  });

  it('asked of HandsFreeOS straight away, is refused on the phone in plain words', () => {
    expect(pretendChange('conversation.get', { conversationId: demoId(5402) }, true)).toEqual({
      refused: PHONE_DEMO_WORDS.notReal,
    });
  });
});
