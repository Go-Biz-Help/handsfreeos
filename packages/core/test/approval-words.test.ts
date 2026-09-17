/**
 * Approvals' words (M10: moved from the web's `workflows/approvals/words.ts`), and a waiting workflow approval read
 * from a phone's copy.
 */
import { describe, expect, it } from 'vitest';
import {
  approvalCustomerOf,
  approvalDecidedLine,
  approvalExpiresIn,
  approvalPreviewOf,
  approvalTitle,
  approverNames,
  draftDecidedLine,
  relativeTimeAgo,
  workflowApprovalOfSynced,
} from '../src/workflows/approval-words';

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DALE = uid(900);
const PRIYA = uid(901);
const NOW = Date.parse('2026-09-15T15:00:00.000Z');

describe('approval words', () => {
  const preview = {
    message: 'Check the text before it goes.',
    fields: { message: 'Hi Maria, we can come Thursday.' },
    channel: 'sms',
    customer: 'Maria Lopez',
    asked: ' Can you come this week? ',
    items: [{ id: uid(1), kind: 'document', title: 'Prices' }, { bad: true }],
  };

  it('reads the preview', () => {
    expect(approvalPreviewOf({ preview })).toEqual({
      note: 'Check the text before it goes.',
      fields: [['message', 'Hi Maria, we can come Thursday.']],
      channel: 'sms',
      customer: 'Maria Lopez',
      asked: 'Can you come this week?',
      items: [{ id: uid(1), kind: 'document', title: 'Prices' }],
    });
  });

  it('titles and names', () => {
    const workflow = { id: uid(2), name: 'New lead follow-up' };
    expect(approvalTitle({ person: null, preview, workflow })).toBe(
      'An AI-written text for Maria Lopez',
    );
    expect(approvalTitle({ person: null, preview: {}, workflow })).toBe(
      'New lead follow-up is waiting for your OK',
    );
    expect(approvalCustomerOf({ person: null, preview: {} })).toBe('A customer');
    expect(
      approverNames([{ fullName: 'Priya Shah' }, { fullName: 'Dale Carter' }, { fullName: 'Sam' }]),
    ).toBe('Priya, Dale and Sam');
  });

  it('counts down and says what was decided', () => {
    expect(approvalExpiresIn(new Date(NOW + 118 * 60_000).toISOString(), NOW)).toBe(
      'Expires in 1 h 58 min',
    );
    expect(approvalExpiresIn(new Date(NOW - 1).toISOString(), NOW)).toBe('Expired');
    expect(
      approvalDecidedLine({
        status: 'approved',
        decidedBy: { id: PRIYA, fullName: 'Priya Shah' },
        edits: { message: 'x' },
        via: 'assistant',
        reason: null,
      }),
    ).toBe('Approved by Priya with an edit in the Assistant');
    expect(
      draftDecidedLine({
        status: 'approved',
        decidedBy: { fullName: 'Dale Carter' },
        edits: null,
        via: 'mobile',
        reason: null,
      }),
    ).toBe('Approved by Dale on the phone');
    expect(
      draftDecidedLine({
        status: 'cancelled',
        decidedBy: null,
        edits: null,
        via: null,
        reason: 'Customer wrote again.',
      }),
    ).toBe('Dropped: customer wrote again');
    expect(relativeTimeAgo(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12 min ago');
  });
});

describe('a waiting workflow approval from a phone’s copy', () => {
  const row = {
    id: uid(10),
    workflow_id: uid(11),
    run_id: uid(12),
    status: 'pending',
    approvers: JSON.stringify([PRIYA]),
    preview: JSON.stringify({ fields: { message: 'Hi' }, channel: 'sms' }),
    edits: null,
    expires_at: new Date(NOW + 60 * 60_000).toISOString(),
    created_at: new Date(NOW - 10 * 60_000).toISOString(),
  };
  const names = new Map([[PRIYA, 'Priya Shah']]);

  it('takes the workflow and the customer from its Action Center item', () => {
    const a = workflowApprovalOfSynced(row, {
      names,
      role: 'member',
      userId: PRIYA,
      now: NOW,
      item: { title: 'Maria Lopez · Workflow: New lead follow-up', personId: uid(21) },
    });
    expect(a).toMatchObject({
      workflow: { id: uid(11), name: 'New lead follow-up' },
      person: { id: uid(21), fullName: 'Maria Lopez' },
      approvers: [{ id: PRIYA, fullName: 'Priya Shah' }],
      canDecide: true,
    });
  });

  it('decides only for its approvers or whoever manages workflows, and not once expired', () => {
    const base = { names, now: NOW, item: null };
    expect(workflowApprovalOfSynced(row, { ...base, role: 'member', userId: DALE }).canDecide).toBe(
      false,
    );
    expect(workflowApprovalOfSynced(row, { ...base, role: 'owner', userId: DALE }).canDecide).toBe(
      true,
    );
    expect(
      workflowApprovalOfSynced(row, {
        ...base,
        role: 'owner',
        userId: DALE,
        now: NOW + 2 * 3_600_000,
      }).canDecide,
    ).toBe(false);
    expect(
      workflowApprovalOfSynced(row, { ...base, role: 'owner', userId: DALE }).workflow.name,
    ).toBe('A workflow');
  });
});
