import { PUSH_BUTTONS, PUSH_CATEGORIES, PUSH_CATEGORY_IDS, PushData } from '@hfos/core';

import { pressAction, pressKey, snoozeUntil, TAP } from '../buttons';
import { allCategories, categoryActions } from '../categories';

import {
  APPROVAL,
  approval,
  CHECK_IN,
  COMMAND_IDS,
  CONVERSATION,
  customerMessage,
  DRAFT,
  ITEM,
  LONE_STAR,
  safetyCheck,
  supportTicket,
  TICKET,
  urgentLead,
} from './fixtures';

/**
 * Every category the worker sends, with its buttons in order and each button's rules (apps/worker/src/push/README.md,
 * "Kinds of push" and "The buttons"), and what each button does with the notification's own command ids.
 */

const PRESSED = Date.parse('2026-09-16T22:40:00.000Z');

describe('the notification categories', () => {
  it('registers every category the worker sends, with its buttons in order', () => {
    const titles = Object.fromEntries(
      allCategories().map((c) => [c.id, c.actions.map((a) => a.buttonTitle)]),
    );
    expect(titles).toEqual({
      customer_message: ['Reply', 'Call', 'Let AI handle'],
      customer_message_no_ai: ['Reply', 'Call'],
      customer_waiting: ['Reply', 'Call', 'Let AI handle'],
      customer_waiting_no_ai: ['Reply', 'Call'],
      urgent_lead: ['Call', 'Let HandsFreeOS handle', 'Snooze 1 hour'],
      urgent_lead_no_ai: ['Call', 'Snooze 1 hour'],
      missed_call: ['Call', 'Reply'],
      voicemail: ['Call', 'Reply'],
      approval: ['Approve', 'Review'],
      booking: ['Open'],
      assigned: ['Open'],
      payment: ['Open'],
      wallet: ['Open'],
      job_check: ['Done', 'Didn’t happen', 'Still there'],
      connection: ['Open'],
      addon_alert: ['Open'],
      customer_file: ['Open'],
      lead_qualified: ['Open'],
      support_ticket: ['Open'],
      safety_check: ['I’m OK', '+15 min'],
      safety_alert: ['Open'],
    });
    expect(Object.keys(titles).sort()).toEqual([...PUSH_CATEGORY_IDS].sort());
  });

  it('asks for the phone’s unlock before the buttons that reach a customer or approve something, and not for Snooze', () => {
    const rules = Object.fromEntries(
      PUSH_CATEGORY_IDS.flatMap((c) => categoryActions(c)).map((a) => [a.identifier, a.options]),
    );
    expect(rules).toEqual({
      reply: { opensAppToForeground: false, isAuthenticationRequired: true, isDestructive: false },
      let_ai_handle: {
        opensAppToForeground: false,
        isAuthenticationRequired: true,
        isDestructive: false,
      },
      let_handle: {
        opensAppToForeground: false,
        isAuthenticationRequired: true,
        isDestructive: false,
      },
      approve: {
        opensAppToForeground: false,
        isAuthenticationRequired: true,
        isDestructive: false,
      },
      snooze: {
        opensAppToForeground: false,
        isAuthenticationRequired: false,
        isDestructive: false,
      },
      // Marking a visit changes the business's records; saying you're still there doesn't.
      done: { opensAppToForeground: false, isAuthenticationRequired: true, isDestructive: false },
      no_show: {
        opensAppToForeground: false,
        isAuthenticationRequired: true,
        isDestructive: false,
      },
      still_there: {
        opensAppToForeground: false,
        isAuthenticationRequired: false,
        isDestructive: false,
      },
      // A check-in's "Still there?", answered from the lock screen: whoever holds the phone is the one asked.
      im_ok: { opensAppToForeground: false, isAuthenticationRequired: false, isDestructive: false },
      add_15: {
        opensAppToForeground: false,
        isAuthenticationRequired: false,
        isDestructive: false,
      },
      // Call, Review and Open open the app.
      call: { opensAppToForeground: true, isAuthenticationRequired: false, isDestructive: false },
      review: { opensAppToForeground: true, isAuthenticationRequired: false, isDestructive: false },
      open: { opensAppToForeground: true, isAuthenticationRequired: false, isDestructive: false },
    });
  });

  it('types Reply in the notification', () => {
    const reply = categoryActions('customer_message')[0]!;
    expect(reply).toEqual({
      identifier: 'reply',
      buttonTitle: 'Reply',
      textInput: { placeholder: 'Write a reply', submitButtonTitle: 'Send' },
      options: {
        opensAppToForeground: false,
        isAuthenticationRequired: true,
        isDestructive: false,
      },
    });
    for (const c of PUSH_CATEGORY_IDS)
      for (const a of categoryActions(c))
        if (a.identifier !== 'reply') expect(a.textInput).toBeUndefined();
  });

  it('follows core’s own lists, button by button', () => {
    for (const c of PUSH_CATEGORY_IDS)
      for (const a of categoryActions(c)) {
        const def = PUSH_BUTTONS[a.identifier];
        expect(a.options.isAuthenticationRequired).toBe(def.unlock);
        expect(a.options.opensAppToForeground).toBe(def.opensApp);
        expect(PUSH_CATEGORIES[c].buttons).toContain(a.identifier);
      }
  });
});

