import { followUpOf } from '../press';
import {
  followUpOfResponse,
  notificationIdentifierOf,
  pressOf,
  pushDataOfNotification,
  showsPush,
  taskEventOf,
} from '../payload';
import {
  CHANNEL_ID,
  followUpNotificationOf,
  notificationOf,
  Presenter,
  type LocalNotification,
} from '../present';

import { approval, CONVERSATION, customerMessage, LONE_STAR, urgentLead } from './fixtures';

/**
 * Android's data-only pushes, shown by the app itself: the words from `data`, the category's buttons, one notification
 * per conversation, quiet updates without a sound, and nothing for someone this phone doesn't belong to. And reading a
 * push's data wherever the phone hands it over.
 */

function presenter(options: { forThisPhone?: boolean; platform?: 'ios' | 'android' } = {}) {
  const shown: LocalNotification[] = [];
  let now = Date.parse('2026-09-16T20:00:00.000Z');
  const p = new Presenter({
    platform: options.platform ?? 'android',
    schedule: async (n) => void shown.push(n),
    forThisPhone: () => options.forThisPhone ?? true,
    now: () => now,
  });
  return { p, shown, advance: (ms: number) => (now += ms) };
}

describe('the Android presenter', () => {
  it('shows a customer’s message with its words and buttons, under the conversation’s one notification', async () => {
    const { p, shown } = presenter();
    await expect(p.present(customerMessage())).resolves.toBe('shown');
    expect(shown).toEqual([
      {
        identifier: `conversation-${CONVERSATION}`,
        content: {
          title: 'Kendra Lee',
          subtitle: 'Text · Lone Star HVAC & Roofing',
          body: 'The furnace is clicking again. Can someone come out today?',
          data: customerMessage(),
          categoryIdentifier: 'customer_message',
          sound: 'default',
          priority: 'max',
          autoDismiss: true,
        },
        trigger: { channelId: CHANNEL_ID },
      },
    ]);
  });

  it('replaces the conversation’s notification with the next message, quietly during a burst', async () => {
    const { p, shown } = presenter();
    await p.present(customerMessage());
    await p.present(
      customerMessage({
        notificationId: '20000000-0000-4000-8000-000000000009',
        body: 'Actually it stopped. Tomorrow is fine.',
        quiet: true,
      }),
    );
    expect(shown.map((n) => n.identifier)).toEqual([
      `conversation-${CONVERSATION}`,
      `conversation-${CONVERSATION}`,
    ]);
    expect(shown[1]!.content).toMatchObject({
      body: 'Actually it stopped. Tomorrow is fine.',
      sound: false,
      priority: 'default',
    });
  });

  it('shows a push with no conversation under its own moment', async () => {
    const { p, shown } = presenter();
    await p.present(urgentLead());
    expect(shown[0]).toMatchObject({
      identifier: urgentLead().notificationId,
      content: { title: 'Hot lead · Maria Lopez', categoryIdentifier: 'urgent_lead' },
    });
    expect(notificationIdentifierOf(approval())).toBe(approval().notificationId);
  });

  it('shows a moment heard twice (the background task and a listener) once, unless asked to show it again', async () => {
    const { p, shown } = presenter();
    await p.present(customerMessage());
    await expect(p.present(customerMessage())).resolves.toBe('already-shown');
    expect(shown).toHaveLength(1);
    await expect(p.present(customerMessage(), { again: true })).resolves.toBe('shown');
    expect(shown).toHaveLength(2);
  });

  it('shows nothing for someone who isn’t signed in here, or a business that isn’t theirs, or a push with no words', async () => {
    const other = presenter({ forThisPhone: false });
    await expect(other.p.present(customerMessage())).resolves.toBe('not-for-this-phone');
    expect(other.shown).toEqual([]);
    const words = presenter();
    await expect(words.p.present(customerMessage({ title: undefined }))).resolves.toBe('no-words');
    expect(words.shown).toEqual([]);
  });

  it('shows the stand-in pushes on an iPhone the way iOS would: time-sensitive for the urgent kinds, passive when quiet', () => {
    expect(notificationOf(urgentLead(), 'ios')).toMatchObject({
      trigger: null,
      content: { interruptionLevel: 'timeSensitive', sound: 'default' },
    });
    expect(notificationOf(customerMessage(), 'ios')?.content.interruptionLevel).toBe('active');
    expect(notificationOf(customerMessage({ quiet: true }), 'ios')?.content).toMatchObject({
      interruptionLevel: 'passive',
      sound: false,
    });
  });

  it('replaces a push’s notification with what a press left to say, silently and without buttons', () => {
    const n = followUpNotificationOf(
      {
        kind: 'unlock',
        data: customerMessage(),
        title: 'Kendra Lee',
        body: 'Unlock your phone to send your reply.',
      },
      'android',
    );
    expect(n.identifier).toBe(`conversation-${CONVERSATION}`);
    expect(n.content.categoryIdentifier).toBeUndefined();
    expect(n.content).toMatchObject({
      body: 'Unlock your phone to send your reply.',
      sound: false,
    });
    expect(followUpOf(n.content.data['followUp'])).toEqual({ kind: 'unlock' });
  });
});

