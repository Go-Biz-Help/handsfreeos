-- =============================================================================
-- A scheduled workflow pages through a workspace's customers by id
-- (`workflow.schedule`: `where workspace_id = … and archived_at is null and
-- id > <cursor> order by id limit 200`). people_workspace_idx sorts by name,
-- so every page re-read and re-sorted the whole workspace; this one walks
-- straight on from the cursor.
-- =============================================================================

create index if not exists people_workspace_id_page_idx
  on app.people (workspace_id, id) where archived_at is null;
