-- =============================================================================
-- AI Social Media Content Creator: a switch to stop the calendar filling itself
-- (docs/socialcontent.md, "Making posts"; the owner, 11 Nov).
--
--        Fill on its own (`auto_fill`, on until someone turns it off): while
--        it's on, the AI writes posts for the open days in the plan over the
--        next two weeks and tops them up once a week (decision 18). Turned off,
--        a fill under way stops before its next post and no more are written
--        on their own; the posts already written stay, and Write a post still
--        works. Turned on again, it fills the open days right away.
--
--        Only adds a column, with a default, so the running code keeps working.
-- =============================================================================

alter table addon_socialcontent.settings
  add column auto_fill boolean not null default true;