describe('what a press does', () => {
  it('replies under the command id the notification carries for Reply, on the conversation’s channel', () => {
    const data = customerMessage();
    expect(
      pressAction({
        data,
        actionId: 'reply',
        typed: ' Marco can be there at 11. ',
        pressedAt: PRESSED,
      }),
    ).toEqual({
      kind: 'command',
      button: 'reply',
      commandId: COMMAND_IDS.reply,
      unlock: true,
      command: {
        name: 'message.send',
        input: {
          workspaceId: LONE_STAR,
          conversationId: CONVERSATION,
          channel: 'sms',
          body: 'Marco can be there at 11.',
        },
      },
    });
    // A reply to an email goes by email.
    const email = customerMessage({ refs: { conversationId: CONVERSATION, channel: 'email' } });
    expect(
      pressAction({ data: email, actionId: 'reply', typed: 'Yes', pressedAt: PRESSED }),
    ).toMatchObject({
      command: { input: { channel: 'email' } },
    });
  });

  it('sends nothing for an empty reply', () => {
    expect(
      pressAction({ data: customerMessage(), actionId: 'reply', typed: '   ', pressedAt: PRESSED }),
    ).toEqual({ kind: 'nothing', reason: 'Nothing was written, so nothing was sent.' });
  });

  it('hands the conversation to AI, or the Home item to HandsFreeOS, under their own command ids', () => {
    expect(
      pressAction({
        data: customerMessage(),
        actionId: 'let_ai_handle',
        typed: null,
        pressedAt: PRESSED,
      }),
    ).toEqual({
      kind: 'command',
      button: 'let_ai_handle',
      commandId: COMMAND_IDS.let_ai_handle,
      unlock: true,
      command: {
        name: 'conversation.hand_to_ai',
        input: { workspaceId: LONE_STAR, conversationId: CONVERSATION },
      },
    });
    expect(
      pressAction({ data: urgentLead(), actionId: 'let_handle', typed: null, pressedAt: PRESSED }),
    ).toEqual({
      kind: 'command',
      button: 'let_handle',
      commandId: COMMAND_IDS.let_handle,
      unlock: true,
      command: {
        name: 'attention.let_handle',
        input: { workspaceId: LONE_STAR, itemId: ITEM, action: 'hand_to_ai' },
      },
    });
  });

  it('snoozes an hour from the moment it was pressed, without asking for the unlock', () => {
    expect(snoozeUntil(PRESSED)).toBe('2026-09-16T23:40:00.000Z');
    expect(
      pressAction({ data: urgentLead(), actionId: 'snooze', typed: null, pressedAt: PRESSED }),
    ).toEqual({
      kind: 'command',
      button: 'snooze',
      commandId: COMMAND_IDS.snooze,
      unlock: false,
      command: {
        name: 'attention.snooze',
        input: { workspaceId: LONE_STAR, itemId: ITEM, until: '2026-09-16T23:40:00.000Z' },
      },
    });
  });

  it('approves a draft or a workflow step, whichever the notification is about', () => {
    expect(
      pressAction({
        data: approval('draft'),
        actionId: 'approve',
        typed: null,
        pressedAt: PRESSED,
      }),
    ).toMatchObject({
      command: {
        name: 'ai_teammate.decide_draft',
        input: { workspaceId: LONE_STAR, draftId: DRAFT, decision: 'approve' },
      },
      commandId: COMMAND_IDS.approve,
      unlock: true,
    });
    expect(
      pressAction({ data: approval('step'), actionId: 'approve', typed: null, pressedAt: PRESSED }),
    ).toMatchObject({
      command: {
        name: 'workflow.decide_approval',
        input: { workspaceId: LONE_STAR, approvalId: APPROVAL, decision: 'approve' },
      },
    });
  });

  it('checks out with I’m OK and adds fifteen minutes with +15 min, from the lock screen', () => {
    expect(
      pressAction({ data: safetyCheck(), actionId: 'im_ok', typed: null, pressedAt: PRESSED }),
    ).toEqual({
      kind: 'command',
      button: 'im_ok',
      commandId: COMMAND_IDS.im_ok,
      unlock: false,
      command: { name: 'safety.check_out', input: { workspaceId: LONE_STAR, checkInId: CHECK_IN } },
    });
    expect(
      pressAction({ data: safetyCheck(), actionId: 'add_15', typed: null, pressedAt: PRESSED }),
    ).toEqual({
      kind: 'command',
      button: 'add_15',
      commandId: COMMAND_IDS.add_15,
      unlock: false,
      command: {
        name: 'safety.extend',
        input: { workspaceId: LONE_STAR, checkInId: CHECK_IN, minutes: 15 },
      },
    });
    // Without the check-in it's about, there's nothing to check out of.
    expect(
      pressAction({
        data: safetyCheck({ refs: {} }),
        actionId: 'im_ok',
        typed: null,
        pressedAt: PRESSED,
      }),
    ).toEqual({ kind: 'nothing', reason: 'This notification isn’t about a check-in.' });
    expect(PushData.safeParse(safetyCheck()).success).toBe(true);
  });

  it('opens the push’s path for a tap, Call, Review and Open', () => {
    const data = customerMessage();
    for (const actionId of [TAP, 'call'])
      expect(pressAction({ data, actionId, typed: null, pressedAt: PRESSED })).toEqual({
        kind: 'open',
        path: data.path,
        button: actionId === TAP ? null : 'call',
      });
    expect(
      pressAction({ data: approval(), actionId: 'review', typed: null, pressedAt: PRESSED }),
    ).toMatchObject({
      kind: 'open',
      path: `/app/w/${LONE_STAR}/workflows/approvals?filter=ai`,
    });
  });

  it('opens a new support ticket on the support desk, for a tap and for Open, and runs nothing', () => {
    const data = supportTicket();
    for (const actionId of [TAP, 'open'])
      expect(pressAction({ data, actionId, typed: null, pressedAt: PRESSED })).toEqual({
        kind: 'open',
        path: `/admin/tickets/${TICKET}`,
        button: actionId === TAP ? null : 'open',
      });
    // It carries no business, so no button could run a command in one.
    expect(pressAction({ data, actionId: 'reply', typed: 'Hi', pressedAt: PRESSED })).toMatchObject(
      { kind: 'nothing' },
    );
  });

  it('does nothing for a button that isn’t on the notification, or one it carries no command id for', () => {
    expect(
      pressAction({
        data: urgentLead('urgent_lead_no_ai'),
        actionId: 'let_handle',
        typed: null,
        pressedAt: PRESSED,
      }),
    ).toEqual({ kind: 'nothing', reason: 'That button isn’t on this notification.' });
    expect(
      pressAction({
        data: customerMessage({ commandIds: {} }),
        actionId: 'reply',
        typed: 'Hi',
        pressedAt: PRESSED,
      }),
    ).toEqual({ kind: 'nothing', reason: 'This notification can’t do that from here.' });
    expect(
      pressAction({ data: customerMessage(), actionId: 'delete', typed: null, pressedAt: PRESSED }),
    ).toMatchObject({
      kind: 'nothing',
    });
  });

  it('keys a press by the moment and the button, the same on a second press', () => {
    expect(pressKey(customerMessage(), 'reply')).toBe('20000000-0000-4000-8000-000000000001:reply');
    expect(PushData.safeParse(customerMessage()).success).toBe(true);
    expect(PushData.safeParse(supportTicket()).success).toBe(true);
  });
});
