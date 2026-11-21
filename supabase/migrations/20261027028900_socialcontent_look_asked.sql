-- =============================================================================
-- AI Social Media Content Creator: whether a person pressed Check if it posted
-- (the owner, 18 Nov 2026; docs/socialcontent.md, "Posting").
--
--        Facebook draws a Page's posts only once they're on screen, and none
--        past its newest in the extension's window while it's behind the
--        person's. A look the extension starts on its own (10 minutes after a
--        post that may have gone up) brings that window in front only while
--        the person is away from their computer (docs/outreach.md, decision
--        120); one a person asked for comes in front right away, as a Check
--        does, as they pressed it to see. `look_asked` says which: true when
--        Check if it posted (or Check again) set `look_due_at`, false when the
--        post failing did, and false again once it's looked.
-- =============================================================================

alter table addon_socialcontent.content
  add column look_asked boolean not null default false;
