/**
 * The SQL the customer screens run against the phone's copy. Nothing is filtered, ordered or counted here that core
 * can do: these fetch the rows, and `@hfos/core`'s `crm/*` turns them into what the web's queries answer.
 */

const userName = (alias: string) => `coalesce(nullif(${alias}.full_name, ''), ${alias}.email)`;

/** Every person in the business, newest change last; the list orders them itself. */
export const PEOPLE_SQL = `
  SELECT p.*, ${userName('o')} AS owner_name
  FROM people p LEFT JOIN users o ON o.id = p.owner_user_id
  WHERE p.workspace_id = ?`;

export const PERSON_SQL = `
  SELECT p.*, ${userName('o')} AS owner_name
  FROM people p LEFT JOIN users o ON o.id = p.owner_user_id
  WHERE p.id = ?`;

export const COMPANIES_SQL = `
  SELECT c.*, ${userName('o')} AS owner_name
  FROM companies c LEFT JOIN users o ON o.id = c.owner_user_id
  WHERE c.workspace_id = ?`;

export const COMPANY_SQL = `
  SELECT c.*, ${userName('o')} AS owner_name
  FROM companies c LEFT JOIN users o ON o.id = c.owner_user_id
  WHERE c.id = ?`;

/** The people linked to a company. */
export const COMPANY_PEOPLE_SQL = `
  SELECT id, first_name, last_name, email, phone, archived_at FROM people
  WHERE company_id = ? ORDER BY lower(last_name), lower(first_name)`;

/** Every lead in the business, with the stage it is in. */
export const LEADS_SQL = `
  SELECT l.*, s.name AS stage_name, s.kind AS stage_kind, s.position AS stage_position,
         s.pipeline_id AS stage_pipeline_id
  FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id
  WHERE l.workspace_id = ?`;

/** One record's leads. */
export const RECORD_LEADS_SQL = `${LEADS_SQL} AND (l.person_id = ? OR l.company_id = ?)`;

/** Everyone who works here, by name: owners, assignees and whoever wrote a note. */
export const MEMBERS_SQL = `
  SELECT u.id, ${userName('u')} AS full_name FROM workspace_memberships wm
  JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ?
  UNION
  SELECT u.id, ${userName('u')} AS full_name FROM organization_memberships om
  JOIN workspaces w ON w.organization_id = om.organization_id
  JOIN users u ON u.id = om.user_id WHERE w.id = ?
  ORDER BY full_name`;

/** The business's tags, and which records wear them. */
export const TAGS_SQL = 'SELECT id, name, color FROM tags WHERE workspace_id = ? ORDER BY name';
export const RECORD_TAGS_SQL = `
  SELECT rt.record_id, t.id, t.name, t.color FROM record_tags rt
  JOIN tags t ON t.id = rt.tag_id
  WHERE rt.workspace_id = ? ORDER BY t.name`;

/** One record's timeline, newest first (the phone holds the last 12 months). */
export const TIMELINE_SQL = `
  SELECT a.*, ${userName('u')} AS author_name
  FROM activities a LEFT JOIN users u ON u.id = a.author_user_id
  WHERE a.workspace_id = ? AND `;
export const TIMELINE_FOR = (column: 'person_id' | 'company_id' | 'lead_id') =>
  `${TIMELINE_SQL} a.${column} = ? ORDER BY a.occurred_at DESC, a.id DESC`;

/** Every note in the business, for searching by a word someone wrote. */
export const NOTES_SQL = `
  SELECT id, person_id, company_id, lead_id, body FROM activities
  WHERE workspace_id = ? AND kind = 'note' AND body IS NOT NULL`;

/** One record's tasks. */
export const RECORD_TASKS_SQL = `
  SELECT * FROM tasks WHERE workspace_id = ? AND (person_id = ? OR company_id = ? OR lead_id = ?)`;

/** Every task in the business; the list groups and orders them with core's rules. */
export const TASKS_SQL = 'SELECT * FROM tasks WHERE workspace_id = ?';

/** One record's files, newest first. */
export const FILES_SQL = `
  SELECT * FROM files WHERE workspace_id = ? AND record_type = ? AND record_id = ?
    AND status = 'ready'
  ORDER BY created_at DESC`;

/** The next appointment on a customer, for the head ("Next: Fri, Sep 18 at 10:00 AM"). */
export const NEXT_APPOINTMENT_SQL = `
  SELECT ap.id, ap.title, ap.starts_at, ap.status
  FROM appointment_attendees aa JOIN appointments ap ON ap.id = aa.appointment_id
  WHERE aa.workspace_id = ? AND aa.person_id = ? AND aa.cancelled_at IS NULL
    AND ap.status NOT IN ('cancelled', 'completed', 'no_show') AND ap.starts_at >= ?
  ORDER BY ap.starts_at LIMIT 1`;

/** What a customer's live invoices still come to, worked out on the phone (a generated column never arrives). */
export const RECORD_INVOICES_SQL = `
  SELECT id, total_cents, amount_paid_cents, amount_refunded_cents FROM invoices
  WHERE workspace_id = ? AND person_id = ? AND status NOT IN ('draft', 'void')`;

/** The business: its time zone and settings. */
export const WORKSPACE_SQL = 'SELECT name, timezone, settings FROM workspaces WHERE id = ?';

/**
 * The record screens' changes on this phone, not through or sent just now: edits, notes, tags, tasks, stage moves and
 * photos. Screens show these over the synced rows, so a change made with no signal is visible where it was made.
 */
export const CRM_OUTBOX_SQL = `
  SELECT * FROM outbox
  WHERE workspace_id = ? AND (
      name LIKE 'person.%' OR name LIKE 'company.%' OR name LIKE 'lead.%' OR name LIKE 'task.%'
      OR name LIKE 'record.%' OR name = 'activity.log' OR name LIKE 'file.%')
    AND (state != 'sent' OR sent_at >= ?)
  ORDER BY seq`;

/** The photos this phone is still uploading, so a record's files show them before they land. */
export const PHOTOS_SQL = 'SELECT * FROM photo_uploads';

/** A customer's conversations, newest first: Text and Email on their page open the right one. */
export const PERSON_CONVERSATIONS_SQL = `
  SELECT id, channel, status, last_message_at FROM conversations
  WHERE workspace_id = ? AND person_id = ?
  ORDER BY last_message_at DESC`;
