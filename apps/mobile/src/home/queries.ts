/**
 * Home's and Approvals' SQL on the phone's copy: the Action Center items (open, snoozed and handled; cleared ones never
 * reach phones), the waiting approvals that say who may decide an approval item, people's names, the facts the cards'
 * hints read (seats, customers, conversations, opt-outs, the business's numbers and addresses), and this phone's own
 * changes to them.
 */

/**
 * Items for the list: what `attention.list` reads (today's handled ones are picked out on the phone), and dismissed ones,
 * so a change about one can still name it.
 */
export const ATTENTION_SQL = `
  SELECT * FROM attention_items
  WHERE workspace_id = ? AND state IN ('open', 'snoozed', 'handled', 'dismissed')`;

const LISTED = `SELECT %s FROM attention_items WHERE workspace_id = ? AND state IN ('open', 'snoozed', 'handled')`;
const listed = (column: string) => LISTED.replace('%s', column);

/** The waiting approvals: a workflow's approval steps and the AI teammate's drafts (only waiting ones sync). */
export const APPROVALS_SQL = `
  SELECT id, 'workflow' AS source, approvers, NULL AS kind, status FROM workflow_approvals WHERE workspace_id = ?
  UNION ALL
  SELECT id, 'teammate' AS source, NULL AS approvers, kind, status FROM ai_teammate_drafts WHERE workspace_id = ?`;

/** Everyone the phone knows, for the names on cards. */
export const USERS_SQL = `SELECT id, full_name, email FROM users`;

/** The business's team, for Assign. */
export const MEMBERS_SQL = `
  SELECT m.user_id AS id, u.full_name, u.email, m.role
  FROM workspace_memberships m
  LEFT JOIN users u ON u.id = m.user_id
  WHERE m.workspace_id = ?
  ORDER BY coalesce(nullif(u.full_name, ''), u.email)`;

/** The seats "Not confirmed" items are about, with their appointment's start and the customer's consent. */
export const SEATS_SQL = `
  SELECT t.id, t.appointment_id, a.starts_at, t.contact_phone_e164, t.contact_email, t.sms_ok, p.sms_consent
  FROM appointment_attendees t
  JOIN appointments a ON a.id = t.appointment_id
  JOIN people p ON p.id = t.person_id
  WHERE t.workspace_id = ? AND t.id IN (${listed('subject_id')} AND subject_type = 'attendee')`;

/** The customers the items are about. */
export const PEOPLE_SQL = `
  SELECT id, phone_e164, email, sms_consent FROM people
  WHERE workspace_id = ? AND id IN (${listed('person_id')} AND person_id IS NOT NULL)`;

/** The items' conversations, and their customers'. */
export const CONVERSATIONS_SQL = `
  SELECT id, person_id, channel, counterpart, last_message_at FROM conversations
  WHERE workspace_id = ?
    AND (id IN (${listed('conversation_id')} AND conversation_id IS NOT NULL)
      OR person_id IN (${listed('person_id')} AND person_id IS NOT NULL))`;

export const OPT_OUTS_SQL = `SELECT counterpart_e164, opted_out FROM opt_outs WHERE workspace_id = ? AND opted_out = 1`;
export const SUPPRESSIONS_SQL = `SELECT address FROM email_suppressions WHERE workspace_id = ?`;
export const NUMBERS_SQL = `SELECT status FROM phone_numbers WHERE workspace_id = ?`;
export const ADDRESSES_SQL = `SELECT email_domain_id, verified_at FROM email_addresses WHERE workspace_id = ?`;
export const WORKSPACE_SQL = `SELECT settings, timezone FROM workspaces WHERE id = ?`;

/** The commands Home's buttons make. */
export const HOME_COMMANDS = [
  'attention.snooze',
  'attention.dismiss',
  'attention.assign',
  'attention.let_handle',
  'attention.cancel_auto',
  'attention.restore',
] as const;

/** Home's changes on this phone: every one not through, and those sent in the last two hours. */
export const HOME_OUTBOX_SQL = `
  SELECT * FROM outbox
  WHERE workspace_id = ? AND name IN (${HOME_COMMANDS.map((c) => `'${c}'`).join(', ')})
    AND (state != 'sent' OR sent_at >= ?)
  ORDER BY seq`;

/** The workflow approvals decided on this phone: every one not through, and those sent in the last two hours. */
export const APPROVAL_OUTBOX_SQL = `
  SELECT * FROM outbox
  WHERE workspace_id = ? AND name = 'workflow.decide_approval' AND (state != 'sent' OR sent_at >= ?)
  ORDER BY seq`;

/** The waiting workflow approvals, with their Action Center item's title and customer (workflows don't sync). */
export const WORKFLOW_APPROVALS_SQL = `
  SELECT a.id, a.workflow_id, a.run_id, a.status, a.approvers, a.preview, a.edits, a.expires_at, a.created_at,
    i.title AS item_title, i.person_id AS item_person_id
  FROM workflow_approvals a
  LEFT JOIN attention_items i ON i.workspace_id = a.workspace_id AND i.kind = 'ai_approval'
    AND i.subject_id = a.id
  WHERE a.workspace_id = ? AND a.status = 'pending'
  ORDER BY a.created_at DESC, a.id DESC`;

/** The business's AI teammate. */
export const TEAMMATE_SQL = `
  SELECT id, name, status FROM ai_teammates WHERE workspace_id = ? AND archived_at IS NULL
  ORDER BY created_at LIMIT 1`;
