import type { PushCategory, PushData } from '@hfos/core';

/** Pushes as the worker sends them (apps/worker/src/push/payload.ts), for the push tests. */

export const LONE_STAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CONVERSATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const ITEM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const APPROVAL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const DRAFT = '99999999-9999-4999-8999-999999999999';

const ids = {
  reply: '10000000-0000-4000-8000-000000000001',
  let_ai_handle: '10000000-0000-4000-8000-000000000002',
  let_handle: '10000000-0000-4000-8000-000000000003',
  snooze: '10000000-0000-4000-8000-000000000004',
  approve: '10000000-0000-4000-8000-000000000005',
  im_ok: '10000000-0000-4000-8000-000000000006',
  add_15: '10000000-0000-4000-8000-000000000007',
} as const;

export function customerMessage(overrides: Partial<PushData> = {}): PushData {
  return {
    v: 1,
    notificationId: '20000000-0000-4000-8000-000000000001',
    category: 'customer_message',
    workspaceId: LONE_STAR,
    business: 'Lone Star HVAC & Roofing',
    path: `/app/w/${LONE_STAR}/inbox/${CONVERSATION}`,
    sentAt: '2026-09-16T20:00:00.000Z',
    refs: { conversationId: CONVERSATION, channel: 'sms' },
    commandIds: { reply: ids.reply, let_ai_handle: ids.let_ai_handle },
    collapseId: `conversation-${CONVERSATION}`,
    title: 'Kendra Lee',
    subtitle: 'Text · Lone Star HVAC & Roofing',
    body: 'The furnace is clicking again. Can someone come out today?',
    ...overrides,
  };
}

export function urgentLead(category: PushCategory = 'urgent_lead'): PushData {
  return {
    v: 1,
    notificationId: '20000000-0000-4000-8000-000000000002',
    category,
    workspaceId: LONE_STAR,
    business: 'Lone Star HVAC & Roofing',
    path: `/app/w/${LONE_STAR}?item=${ITEM}`,
    sentAt: '2026-09-16T20:00:00.000Z',
    refs: { itemId: ITEM },
    commandIds:
      category === 'urgent_lead'
        ? { let_handle: ids.let_handle, snooze: ids.snooze }
        : { snooze: ids.snooze },
    title: 'Hot lead · Maria Lopez',
    subtitle: 'Lone Star HVAC & Roofing',
    body: 'New AC install · $18,500. Asked for a price and how soon someone can come out.',
  };
}

export function approval(kind: 'draft' | 'step' = 'draft'): PushData {
  return {
    v: 1,
    notificationId: '20000000-0000-4000-8000-000000000003',
    category: 'approval',
    workspaceId: LONE_STAR,
    business: 'Lone Star HVAC & Roofing',
    path:
      kind === 'draft'
        ? `/app/w/${LONE_STAR}/workflows/approvals?filter=ai`
        : `/app/w/${LONE_STAR}/workflows/approvals`,
    sentAt: '2026-09-16T20:00:00.000Z',
    refs: kind === 'draft' ? { draftId: DRAFT } : { approvalId: APPROVAL },
    commandIds: { approve: ids.approve },
    title: 'Approval · Angela Brooks',
    subtitle: 'Lone Star HVAC & Roofing',
    body: 'Ava wrote: “Hi Angela, I can move your AC tune-up to Friday at 10:00 AM. Does that work?”',
  };
}

/** A new support ticket, to HandsFreeOS's support people: it belongs to no business and opens the support desk. */
export const TICKET = '77777777-7777-4777-8777-777777777777';
export function supportTicket(overrides: Partial<PushData> = {}): PushData {
  return {
    v: 1,
    notificationId: '20000000-0000-4000-8000-000000000004',
    category: 'support_ticket',
    workspaceId: null,
    business: '',
    path: `/admin/tickets/${TICKET}`,
    sentAt: '2026-09-16T20:00:00.000Z',
    refs: { ticketId: TICKET },
    commandIds: {},
    collapseId: `ticket-${TICKET}`,
    title: 'New support ticket #1042',
    subtitle: 'Dana Reed · Reed Plumbing',
    body: 'Reminders stopped going out: “They went out on Monday and not since.”',
    ...overrides,
  };
}

/** A check-in's "Still at …?" at its planned end, to the person who checked in. */
export const CHECK_IN = '66666666-6666-4666-8666-666666666666';
export function safetyCheck(overrides: Partial<PushData> = {}): PushData {
  return {
    v: 1,
    notificationId: '20000000-0000-4000-8000-000000000005',
    category: 'safety_check',
    workspaceId: LONE_STAR,
    business: 'Lone Star HVAC & Roofing',
    path: `/app/w/${LONE_STAR}/safety`,
    sentAt: '2026-09-16T20:00:00.000Z',
    refs: { checkInId: CHECK_IN },
    commandIds: { im_ok: ids.im_ok, add_15: ids.add_15 },
    collapseId: `safety-${CHECK_IN}`,
    title: 'Still at 2207 Juniper Trail?',
    subtitle: 'Safety · Lone Star HVAC & Roofing',
    body: 'You planned to be done at 4:30 PM. If you don’t answer in 10 minutes, Marcus is told.',
    ...overrides,
  };
}

export const COMMAND_IDS = ids;

/** Someone signing in to the browser extension with the person's email (20261027002900): about no business. */
export const SIGN_IN = '77777777-7777-4777-8777-777777777777';
export function extensionSignIn(overrides: Partial<PushData> = {}): PushData {
  return {
    v: 1,
    notificationId: '20000000-0000-4000-8000-000000000009',
    category: 'extension_sign_in',
    workspaceId: null,
    business: '',
    path: `/app/extension-sign-in/${SIGN_IN}`,
    sentAt: '2026-10-13T20:00:00.000Z',
    refs: { signInId: SIGN_IN },
    commandIds: {},
    collapseId: `sign-in-${SIGN_IN}`,
    title: 'Signing in to the extension on Chrome?',
    body: 'Open to pick the number the extension shows. It ends in 2 minutes.',
    ...overrides,
  };
}
