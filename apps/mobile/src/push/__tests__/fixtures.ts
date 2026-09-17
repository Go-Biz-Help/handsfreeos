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

export const COMMAND_IDS = ids;