describe('reading a push', () => {
  it('reads Android’s data-only push in the background task, and a button pressed on a notification', () => {
    const data = customerMessage();
    expect(
      taskEventOf({
        collapseKey: null,
        data: {
          body: JSON.stringify(data),
          dataString: JSON.stringify(data),
          experienceId: '@hfos/x',
        },
        notification: null,
      }),
    ).toEqual({ kind: 'received', data });

    const response = {
      actionIdentifier: 'reply',
      userText: 'Marco can be there at 11.',
      notification: {
        date: 1,
        request: {
          identifier: `conversation-${CONVERSATION}`,
          content: { title: 'Kendra Lee', dataString: JSON.stringify(data) },
          trigger: { type: 'channel', channelId: 'hfos' },
        },
      },
    };
    expect(taskEventOf(response)).toEqual({
      kind: 'pressed',
      press: {
        data,
        actionId: 'reply',
        typed: 'Marco can be there at 11.',
        identifier: `conversation-${CONVERSATION}`,
        title: 'Kendra Lee',
      },
    });
  });

  it('reads an iPhone push’s data, and what a follow-up notification is about', () => {
    const data = approval();
    const notification = { request: { identifier: 'x', content: { title: 'Approval', data } } };
    expect(pushDataOfNotification(notification)).toEqual(data);
    const followUp = {
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: {
        request: {
          identifier: 'x',
          content: { data: { ...data, followUp: { kind: 'ask', changeId: 'c1' } } },
        },
      },
    };
    expect(pressOf(followUp)?.data.workspaceId).toBe(LONE_STAR);
    expect(followUpOf(followUpOfResponse(followUp))).toEqual({ kind: 'ask', changeId: 'c1' });
  });

  it('takes a notification away only while it is still the pressed push’s, not a newer message’s in its place', () => {
    const pressed = customerMessage();
    const identifier = notificationIdentifierOf(pressed);
    const showing = (data: object) => [
      { request: { identifier: 'other', content: { data: customerMessage() } } },
      { request: { identifier, content: { data } } },
    ];
    expect(showsPush(showing(pressed), identifier, pressed.notificationId)).toBe(true);
    // What the press left to say about it ("Unlock your phone to send your reply.") is the same push's.
    expect(
      showsPush(
        showing({ ...pressed, followUp: { kind: 'unlock' } }),
        identifier,
        pressed.notificationId,
      ),
    ).toBe(true);
    // Maria wrote again meanwhile: her new message keeps its notification.
    const newer = customerMessage({ notificationId: '20000000-0000-4000-8000-000000000009' });
    expect(showsPush(showing(newer), identifier, pressed.notificationId)).toBe(false);
    expect(showsPush([], identifier, pressed.notificationId)).toBe(false);
  });

  it('leaves anything that isn’t a HandsFreeOS push alone', () => {
    expect(taskEventOf({ data: { dataString: '{"hello":1}' } })).toEqual({ kind: 'other' });
    expect(taskEventOf(null)).toEqual({ kind: 'other' });
    expect(
      pressOf({ actionIdentifier: 'reply', notification: { request: { content: {} } } }),
    ).toBeNull();
    // A push from a newer version of the contract isn't read as this one.
    expect(
      pushDataOfNotification({ request: { content: { data: { ...customerMessage(), v: 2 } } } }),
    ).toBeNull();
  });
});
