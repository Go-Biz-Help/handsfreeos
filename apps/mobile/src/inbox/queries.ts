/**
 * The inbox's SQL on the phone's copy. Each joins in what the web's queries join (names, the open lead, the last
 * sender), so core's `conversationOf` and `threadItemsOf` can turn the rows into what the inbox's words take.
 */

const userName = (alias: string) => `coalesce(nullif(${alias}.full_name, ''), ${alias}.email)`;

/**
 * One business's conversations with everything the inbox's words need, before the archived rule.
 *
 * Split from the two below because they want opposite things from it: the list hides what has been put away,
 * and opening one by id must not — "bring it back any time" would be a poor promise if an archived thread
 * could not be opened to bring back.
 */
const CONVERSATION_BASE = `
  SELECT c.id, c.channel, c.counterpart, c.status, c.person_id, p.first_name, p.last_name,
    c.assignee_user_id, ${userName('au')} AS assignee_name,
    c.unread_count, c.last_message_at, c.last_preview, c.last_direction,
    ls.sent_by AS last_sender_id, ${userName('lu')} AS last_sender_name,
    c.awaiting_reply_since, c.snoozed_until, c.created_at, c.handled_by, c.ai_teammate_id, t.name AS teammate_name,
    c.needs_person_since, c.handoff_reason, c.handoff_note, c.taken_over_by, ${userName('tu')} AS taken_over_name,
    l.id AS lead_id, l.title AS lead_title, l.stage_id AS lead_stage_id, s.pipeline_id AS lead_pipeline_id,
    s.name AS lead_stage_name, l.value_cents AS lead_value_cents,
    l.next_action AS lead_next_action, l.next_action_at AS lead_next_action_at,
    EXISTS (SELECT 1 FROM ai_teammate_drafts d
            WHERE d.conversation_id = c.id AND d.status = 'pending' AND d.kind = 'reply') AS draft_waiting
  FROM conversations c
  LEFT JOIN people p ON p.id = c.person_id
  LEFT JOIN users au ON au.id = c.assignee_user_id
  LEFT JOIN ai_teammates t ON t.id = c.ai_teammate_id
  LEFT JOIN users tu ON tu.id = c.taken_over_by
  LEFT JOIN messages ls ON c.last_direction = 'outbound' AND ls.id = (
    SELECT m.id FROM messages m
    WHERE m.conversation_id = c.id AND m.direction = 'outbound'
    ORDER BY m.occurred_at DESC LIMIT 1)
  LEFT JOIN users lu ON lu.id = ls.sent_by
  LEFT JOIN leads l ON l.id = (
    SELECT l2.id FROM leads l2
    WHERE c.person_id IS NOT NULL AND l2.person_id = c.person_id AND l2.status = 'open' AND l2.archived_at IS NULL
    ORDER BY l2.updated_at DESC LIMIT 1)
  LEFT JOIN pipeline_stages s ON s.id = l.stage_id
  WHERE c.workspace_id = ?`;

/**
 * A business's conversations, each with its customer, assignee, teammate, open lead and last sender.
 *
 * **Archived ones are not here**, the same way `inbox.list` leaves them out
 * (`packages/core/src/queries/inbox.ts`, `and c.archived_at is null`). The phone could not do this until
 * `archived_at` reached it, so a thread put away on the web stayed in the inbox on the phone — for good,
 * since nothing else ever takes it out. The phone has no archived box to show them in; when it gets one,
 * this is where the other half goes.
 */
export const CONVERSATIONS_SQL = `${CONVERSATION_BASE} AND c.archived_at IS NULL`;

/** One conversation, archived or not: this is how an archived one is opened to be brought back. */
export const CONVERSATION_SQL = `${CONVERSATION_BASE} AND c.id = ?`;

/** A conversation's messages from the last 12 months on the phone, with who sent and approved them. */
export const MESSAGES_SQL = `
  SELECT m.id, m.conversation_id, m.channel, m.direction, m.status, m.from_address, m.to_addresses, m.cc_addresses,
    m.subject, m.body_text, m.media, m.error_code, m.error_message, m.sent_by, ${userName('su')} AS sent_by_name,
    m.sent_by_teammate_id, t.name AS teammate_name, m.approved_by, ${userName('ab')} AS approved_name,
    m.client_id, m.occurred_at, m.delivered_at
  FROM messages m
  LEFT JOIN users su ON su.id = m.sent_by
  LEFT JOIN ai_teammates t ON t.id = m.sent_by_teammate_id
  LEFT JOIN users ab ON ab.id = m.approved_by
  WHERE m.workspace_id = ? AND m.conversation_id = ?
  ORDER BY m.occurred_at`;

