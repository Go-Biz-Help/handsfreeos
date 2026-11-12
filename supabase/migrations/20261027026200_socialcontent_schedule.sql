-- =============================================================================
-- AI Social Media Content Creator: who set a post's time
-- (docs/socialcontent.md, "The schedule"; decisions 21 to 27, the owner, 12 Nov).
--
--        AI picks learns the best hours from the creators' posts and then the
--        business's own, and moves its posts that haven't gone up to them, OK'd
--        ones too (decision 27). A time a person set is theirs and never moves:
--        `placed_by` says which. Posts a person made start as theirs.
--
--        Only adds a column, with a default, so the running code keeps working.
-- =============================================================================

alter table addon_socialcontent.content
  add column placed_by text not null default 'ai'
    check (placed_by in ('ai', 'person'));

update addon_socialcontent.content set placed_by = 'person' where made_by = 'person';
