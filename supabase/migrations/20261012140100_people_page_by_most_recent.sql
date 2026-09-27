-- =============================================================================
-- People sorted by most recent page on (updated_at, id).
--
--        - `person.list` with sort 'recent' orders by (updated_at desc,
--          id desc) and keys its pages on the same pair. With no index on it,
--          every page, deep ones most of all, sorted the whole workspace.
--        - This index serves that order and the cursor directly. It costs
--          people updates their HOT path, since updated_at now sits in an
--          index; the business chose faster pages over that.
-- =============================================================================

create index if not exists people_workspace_updated_idx
  on app.people (workspace_id, updated_at desc, id desc);