/** A conversation's calls, with who placed and answered them. */
export const CALLS_SQL = `
  SELECT k.id, k.conversation_id, k.direction, k.from_e164, k.to_e164, k.status, k.answered_via,
    k.answered_by_user_id, ${userName('au')} AS answered_name, k.placed_by, ${userName('pu')} AS placed_name,
    k.started_at, k.answered_at, k.ended_at, k.duration_seconds, k.is_voicemail, k.recording_seconds, k.transcript
  FROM calls k
  LEFT JOIN users au ON au.id = k.answered_by_user_id
  LEFT JOIN users pu ON pu.id = k.placed_by
  WHERE k.workspace_id = ? AND k.conversation_id = ?
  ORDER BY k.started_at`;

/**
 * The call log: every call this business made or took, newest first, whatever conversation it belongs to.
 *
 * The thread shows a call where it happened, which is right while reading one conversation and no use at all
 * when somebody has just missed a call and wants to hear what was left. `CALLS_SQL` above is the other one:
 * one conversation's calls, oldest first, for the thread.
 */
export const CALL_LOG_SQL = `
  SELECT k.id, k.conversation_id, k.person_id, p.first_name, p.last_name,
    CASE WHEN k.direction = 'inbound' THEN k.from_e164 ELSE k.to_e164 END AS counterpart,
    k.direction, k.from_e164, k.to_e164, k.status, k.answered_via, k.answered_by_user_id,
    ${userName('au')} AS answered_name, k.placed_by, ${userName('pu')} AS placed_name,
    k.started_at, k.answered_at, k.ended_at, k.duration_seconds, k.is_voicemail, k.recording_seconds,
    k.transcript, k.transcript_status
  FROM calls k
  LEFT JOIN people p ON p.id = k.person_id
  LEFT JOIN users au ON au.id = k.answered_by_user_id
  LEFT JOIN users pu ON pu.id = k.placed_by
  WHERE k.workspace_id = ?
  ORDER BY k.started_at DESC
  LIMIT 200`;

/** The customer beside a conversation: contact details, texting consent, when they became a customer. */
export const PERSON_SQL = `
  SELECT id, first_name, last_name, phone, phone_e164, email, sms_consent, archived_at, created_at,
    address_line1, city, state, postal_code, notes
  FROM people WHERE id = ?`;

/** Whether a number opted out of texts from the business. */
export const OPTED_OUT_SQL = `
  SELECT opted_out FROM opt_outs WHERE workspace_id = ? AND counterpart_e164 = ?
  ORDER BY updated_at DESC LIMIT 1`;

/** Everyone a conversation can be assigned to: the business's members, and its organization's (agency staff). */
export const MEMBERS_SQL = `
  SELECT u.id, ${userName('u')} AS full_name FROM workspace_memberships wm
  JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ?
  UNION
  SELECT u.id, ${userName('u')} AS full_name FROM organization_memberships om
  JOIN workspaces w ON w.organization_id = om.organization_id
  JOIN users u ON u.id = om.user_id WHERE w.id = ?
  ORDER BY full_name`;

/** The business's AI teammate, when it has one. */
export const TEAMMATE_SQL = `
  SELECT id, name, status FROM ai_teammates WHERE workspace_id = ? AND archived_at IS NULL
  ORDER BY created_at LIMIT 1`;

/** The business: its time zone and settings (quiet hours, the reminder threshold). */
export const WORKSPACE_SQL = 'SELECT name, timezone, settings FROM workspaces WHERE id = ?';

/** The inbox's changes on this phone: replies, and changes to conversations, not through or sent just now. */
export const INBOX_OUTBOX_SQL = `
  SELECT * FROM outbox
  WHERE workspace_id = ? AND (name = 'message.send' OR name = 'message.cancel_scheduled' OR name LIKE 'conversation.%')
    AND (state != 'sent' OR sent_at >= ?)
  ORDER BY seq`;

/** The notes the business wrote about a customer (the last 12 months on the phone), with who wrote them. */
export const NOTES_SQL = `
  SELECT a.id, a.body, a.occurred_at, a.created_at, ${userName('u')} AS author_name
  FROM activities a
  LEFT JOIN users u ON u.id = a.author_user_id
  WHERE a.workspace_id = ? AND a.person_id = ? AND a.kind = 'note'
  ORDER BY a.occurred_at`;
