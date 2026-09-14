/**
 * Reading a workflow approval's preview for the Assistant (as the web app's approvals/words.ts does): the note
 * the approval step shows, the AI-written texts the approver may edit (by the key the run keeps them under,
 * usually `message`), the channel they're for, and the customer.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ApprovalPreview {
  readonly note: string;
  readonly fields: readonly (readonly [string, string])[];
  readonly channel: 'sms' | 'email' | null;
  readonly customer: string | null;
}

export function approvalPreview(preview: unknown): ApprovalPreview {
  const p = isRecord(preview) ? preview : {};
  const fields = isRecord(p['fields'])
    ? Object.entries(p['fields']).flatMap(([k, v]) =>
        typeof v === 'string' ? [[k, v] as const] : [],
      )
    : [];
  return {
    note: typeof p['message'] === 'string' ? p['message'].trim() : '',
    fields,
    channel: p['channel'] === 'sms' || p['channel'] === 'email' ? p['channel'] : null,
    customer: typeof p['customer'] === 'string' && p['customer'] ? p['customer'] : null,
  };
}

/** What goes out once it's approved: "a text", "an email", or "the next step". */
export function approvalWhat(preview: unknown): 'a text' | 'an email' | 'the next step' {
  const p = approvalPreview(preview);
  if (p.fields.length && p.channel === 'sms') return 'a text';
  if (p.fields.length && p.channel === 'email') return 'an email';
  return 'the next step';
}
