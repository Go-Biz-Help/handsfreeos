/** The SQL the Pipeline tab and a lead's page run against the phone's copy. */

export const PIPELINES_SQL = `
  SELECT id, name, position FROM pipelines
  WHERE workspace_id = ? AND archived_at IS NULL
  ORDER BY position, created_at`;

export const STAGES_SQL = `
  SELECT id, pipeline_id, name, kind, position FROM pipeline_stages
  WHERE workspace_id = ? ORDER BY position`;

/** Every open lead of one pipeline, with its stage; the board's order is position then when it was made. */
export const PIPELINE_LEADS_SQL = `
  SELECT l.*, s.name AS stage_name, s.kind AS stage_kind, s.position AS stage_position,
         s.pipeline_id AS stage_pipeline_id
  FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id
  WHERE l.workspace_id = ? AND l.pipeline_id = ? AND l.archived_at IS NULL
  ORDER BY l.position, l.created_at`;

export const LEAD_SQL = `
  SELECT l.*, s.name AS stage_name, s.kind AS stage_kind, s.position AS stage_position,
         s.pipeline_id AS stage_pipeline_id
  FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id
  WHERE l.id = ?`;

/** A lead's own timeline, newest first. */
export const LEAD_TIMELINE_SQL = `
  SELECT a.*, coalesce(nullif(u.full_name, ''), u.email) AS author_name
  FROM activities a LEFT JOIN users u ON u.id = a.author_user_id
  WHERE a.workspace_id = ? AND a.lead_id = ?
  ORDER BY a.occurred_at DESC, a.id DESC`;

/** The next thing due on a lead, and the tasks on it. */
export const LEAD_TASKS_SQL = 'SELECT * FROM tasks WHERE workspace_id = ? AND lead_id = ?';

/** A lead's files. */
export const LEAD_FILES_SQL = `
  SELECT * FROM files WHERE workspace_id = ? AND record_type = 'lead' AND record_id = ?
    AND status = 'ready' ORDER BY created_at DESC`;
