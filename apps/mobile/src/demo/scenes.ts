import {
  clipLine,
  EMERGENCY_SAFETY_TEXT,
  localDateOf,
  localInstant,
  PUSH_DATA_VERSION,
  PUSH_TEXT_MAX,
  type PushData,
} from '@hfos/core';

import { demoId } from './ids';
import type { PhoneDemo } from './state';
import {
  conversationRow,
  emptyWorld,
  inSentence,
  lastMessage,
  messageRow,
  patchConversation,
  personRow,
  type PhoneDemoScene,
  type PhoneDemoWorld,
} from './world';

/**
 * The scenes that play on the phone (the web's are in apps/web/src/lib/demo/scenes): 54, Approve from the lock screen,
 * and 55, woken for a real emergency. Each notification is worded as the worker words the real one
 * (apps/worker/src/push/moments.ts `draftPushOf`, apps/worker/src/ai-team/escalation.ts `tellTeam`), with the same
 * buttons, so what the video shows is what a business owner gets.
 */

const MINUTE = 60_000;

/** "“Hi Marcus…”" as the worker quotes a draft in a push. */
const quoted = (text: string, max = 140): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`;
};

/** A made-up push for the business the scene plays in. */
function pushOf(
  demo: PhoneDemo,
  fields: Pick<PushData, 'notificationId' | 'category' | 'path' | 'refs' | 'commandIds'> & {
    readonly title: string;
    readonly about?: string;
    readonly body: string;
    readonly collapseId?: string;
  },
): PushData {
  return {
    v: PUSH_DATA_VERSION,
    notificationId: fields.notificationId,
    category: fields.category,
    workspaceId: demo.workspaceId,
    business: demo.business,
    path: fields.path,
    sentAt: new Date().toISOString(),
    refs: fields.refs,
    commandIds: fields.commandIds,
    ...(fields.collapseId ? { collapseId: fields.collapseId } : {}),
    title: clipLine(fields.title, PUSH_TEXT_MAX.title),
    subtitle: clipLine(
      [fields.about, demo.business].filter((p): p is string => !!p?.trim()).join(' · '),
      PUSH_TEXT_MAX.subtitle,
    ),
    body: clipLine(fields.body, PUSH_TEXT_MAX.body),
  };
}

// ---------- 54: Approve from the lock screen ----------

const MARCUS = {
  person: demoId(5401),
  conversation: demoId(5402),
  draft: demoId(5403),
  asked: demoId(5404),
  sent: demoId(5405),
  thanks: demoId(5406),
  push: demoId(5407),
  approve: demoId(5408),
  phone: '+17135550186',
};

const MARCUS_ASKS =
  'Hi, my AC is blowing warm air and it’s 88 in here. Can someone come out tomorrow?';

const marcusReply = (demo: PhoneDemo) =>
  `Hi Marcus, this is ${demo.teammate} with ${inSentence(demo.business)}. Sorry about the heat! We can come out tomorrow at 10:00 AM to look at your AC. Does that work for you?`;

/** The reply's push, as `draftPushOf` words it: "Approval · Marcus Reed", "Ava wrote: “…”". */
export function approvalPush(demo: PhoneDemo): PushData {
  const ws = demo.workspaceId;
  return pushOf(demo, {
    notificationId: MARCUS.push,
    category: 'approval',
    title: 'Approval · Marcus Reed',
    body: `${demo.teammate} wrote: ${quoted(marcusReply(demo))}`,
    path: `/app/w/${ws}/workflows/approvals?filter=ai`,
    refs: {
      draftId: MARCUS.draft,
      conversationId: MARCUS.conversation,
      channel: 'sms',
      personId: MARCUS.person,
    },
    commandIds: { approve: MARCUS.approve },
  });
}

const LOCK_SCREEN: PhoneDemoScene = {
  id: 'lock-screen-approve',
  number: 54,
  title: 'Approve from the lock screen',
  summary: 'A push comes in, you tap Approve, and the text goes.',
  steps: [
    {
      label: 'A customer texts while you’re out',
      voiceover:
        'It’s dinner time and you’re nowhere near a desk. Marcus texts that his AC is blowing warm air. Your AI teammate writes back right away, but you asked it to check with you before it sends.',
      change: (w, { demo, at }) => {
        w.people.push(
          personRow(
            {
              id: MARCUS.person,
              first_name: 'Marcus',
              last_name: 'Reed',
              phone_e164: MARCUS.phone,
            },
            at - 3 * MINUTE,
          ),
        );
        const asked = messageRow(
          {
            id: MARCUS.asked,
            conversation_id: MARCUS.conversation,
            direction: 'inbound',
            body_text: MARCUS_ASKS,
            from_address: MARCUS.phone,
          },
          at - MINUTE,
        );
        w.messages.push(asked);
        w.conversations.push(
          conversationRow(
            {
              id: MARCUS.conversation,
              counterpart: MARCUS.phone,
              person_id: MARCUS.person,
              first_name: 'Marcus',
              last_name: 'Reed',
              teammate_name: demo.teammate,
              ai_teammate_id: demoId(5409),
              awaiting_reply_since: asked.occurred_at,
              draft_waiting: 1,
              ...lastMessage(asked),
            },
            at - MINUTE,
          ),
        );
        w.drafts.push({
          id: MARCUS.draft,
          teammate_id: demoId(5409),
          teammate_name: demo.teammate,
          conversation_id: MARCUS.conversation,
          channel: 'sms',
          person_id: MARCUS.person,
          first_name: 'Marcus',
          last_name: 'Reed',
          lead_id: null,
          kind: 'reply',
          status: 'pending',
          preview: JSON.stringify({ message: { body: marcusReply(demo), channel: 'sms' } }),
          edits: null,
          expires_at: null,
          created_at: new Date(at - MINUTE + 20_000).toISOString(),
        });
      },
      run: (p) => p.open('inbox'),
    },
    {
      label: 'Lock your phone',
      voiceover:
        'Put the phone away. A few seconds later it lights up: your teammate’s reply, waiting for your OK, right on the lock screen.',
      cue: 'Lock your phone now. The notification comes in 6 seconds.',
      run: (p) => p.push(approvalPush(p.demo), 6),
    },
    {
      label: 'Tap Approve on the lock screen',
      voiceover:
        'Press and hold the notification, read what it wants to send, and tap Approve. Face ID checks it’s you, and the text goes to Marcus. You never opened the app.',
      cue: 'Press and hold the notification, then tap Approve. Or tap Next to approve it from here.',
      press: 'approve',
      change: (w, { demo, at }) => {
        w.drafts = w.drafts.filter((d) => d.id !== MARCUS.draft);
        const sent = messageRow(
          {
            id: MARCUS.sent,
            conversation_id: MARCUS.conversation,
            direction: 'outbound',
            body_text: marcusReply(demo),
            sent_by_teammate_id: demoId(5409),
            teammate_name: demo.teammate,
            approved_by: demo.viewerId,
            approved_name: demo.myName || null,
          },
          at,
        );
        w.messages.push(sent);
        patchConversation(w, MARCUS.conversation, {
          draft_waiting: 0,
          awaiting_reply_since: null,
          ...lastMessage(sent),
        });
      },
      run: (p) => p.clearPushes(),
    },
    {
      label: 'Open the app: the text went',
      voiceover:
        'Open HandsFreeOS and there it is: the reply went out with your OK on it, and Marcus already wrote back. That’s a booked job from the lock screen.',
      change: (w, { at }) => {
        const thanks = messageRow(
          {
            id: MARCUS.thanks,
            conversation_id: MARCUS.conversation,
            direction: 'inbound',
            body_text: 'Perfect, 10 works. Thank you!',
            from_address: MARCUS.phone,
          },
          at,
        );
        w.messages.push(thanks);
        patchConversation(w, MARCUS.conversation, {
          unread_count: 1,
          awaiting_reply_since: thanks.occurred_at,
          ...lastMessage(thanks),
        });
      },
      run: (p) => p.open(`inbox/${MARCUS.conversation}`),
    },
  ],
};

// ---------- 55: Woken for a real emergency ----------

const JENNA = {
  person: demoId(5501),
  conversation: demoId(5502),
  wrote: demoId(5503),
  safety: demoId(5504),
  mine: demoId(5505),
  thanks: demoId(5506),
  push: demoId(5507),
  reply: demoId(5508),
  phone: '+17135550143',
};

const JENNA_WROTE =
  'Help!! Water everywhere. A pipe under the kitchen sink burst and it’s all over the floor';

/** 2:07 AM, the last one before the scene started, in the business's time zone. */
export function nightOf(demo: PhoneDemo): number {
  const today = localInstant(localDateOf(demo.startedAt, demo.timeZone), '02:07', demo.timeZone);
  if (today <= demo.startedAt) return today;
  return localInstant(
    localDateOf(demo.startedAt - 24 * 60 * MINUTE, demo.timeZone),
    '02:07',
    demo.timeZone,
  );
}

/** The hand-off's push, as `tellTeam` words an emergency: "Emergency · Jenna Morales", "Text · <business>". */
export function emergencyPush(demo: PhoneDemo): PushData {
  const ws = demo.workspaceId;
  return pushOf(demo, {
    notificationId: JENNA.push,
    category: 'customer_waiting_no_ai',
    title: 'Emergency · Jenna Morales',
    about: 'Text',
    body: JENNA_WROTE,
    path: `/app/w/${ws}/inbox/${JENNA.conversation}`,
    refs: { conversationId: JENNA.conversation, personId: JENNA.person },
    commandIds: { reply: JENNA.reply },
    collapseId: `conversation-${JENNA.conversation}`,
  });
}

const myReply = (demo: PhoneDemo) =>
  `Jenna, this is ${demo.me || 'the owner'} with ${inSentence(demo.business)}. I’m on my way, about 25 minutes out. If you can, keep the main valve off and towels down.`;

const EMERGENCY: PhoneDemoScene = {
  id: 'emergency-wakes-you',
  number: 55,
  title: 'Woken for a real emergency',
  summary:
    'A 2 AM “water everywhere” text gets safety steps from the teammate and an urgent push to your phone.',
  steps: [
    {
      label: 'Lock your phone: it’s 2 AM',
      voiceover:
        'It’s two in the morning and you’re asleep. Jenna texts that water is everywhere. Your AI teammate knows that’s an emergency: it sends her safety steps right away and wakes you up.',
      cue: 'Lock your phone now. The alert comes in 6 seconds.',
      change: (w, { demo }) => {
        const night = nightOf(demo);
        w.people.push(
          personRow(
            {
              id: JENNA.person,
              first_name: 'Jenna',
              last_name: 'Morales',
              phone_e164: JENNA.phone,
            },
            night - 400 * 24 * 60 * MINUTE,
          ),
        );
        const wrote = messageRow(
          {
            id: JENNA.wrote,
            conversation_id: JENNA.conversation,
            direction: 'inbound',
            body_text: JENNA_WROTE,
            from_address: JENNA.phone,
          },
          night,
        );
        const safety = messageRow(
          {
            id: JENNA.safety,
            conversation_id: JENNA.conversation,
            direction: 'outbound',
            body_text: EMERGENCY_SAFETY_TEXT.flooding,
            sent_by_teammate_id: demoId(5509),
            teammate_name: demo.teammate,
            client_id: `handoff:${JENNA.conversation}:1`,
          },
          night + 20_000,
        );
        w.messages.push(wrote, safety);
        w.conversations.push(
          conversationRow(
            {
              id: JENNA.conversation,
              counterpart: JENNA.phone,
              person_id: JENNA.person,
              first_name: 'Jenna',
              last_name: 'Morales',
              teammate_name: demo.teammate,
              ai_teammate_id: demoId(5509),
              awaiting_reply_since: wrote.occurred_at,
              needs_person_since: wrote.occurred_at,
              handoff_reason: 'emergency',
              ...lastMessage(wrote),
              last_message_at: safety.occurred_at,
              last_preview: safety.body_text,
              last_direction: 'outbound',
            },
            night,
          ),
        );
      },
      run: (p) => p.push(emergencyPush(p.demo), 6),
    },
    {
      label: 'The one alert that wakes you',
      voiceover:
        'It breaks through Do Not Disturb with an urgent alert: Emergency, Jenna Morales, and what she wrote. Most messages wait for the morning. This one doesn’t. Tap it.',
      cue: 'Tap the alert to open it, or tap Next.',
      press: 'open',
      run: (p) => p.open(`inbox/${JENNA.conversation}`),
    },
    {
      label: 'She already has safety steps',
      voiceover:
        'Her message is right here, and so is what your teammate sent her the moment she wrote: stay away from outlets, shut off the main valve if it’s safe, and that your team was alerted. Nobody waited for you to wake up.',
      run: (p) => p.open(`inbox/${JENNA.conversation}`),
    },
    {
      label: 'Text her back from bed',
      voiceover:
        'You answer in a few words, and she knows a real person is on the way. The AI handled the first minute. You handle the job.',
      change: (w, { demo }) => {
        const night = nightOf(demo);
        const mine = messageRow(
          {
            id: JENNA.mine,
            conversation_id: JENNA.conversation,
            direction: 'outbound',
            body_text: myReply(demo),
            sent_by: demo.viewerId,
            sent_by_name: demo.myName || null,
          },
          night + 3 * MINUTE,
        );
        const thanks = messageRow(
          {
            id: JENNA.thanks,
            conversation_id: JENNA.conversation,
            direction: 'inbound',
            body_text: 'Thank you!! Valve is off. I’ll leave the porch light on.',
            from_address: JENNA.phone,
          },
          night + 4 * MINUTE,
        );
        w.messages.push(mine, thanks);
        patchConversation(w, JENNA.conversation, {
          handled_by: 'person',
          taken_over_by: demo.viewerId,
          taken_over_name: demo.myName || null,
          needs_person_since: null,
          unread_count: 0,
          awaiting_reply_since: thanks.occurred_at,
          ...lastMessage(thanks),
        });
      },
      run: (p) => p.open(`inbox/${JENNA.conversation}`),
    },
  ],
};

export const PHONE_DEMO_SCENES: readonly PhoneDemoScene[] = [LOCK_SCREEN, EMERGENCY];

export const findPhoneScene = (id: string): PhoneDemoScene | null =>
  PHONE_DEMO_SCENES.find((s) => s.id === id) ?? null;

/** The made-up rows a scene has put on the screens so far: its played steps, then what the presenter did. */
export function demoWorld(demo: PhoneDemo): PhoneDemoWorld {
  const world = emptyWorld();
  const scene = findPhoneScene(demo.scene);
  if (!scene) return world;
  scene.steps.slice(0, demo.steps.length).forEach((step, i) => {
    step.change?.(world, { demo, at: demo.startedAt + (demo.steps[i] ?? 0) });
  });
  for (const t of demo.typed) {
    if (!world.conversations.some((c) => c.id === t.conversationId)) continue;
    const typed = messageRow(
      {
        id: t.id,
        conversation_id: t.conversationId,
        direction: 'outbound',
        body_text: t.body,
        sent_by: demo.viewerId,
        sent_by_name: demo.myName || null,
      },
      t.at,
    );
    world.messages.push(typed);
    patchConversation(world, t.conversationId, {
      awaiting_reply_since: null,
      ...lastMessage(typed),
    });
  }
  for (const id of demo.read) patchConversation(world, id, { unread_count: 0 });
  return world;
}

/** Every step's voiceover in order, numbered, to read before recording. */
export function phoneVoiceover(scene: PhoneDemoScene): string {
  return scene.steps.map((s, i) => `${i + 1}. ${s.label}\n${s.voiceover}`).join('\n\n');
}
